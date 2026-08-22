import { type ChildProcess, spawn } from 'node:child_process'
import * as vscode from 'vscode'
import {
  coerceArgList,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  expandWorkspaceFolder,
  formatCommandLine,
  mergeExtraEnv,
  resolveHandshakeTimeoutMs,
  resolveSpawnCommand,
  runtimeSpawnOptions,
  sanitizeSpawnEnv,
  terminateChild,
} from './launch'
import { JsonRpcLinePeer, RuntimeUnavailableError, type HarnessNotification } from './jsonrpc'

/** Lifecycle state of the managed runtime process. */
type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'

/** Current runtime status; `message` explains a stop or failure. */
export interface RuntimeStatus {
  state: RuntimeState
  message?: string
}

/** One session's notification stream, in wire order. */
export interface SessionSubscription {
  /** Await the next notification for this session; rejects when the runtime is gone. */
  next: () => Promise<HarnessNotification>
  /** Stop delivery and drop anything still queued. */
  close: () => void
}

const STOP_GRACE_MS = 2_000
const CANCEL_TIMEOUT_MS = 5_000
const RESTART_SETTLE_MS = 300

interface Subscriber {
  sessionId: string
  queue: HarnessNotification[]
  waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  failure: Error | undefined
}

/**
 * Owns the harness runtime process the extension drives: it spawns
 * `dsh --profile editor` (or whatever the settings name), performs the SDK
 * `initialize` handshake, correlates requests, fans notifications out per
 * session, and mirrors the runtime's stderr into an OutputChannel.
 *
 * Readiness is the handshake, not a log line: the runtime is usable exactly
 * when `initialize` answers, which also proves its plugin tree settled.
 */
export class HarnessRuntime implements vscode.Disposable {
  private child: ChildProcess | undefined
  private peer: JsonRpcLinePeer | undefined
  private startTask: Promise<void> | undefined
  private currentStatus: RuntimeStatus = { state: 'stopped' }
  private readonly subscribers = new Set<Subscriber>()
  private readonly output: vscode.OutputChannel
  private readonly statusEmitter = new vscode.EventEmitter<RuntimeStatus>()

  /** Fires whenever the runtime status changes. */
  readonly onDidChangeStatus = this.statusEmitter.event

  constructor() {
    this.output = vscode.window.createOutputChannel('DeepSeek Harness')
  }

  /** The latest observed runtime status. */
  get status(): RuntimeStatus {
    return this.currentStatus
  }

  /** Reveal the runtime log channel. */
  showLogs(): void {
    this.output.show(true)
  }

  /**
   * Ensure a runtime that has completed the handshake, starting one if needed.
   * Concurrent callers share one start.
   * @returns settlement of the handshake.
   */
  ensureStarted(): Promise<void> {
    if (this.currentStatus.state === 'ready' && this.peer !== undefined) return Promise.resolve()
    this.startTask ??= this.start().finally(() => { this.startTask = undefined })
    return this.startTask
  }

