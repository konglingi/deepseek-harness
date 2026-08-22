/**
 * Pure assembly of one harness prompt from what the editor knows: the typed
 * request, the files and selections attached to it, and the active editor.
 * No `vscode` import; [chat.ts](chat.ts) converts the editor objects into the
 * plain data below.
 *
 * Attachments travel as workspace-relative paths and line ranges, never as
 * inlined file contents: the runtime reads what it needs with its own file
 * tools, which keeps a long file out of the request and lets the agent read
 * the version on disk.
 */

/** One file or selection the user attached to the request. */
export interface PromptAttachment {
  /** Workspace-relative path when the file is inside a workspace folder, otherwise absolute. */
  path: string
  /** One-based inclusive line range for a selection; absent for a whole file. */
  range?: { start: number; end: number }
}

/** Everything the prompt is built from. */
export interface PromptInput {
  /** The request text as typed, without the participant name. */
  text: string
  /** Files and selections attached through the chat request, in request order. */
  attachments: readonly PromptAttachment[]
  /** The file the user is editing, when it is not already attached. */
  activeFile?: PromptAttachment
}

/** One content block of a harness user message. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/**
 * Build the user message for one turn.
 * @param input - request text plus the editor context to name.
 * @returns the content blocks to send as `session/prompt.contentBlocks`.
 */
export function buildPromptBlocks(input: PromptInput): TextContentBlock[] {
  return [{ type: 'text', text: buildPromptText(input) }]
}

/**
 * Render the prompt text: the request as typed, then an editor-context list
 * when there is anything to name.
 * @param input - request text plus the editor context to name.
 * @returns the complete user message text.
 */
export function buildPromptText(input: PromptInput): string {
  const text = input.text.trim()
  const lines = contextLines(input)
  if (lines.length === 0) return text
  const context = ['Editor context:', ...lines].join('\n')
  return text.length === 0 ? context : `${text}\n\n${context}`
}

function contextLines(input: PromptInput): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const attachment of input.attachments) {
    const rendered = renderAttachment(attachment)
    if (seen.has(rendered)) continue
    seen.add(rendered)
    lines.push(`- attached: ${rendered}`)
  }
  const active = input.activeFile
  if (active !== undefined && !seen.has(renderAttachment(active)) && !seen.has(active.path)) {
    lines.push(`- open in the editor: ${renderAttachment(active)}`)
  }
  return lines
}

/**
 * Render one attachment as `path` or `path:start-end`.
 * @param attachment - the file or selection to render.
 * @returns the path with its line range when it has one.
 */
export function renderAttachment(attachment: PromptAttachment): string {
  const range = attachment.range
  if (range === undefined) return attachment.path
  return range.start === range.end
    ? `${attachment.path}:${String(range.start)}`
    : `${attachment.path}:${String(range.start)}-${String(range.end)}`
}
