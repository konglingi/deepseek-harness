import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import * as vscode from 'vscode'

/** Lifecycle state of the managed backend process. */
type BackendState = 'stopped' | 'starting' | 'ready' | 'error'

/** Current backend status; `url` is set only in the `ready` state. */
export interface BackendStatus {
  state: BackendState
  url?: string
  message?: string
}

// `dsh web` announces its bound address on stdout as `dsh web: http://127.0.0.1:<port>`.
const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/i
const STOP_GRACE_MS = 2000

/**
 * Owns the lifecycle of the `dsh web` backend the extension embeds. It spawns
 * the process, watches stdout for the readiness URL, mirrors output into an
 * OutputChannel, and exposes start/stop/restart with a single in-flight start.
 */
export class BackendManager implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined
  private startPromise: Promise<string> | undefined
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
   * @returns The backend base URL once stdout reports readiness.
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
    const command = config.get<string>('backend.command', 'dsh')
    const args = [...config.get<string[]>('backend.args', ['web'])]
    const configuredPort = config.get<number>('backend.port', 0)
    const port = configuredPort > 0 ? configuredPort : await findFreePort()
    if (!args.includes('--port')) args.push('--port', String(port))
    if (!args.includes('--host')) args.push('--host', '127.0.0.1')
    const cwd = resolveCwd(config.get<string>('backend.cwd', ''))
    const extraEnv = config.get<Record<string, string>>('backend.env', {})

    this.setStatus({ state: 'starting' })
    this.output.appendLine(`[dsh] launching: ${command} ${args.join(' ')}`)
    if (cwd !== undefined) this.output.appendLine(`[dsh] cwd: ${cwd}`)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[dsh] failed to spawn: ${message}`)
      this.setStatus({ state: 'error', message })
      throw error instanceof Error ? error : new Error(message)
    }
    this.child = child

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const finishReady = (url: string): void => {
        settled = true
        this.setStatus({ state: 'ready', url })
        resolve(url)
      }
      const finishError = (message: string): void => {
        settled = true
        this.setStatus({ state: 'error', message })
        reject(new Error(message))
      }

      const onData = (buffer: Buffer): void => {
        const text = buffer.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) this.output.appendLine(line)
        }
        if (!settled) {
          const match = READY_PATTERN.exec(text)
          if (match !== null) finishReady(match[1])
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)

      child.on('error', (error) => {
        this.output.appendLine(`[dsh] process error: ${error.message}`)
        if (!settled) finishError(error.message)
      })
      child.on('exit', (code, signal) => {
        this.output.appendLine(`[dsh] exited (code=${String(code)} signal=${String(signal)})`)
        if (this.child === child) this.child = undefined
        if (settled) {
          // A ready backend went away: reflect it so the UI can offer a restart.
          if (this.currentStatus.state === 'ready') {
            this.setStatus({ state: 'stopped', message: `backend exited (code ${String(code)})` })
          }
          return
        }
        finishError(`backend exited before reporting readiness (code ${String(code)})`)
      })
    })
  }

  /** Terminate the backend process if running and mark the manager stopped. */
  stop(): void {
    const child = this.child
    this.child = undefined
    this.startPromise = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, STOP_GRACE_MS)
      timer.unref()
    }
    this.setStatus({ state: 'stopped' })
  }

  /** Stop the current backend and start a fresh one. */
  async restart(): Promise<string> {
    this.stop()
    // Give the OS a moment to release the previous port before rebinding.
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