  /**
   * Queue one prompt on a session, creating it in the runtime when new.
   * @param sessionId - the session to prompt.
   * @param contentBlocks - the user message content blocks.
   * @returns the queued message id.
   */
  async prompt(sessionId: string, contentBlocks: readonly object[]): Promise<string> {
    const result = await this.requirePeer().request('session/prompt', { sessionId, contentBlocks })
    const messageId = isRecord(result) ? result.messageId : undefined
    if (typeof messageId !== 'string') {
      throw new Error(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return messageId
  }

  /**
   * Cancel a session's live turn and drop its pending input.
   * @param sessionId - the session to interrupt.
   * @returns whether the runtime held a live agent to cancel.
   */
  async cancel(sessionId: string): Promise<boolean> {
    const result = await this.requirePeer().request('session/cancel', { sessionId }, CANCEL_TIMEOUT_MS)
    return isRecord(result) && result.cancelled === true
  }

  /**
   * Subscribe to one session's notifications, including the subagent lifecycle
   * edges that name it as parent.
   * @param sessionId - the session to follow.
   * @returns the subscription; close it when the turn ends.
   */
  subscribe(sessionId: string): SessionSubscription {
    const subscriber: Subscriber = { sessionId, queue: [], waiters: [], failure: undefined }
    this.subscribers.add(subscriber)
    return {
      next: () => {
        const queued = subscriber.queue.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        if (subscriber.failure !== undefined) return Promise.reject(subscriber.failure)
        return new Promise<HarnessNotification>((resolve, reject) => {
          subscriber.waiters.push({ resolve, reject })
        })
      },
      close: () => {
        this.subscribers.delete(subscriber)
        subscriber.queue.length = 0
        failSubscriber(subscriber, new RuntimeUnavailableError('subscription closed'))
      },
    }
  }

  /** Terminate the runtime process if running and mark the manager stopped. */
  stop(): void {
    const child = this.child
    this.child = undefined
    this.startTask = undefined
    this.peer?.close(new RuntimeUnavailableError('the DeepSeek Harness runtime was stopped'))
    this.peer = undefined
    this.failSubscribers(new RuntimeUnavailableError('the DeepSeek Harness runtime was stopped'))
    if (child !== undefined) terminateChild(child, STOP_GRACE_MS)
    this.setStatus({ state: 'stopped' })
  }

  /**
   * Stop the current runtime and start a fresh one.
   * @returns settlement of the new handshake.
   */
  async restart(): Promise<void> {
    this.stop()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RESTART_SETTLE_MS)
      timer.unref()
    })
    return this.ensureStarted()
  }

  dispose(): void {
    this.stop()
    this.statusEmitter.dispose()
    this.output.dispose()
  }

  private requirePeer(): JsonRpcLinePeer {
    const peer = this.peer
    if (peer === undefined) throw new RuntimeUnavailableError('the DeepSeek Harness runtime is not running')
    return peer
  }

  private setStatus(status: RuntimeStatus): void {
    this.currentStatus = status
    this.statusEmitter.fire(status)
  }

  private async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration('dsh')
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const command = expandWorkspaceFolder(config.get<string>('runtime.command', 'dsh').trim(), folder)
    const argv = coerceArgList(config.get('runtime.args'), ['--profile', 'editor'])
      .map(token => expandWorkspaceFolder(token, folder))
    const cwd = resolveCwd(expandWorkspaceFolder(config.get<string>('runtime.cwd', ''), folder))
    const env = sanitizeSpawnEnv(process.env, mergeExtraEnv(config.get('runtime.env')))
    const timeoutMs = resolveHandshakeTimeoutMs(
      config.get('runtime.handshakeTimeoutMs', DEFAULT_HANDSHAKE_TIMEOUT_MS),
    )
    const resolved = resolveSpawnCommand(command)

    this.setStatus({ state: 'starting' })
    this.output.appendLine(`[dsh] launching: ${formatCommandLine(resolved.file, argv)}`)
    if (cwd !== undefined) this.output.appendLine(`[dsh] cwd: ${cwd}`)
    if (resolved.file !== command) this.output.appendLine(`[dsh] resolved executable: ${resolved.file}`)

    let child: ChildProcess
    try {
      child = spawn(resolved.file, argv, runtimeSpawnOptions(cwd, env, resolved.shell))
    } catch (error) {
      throw this.failStart(error)
    }
    this.child = child
    const peer = new JsonRpcLinePeer({
      write: (line) => { child.stdin?.write(line) },
      onNotification: (notification) => { this.deliver(notification) },
    })
    this.peer = peer

    // Writes racing the runtime's death EPIPE on stdin; the exit edge below is
    // the authoritative signal, so the stream error only needs to be non-fatal.
    child.stdin?.on('error', () => {})
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { peer.receive(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.appendLines(chunk) })
    child.on('error', (error) => {
      this.output.appendLine(`[dsh] spawn error: ${error.message}`)
      this.abandon(child, new RuntimeUnavailableError(`the DeepSeek Harness runtime failed to start: ${error.message}`))
    })
    child.on('exit', (code, exitSignal) => {
      this.output.appendLine(`[dsh] exited (code=${String(code)} signal=${String(exitSignal)})`)
      this.abandon(child, new RuntimeUnavailableError(
        `the DeepSeek Harness runtime exited (code ${String(code)} signal ${String(exitSignal)})`,
      ))
    })

    try {
      const result = await peer.request('initialize', {
        cwd: cwd ?? process.cwd(),
        provider: config.get<string>('model.provider', 'deepseek-official').trim(),
        model: config.get<string>('model.name', 'deepseek-v4-flash').trim(),
      }, timeoutMs)
      const version = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo.version : undefined
      this.output.appendLine(`[dsh] runtime ready${typeof version === 'string' ? ` (protocol ${version})` : ''}`)
    } catch (error) {
      throw this.failStart(error)
    }
    this.setStatus({ state: 'ready' })
  }

  private failStart(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    this.output.appendLine(`[dsh] ${message}`)
    const child = this.child
    this.child = undefined
    this.peer = undefined
    if (child !== undefined) terminateChild(child, STOP_GRACE_MS)
    this.setStatus({ state: 'error', message })
    return error instanceof Error ? error : new Error(message)
  }

  /** Drop a dead child: fail its pending requests and subscriptions exactly once. */
  private abandon(child: ChildProcess, error: Error): void {
    if (this.child !== child) return
    this.child = undefined
    this.peer?.close(error)
    this.peer = undefined
    this.failSubscribers(error)
    if (this.currentStatus.state === 'ready') this.setStatus({ state: 'stopped', message: error.message })
  }

  private deliver(notification: HarnessNotification): void {
    for (const subscriber of this.subscribers) {
      if (!belongsToSession(notification, subscriber.sessionId)) continue
      const waiter = subscriber.waiters.shift()
      if (waiter !== undefined) waiter.resolve(notification)
      else subscriber.queue.push(notification)
    }
  }

  private failSubscribers(error: Error): void {
    for (const subscriber of this.subscribers) failSubscriber(subscriber, error)
  }

  private appendLines(text: string): void {
    for (const line of text.split(/\r?\n/u)) {
      if (line.length > 0) this.output.appendLine(line)
    }
  }
}

/**
 * Whether a notification concerns one session: its own events and status, plus
 * the subagent edges that name it as the delegating parent.
 * @param notification - the wire notification.
 * @param sessionId - the session being followed.
 * @returns `true` when the subscriber for `sessionId` should see it.
 */
function belongsToSession(notification: HarnessNotification, sessionId: string): boolean {
  const params = notification.params
  return params.sessionId === sessionId || params.parentSessionId === sessionId
}

function failSubscriber(subscriber: Subscriber, error: Error): void {
  subscriber.failure ??= error
  for (const waiter of subscriber.waiters.splice(0)) waiter.reject(subscriber.failure)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the runtime working directory: explicit config, else first workspace folder. */
function resolveCwd(configured: string): string | undefined {
  const trimmed = configured.trim()
  if (trimmed.length > 0) return trimmed
  const folders = vscode.workspace.workspaceFolders
  return folders !== undefined && folders.length > 0 ? folders[0].uri.fsPath : undefined
}
