/**
 * Pure projection of harness session events onto the parts a chat response can
 * hold: streamed markdown, progress lines, and file references. No `vscode`
 * import, so the mapping is testable on its own; [chat.ts](chat.ts) supplies a
 * sink backed by `vscode.ChatResponseStream`.
 */

import type { HarnessNotification } from './jsonrpc'

/** The response parts this renderer produces. */
export interface ChatSink {
  /** Append markdown to the answer. */
  markdown: (value: string) => void
  /** Report what the agent is doing right now. */
  progress: (value: string) => void
  /** Attach a workspace file the turn touched, as an absolute or workspace-relative path. */
  reference: (path: string) => void
}

/** Tool arguments the renderer knows how to label and reference. */
interface ToolArguments {
  command?: unknown
  path?: unknown
  file_path?: unknown
  paths?: unknown
  pattern?: unknown
  description?: unknown
}

interface TodoItem {
  content?: unknown
  status?: unknown
}

/**
 * Turn-scoped rendering state: the call-id to tool-name map that lets a
 * failing `tool/result` name the tool that failed, and the reference set that
 * keeps one attachment per path.
 */
export class TurnRenderer {
  private readonly toolNames = new Map<string, string>()
  private readonly referenced = new Set<string>()

  /** @param sink - where rendered parts go. */
  constructor(private readonly sink: ChatSink) {}

  /**
   * Render one notification. Anything this renderer does not present — chunk
   * kinds without a chat part, step boundaries, request headers — is dropped
   * silently; the session log remains the complete record.
   * @param notification - one wire notification in stream order.
   */
  handle(notification: HarnessNotification): void {
    if (notification.method === 'subagent.started') {
      this.sink.progress('Delegating to a subagent')
      return
    }
    if (notification.method !== 'session.event') return
    const event = notification.params.event
    if (!isRecord(event) || typeof event.type !== 'string') return
    const data = isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case 'assistant/chunk':
        this.renderChunk(data)
        return
      case 'tool/call':
        this.renderToolCall(data)
        return
      case 'tool/result':
        this.renderToolResult(data)
        return
      case 'todo/write':
        this.renderTodos(data)
        return
      case 'turn/end':
        this.renderTurnEnd(data)
        return
      default:
        return
    }
  }

  private renderChunk(data: Record<string, unknown>): void {
    const chunk = isRecord(data.chunk) ? data.chunk : undefined
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    this.sink.markdown(chunk.text)
  }

  private renderToolCall(data: Record<string, unknown>): void {
    const name = typeof data.name === 'string' ? data.name : 'tool'
    if (typeof data.callId === 'string') this.toolNames.set(data.callId, name)
    const args = parseArguments(data.arguments)
    this.sink.progress(toolCallLabel(name, args))
    for (const path of referencedPaths(args)) {
      if (this.referenced.has(path)) continue
      this.referenced.add(path)
      this.sink.reference(path)
    }
  }

  private renderToolResult(data: Record<string, unknown>): void {
    const failure = isRecord(data.error) ? data.error : undefined
    if (failure === undefined) return
    const message = isRecord(data.message) ? data.message : undefined
    const callId = typeof message?.callId === 'string' ? message.callId : undefined
    const name = (callId === undefined ? undefined : this.toolNames.get(callId)) ?? 'tool'
    const code = typeof failure.code === 'string' ? failure.code : 'failed'
    this.sink.markdown(`\n\n\`${name}\` failed: ${code}\n\n`)
  }

  private renderTodos(data: Record<string, unknown>): void {
    const todos = Array.isArray(data.todos) ? data.todos as TodoItem[] : []
    if (todos.length === 0) return
    const lines = todos.map((todo) => {
      const content = typeof todo.content === 'string' ? todo.content : ''
      const done = todo.status === 'completed'
      const active = todo.status === 'in_progress'
      return `- [${done ? 'x' : ' '}] ${active ? `**${content}**` : content}`
    })
    this.sink.markdown(`\n\n${lines.join('\n')}\n\n`)
  }

  private renderTurnEnd(data: Record<string, unknown>): void {
    const reason = isRecord(data.reason) ? data.reason : undefined
    if (reason === undefined) return
    switch (reason.kind) {
      case 'aborted':
        this.sink.markdown('\n\n_Canceled._\n')
        return
      case 'max-tokens':
        this.sink.markdown('\n\n_Stopped at the output-token limit._\n')
        return
      case 'error': {
        const failure = isRecord(reason.error) ? reason.error : undefined
        const message = typeof failure?.message === 'string' ? failure.message : 'the turn failed'
        this.sink.markdown(`\n\n**Run failed:** ${message}\n`)
        return
      }
      default:
        return
    }
  }
}

/**
 * Label one tool call for a progress line.
 * @param name - the tool name from the `tool/call` event.
 * @param args - parsed tool arguments, or `undefined` when they are not JSON.
 * @returns a single-line human label.
 */
export function toolCallLabel(name: string, args: ToolArguments | undefined): string {
  if (args === undefined) return name
  if (typeof args.description === 'string' && args.description.length > 0) {
    return `${name}: ${firstLine(args.description)}`
  }
  if (typeof args.command === 'string' && args.command.length > 0) {
    return `${name}: ${firstLine(args.command)}`
  }
  const path = firstString([args.path, args.file_path, args.pattern])
  return path === undefined ? name : `${name}: ${path}`
}

/**
 * The workspace paths a tool call names, for the response's reference list.
 * @param args - parsed tool arguments, or `undefined` when they are not JSON.
 * @returns each distinct path argument, in argument order.
 */
export function referencedPaths(args: ToolArguments | undefined): string[] {
  if (args === undefined) return []
  const candidates = [args.path, args.file_path, ...(Array.isArray(args.paths) ? args.paths : [])]
  const paths: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (!paths.includes(candidate)) paths.push(candidate)
  }
  return paths
}

/**
 * Parse a `tool/call` arguments string.
 * @param value - the raw JSON string the event carries.
 * @returns the parsed object, or `undefined` when it is absent, unparseable,
 * or not a JSON object (a streamed call can be cut short mid-arguments).
 */
export function parseArguments(value: unknown): ToolArguments | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed as ToolArguments : undefined
  } catch {
    // A truncated or non-JSON arguments payload only costs a plainer label.
    return undefined
  }
}

/**
 * Whether a notification is the durable inbox receipt for one submitted message.
 * @param notification - the notification to test.
 * @param sessionId - the session the prompt was sent to.
 * @param messageId - the id `session/prompt` returned.
 * @returns `true` for the `agent/inbox/spliced` event carrying that message.
 */
export function isInboxReceipt(
  notification: HarnessNotification,
  sessionId: string,
  messageId: string,
): boolean {
  if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId) return false
  const event = notification.params.event
  if (!isRecord(event) || event.type !== 'agent/inbox/spliced' || !isRecord(event.data)) return false
  const inserted = event.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Whether a notification reports the session's whole agent as idle.
 * @param notification - the notification to test.
 * @param sessionId - the session being awaited.
 * @returns `true` for that session's `idle` status transition.
 */
export function isSessionIdle(notification: HarnessNotification, sessionId: string): boolean {
  return notification.method === 'session.status'
    && notification.params.sessionId === sessionId
    && notification.params.status === 'idle'
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/u)[0] ?? value
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
