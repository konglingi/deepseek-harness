/**
 * Session identity for the chat participant. VS Code's request API carries no
 * conversation id in the extension's minimum version, so a chat with no
 * history is a new conversation and mints a new harness session; every later
 * request in that chat reuses it, which is what makes the runtime keep the
 * turn history.
 */

/**
 * Mint an opaque session id.
 * @returns a fresh `editor-<hex>` id.
 */
export function defaultSessionId(): string {
  const random = Math.trunc(Math.random() * 0xFFFF_FFFF).toString(16).padStart(8, '0')
  return `editor-${Date.now().toString(16)}${random}`
}

/** Maps chat conversations onto harness session ids. */
export class SessionTracker {
  private current: string | undefined

  /** @param mint - id factory; the default is {@link defaultSessionId}. */
  constructor(private readonly mint: () => string = defaultSessionId) {}

  /**
   * The session id one request belongs to.
   * @param previousTurns - `ChatContext.history.length` for this request.
   * @returns the id to prompt: a fresh one for an empty history or after
   * {@link reset}, otherwise the current chat's id.
   */
  resolve(previousTurns: number): string {
    if (previousTurns === 0 || this.current === undefined) this.current = this.mint()
    return this.current
  }

  /** Forget the current session so the next request starts a fresh one. */
  reset(): void {
    this.current = undefined
  }

  /** The session id in use, or `undefined` before the first request. */
  get currentId(): string | undefined {
    return this.current
  }
}
