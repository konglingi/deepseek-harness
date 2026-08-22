import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import * as vscode from 'vscode'
import {
  backendSpawnOptions,
  buildBackendArgs,
  coerceArgList,
  DEFAULT_READY_TIMEOUT_MS,
  expandWorkspaceFolder,
  mergeExtraEnv,
  resolveReadyTimeoutMs,
  resolveSpawnCommand,
  sanitizeSpawnEnv,
  terminateChild,
  waitForBackendReady,
} from './launch'

/** Lifecycle state of the managed backend process. */
type BackendState = 'stopped' | 'starting' | 'ready' | 'error'

/** Current backend status; `url` is set only in the `ready` state. */
export interface BackendStatus {
  state: BackendState
  url?: string
  message?: string
}

const STOP_GRACE_MS = 2000

/**
 * Owns the lifecycle of the `dsh web` backend the extension embeds. It spawns
 * the process, treats stdout's `dsh web:` URL or loopback HTTP as readiness,
 * mirrors output into an OutputChannel, and exposes start/stop/restart with a
 * single in-flight start.
 */
export class BackendManager implements vscode.Disposable {
  private child: ChildProcess | undefined
  private startPromise: Promise<string> | undefined
  private startAbort: AbortController | undefined
  private currentStatus: BackendStatus = { state: 'stopped' }
  private readonly output: vscode.OutputChannel
  private readonly statusEmitter = new vscode.EventEmitter<BackendStatus>()

  /** Fires whenever the backend status changes. */
  readonly onDidChangeStatus = this.statusEmitter.event

  constructor() {
    this.output = vscode.window.createOutputChannel('DeepSeek Harness')
  }

  /** The latest observed backend status. */
  get status(): BackendStatus {
    return this.currentStatus
  }

  /** Reveal the backend log channel. */
  showLogs(): void {
    this.output.show(true)
  }

  /**
   * Ensure a ready backend, starting one if needed.
   *
   * @returns The backend base URL once stdout or HTTP reports readiness.
   */
  ensureStarted(): Promise<string> {
    if (this.currentStatus.state === 'ready' && this.currentStatus.url !== undefined) {
      return Promise.resolve(this.currentStatus.url)
    }
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private setStatus(status: BackendStatus): void {
    this.currentStatus = status
    this.statusEmitter.fire(status)
  }

  private async start(): Promise<string> {
    const config = vscode.workspace.getConfiguration('dsh')
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const command = expandWorkspaceFolder(
      config.get<string>('backend.command', 'dsh').trim(),
      folder,
    )
    const args = coerceArgList(config.get('backend.args'), ['web'])
      .map(token => expandWorkspaceFolder(token, folder))
    const configuredPort = config.get<number>('backend.port', 0)
    const port = configuredPort > 0 ? configuredPort : await findFreePort()
    const argv = buildBackendArgs(args, port)
    const cwd = resolveCwd(expandWorkspaceFolder(config.get<string>('backend.cwd', ''), folder))
    const extraEnv = mergeExtraEnv(config.get('backend.env'))
    const timeoutMs = resolveReadyTimeoutMs(config.get('backend.readyTimeoutMs', DEFAULT_READY_TIMEOUT_MS))
    const resolved = resolveSpawnCommand(command)
    const env = sanitizeSpawnEnv(process.env, extraEnv)
    const url = `http://127.0.0.1:${String(port)}`

    this.setStatus({ state: 'starting' })
    this.output.appendLine(`[dsh] launching: ${resolved.file} ${argv.join(' ')}`)
    if (cwd !== undefined) this.output.appendLine(`[dsh] cwd: ${cwd}`)
    if (resolved.file !== command) this.output.appendLine(`[dsh] resolved executable: ${resolved.file}`)

    const abort = new AbortController()
    this.startAbort = abort

    let child: ChildProcess
    try {
      child = spawn(resolved.file, argv, backendSpawnOptions(cwd, env, resolved.shell))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[dsh] failed to spawn: ${message}`)
      this.setStatus({ state: 'error', message })
      throw error instanceof Error ? error : new Error(message)
    }
    this.child = child
    const appendOutput = (buffer: Buffer | string): void => {
      const text = typeof buffer === 'string' ? buffer : buffer.toString('utf8')
      for (const line of text.split(/\r?\n/u)) {
        if (line.length > 0) this.output.appendLine(line)
      }
    }
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    child.on('exit', (code, exitSignal) => {
      this.output.appendLine(`[dsh] exited (code=${String(code)} signal=${String(exitSignal)})`)
      if (this.child === child) this.child = undefined
      if (this.currentStatus.state === 'ready') {
        this.setStatus({ state: 'stopped', message: `backend exited (code ${String(code)})` })
      }
    })

    try {
      const readyUrl = await waitForBackendReady({
        child,
        url,
        timeoutMs,
        signal: abort.signal,
      })
      this.setStatus({ state: 'ready', url: readyUrl })
      return readyUrl
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[dsh] ${message}`)
      if (this.currentStatus.state === 'stopped') throw error instanceof Error ? error : new Error(message)
      this.setStatus({ state: 'error', message })
      throw error instanceof Error ? error : new Error(message)
    }
  }

  /** Terminate the backend process if running and mark the manager stopped. */
  stop(): void {
    this.startAbort?.abort()
    this.startAbort = undefined
    const child = this.child
    this.child = undefined
    this.startPromise = undefined
    if (child !== undefined) terminateChild(child, STOP_GRACE_MS)
    this.setStatus({ state: 'stopped' })
  }

  /** Stop the current backend and start a fresh one. */
  async restart(): Promise<string> {
    this.stop()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 300)
      timer.unref()
    })
    return this.ensureStarted()
  }

  dispose(): void {
    this.stop()
    this.statusEmitter.dispose()
    this.output.dispose()
  }
}

/** Ask the OS for an unused TCP port on the loopback interface. */
function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address !== null && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('could not determine a free port')))
      }
    })
  })
}

/** Resolve the backend working directory: explicit config, else first workspace folder. */
function resolveCwd(configured: string): string | undefined {
  const trimmed = configured.trim()
  if (trimmed.length > 0) return trimmed
  const folders = vscode.workspace.workspaceFolders
  return folders !== undefined && folders.length > 0 ? folders[0].uri.fsPath : undefined
}
