/**
 * Newline-delimited JSON-RPC 2.0 peer for the DeepSeek Harness runtime, with
 * no `vscode` or `node:child_process` dependency: the caller owns the process
 * and pipes it into {@link JsonRpcLinePeer.receive} / `write`.
 *
 * The method names and payloads mirror `@deepseek-ai/dsh-sdk-protocol`. They
 * are restated here rather than imported because this extension ships as a
 * standalone bundle with `vscode` as its only external, exactly as the Python
 * SDK mirrors the same wire without importing it.
 */

/** One server-to-client notification frame. */
export interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

/** A JSON-RPC error response from the runtime. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code.
   * @param message - the wire error message.
   */
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/** A request exceeded its timeout, or the peer closed before the answer arrived. */
export class RuntimeUnavailableError extends Error {
  /** @param message - what was pending and why it cannot be answered. */
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeUnavailableError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  method: string
}

/** Sinks the peer needs from its owner. */
export interface JsonRpcLinePeerHooks {
  /** Write one complete frame line, including its trailing newline. */
  write: (line: string) => void
  /** Receive one notification frame in wire order. */
  onNotification: (notification: HarnessNotification) => void
}

/**
 * Request/response correlation and notification fan-out over a line protocol.
 * Malformed lines are ignored: a runtime that prints a non-frame line to
 * stdout must not break the pending requests around it.
 */
export class JsonRpcLinePeer {
  private buffer = ''
  private serial = 0
  private readonly pending = new Map<number, Pending>()
  private closed: Error | undefined

  /** @param hooks - the frame writer and notification sink. */
  constructor(private readonly hooks: JsonRpcLinePeerHooks) {}

  /**
   * Send one request and await its result.
   * @param method - the JSON-RPC method name.
   * @param params - the params object.
   * @param timeoutMs - reject after this long; omitted waits indefinitely.
   * @returns the result value; rejects with {@link JsonRpcResponseError} on an
   * error response and {@link RuntimeUnavailableError} on timeout or close.
   */
  request(method: string, params: object, timeoutMs?: number): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    const id = ++this.serial
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id)
          reject(new RuntimeUnavailableError(`${method} timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      this.hooks.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /**
   * Feed decoded stdout text; complete lines are parsed as frames.
   * @param text - a stdout chunk, split across lines at any offset.
   */
  receive(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /**
   * Reject every pending request and refuse later ones. Idempotent; the first
   * failure wins.
   * @param error - the terminal failure delivered to callers.
   */
  close(error: Error): void {
    this.closed ??= error
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(this.closed)
    }
  }

  private dispatch(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      // Not a frame: a runtime that pollutes stdout must not break requests.
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    if (typeof record.method === 'string' && record.id === undefined) {
      const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
        ? record.params as Record<string, unknown>
        : {}
      this.hooks.onNotification({ method: record.method, params })
      return
    }
    if (typeof record.id !== 'number') return
    const pending = this.pending.get(record.id)
    if (pending === undefined) return
    this.pending.delete(record.id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const error = record.error
    if (typeof error === 'object' && error !== null) {
      const failure = error as { code?: unknown; message?: unknown }
      pending.reject(new JsonRpcResponseError(
        typeof failure.code === 'number' ? failure.code : -32_603,
        typeof failure.message === 'string' ? failure.message : `${pending.method} failed`,
      ))
      return
    }
    pending.resolve(record.result)
  }
}
