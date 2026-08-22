import { isAbsolute, join } from 'node:path'
import * as vscode from 'vscode'
import { buildPromptBlocks, type PromptAttachment, type PromptInput } from './prompt'
import { isInboxReceipt, isSessionIdle, TurnRenderer, type ChatSink } from './render'
import type { HarnessRuntime } from './runtime'
import type { SessionTracker } from './sessions'

/** The participant id declared in `contributes.chatParticipants`. */
const PARTICIPANT_ID = 'deepseek.harness'

/**
 * Register the chat participant that runs harness turns. The handler owns one
 * turn end to end: it queues the prompt, renders the session-event stream into
 * the response, and settles when the session's agent next reports idle. VS
 * Code cancellation (the Stop button) cancels the runtime-side turn instead of
 * abandoning it.
 *
 * @param context - the activated extension context, for the participant icon.
 * @param runtime - the managed runtime process.
 * @param sessions - conversation-to-session mapping.
 * @returns the participant, to dispose with the extension.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  runtime: HarnessRuntime,
  sessions: SessionTracker,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, chatContext, stream, token) => {
      const sessionId = sessions.resolve(chatContext.history.length)
      if (runtime.status.state !== 'ready') stream.progress('Starting the DeepSeek Harness runtime')
      try {
        await runtime.ensureStarted()
      } catch (error) {
        stream.markdown(startFailureMarkdown(error))
        stream.button({ command: 'dsh.showLogs', title: 'Show Runtime Logs' })
        return { errorDetails: { message: errorMessage(error) } }
      }
      await runTurn(runtime, sessionId, request, stream, token)
      return { metadata: { sessionId } }
    },
  )
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harness.svg')
  return participant
}

/**
 * Drive one turn: prompt, then render until the session is idle again.
 * @param runtime - the managed runtime process.
 * @param sessionId - the session this chat maps to.
 * @param request - the chat request being answered.
 * @param stream - the response stream to render into.
 * @param token - VS Code's cancellation for this request.
 */
async function runTurn(
  runtime: HarnessRuntime,
  sessionId: string,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const renderer = new TurnRenderer(chatSink(stream))
  const subscription = runtime.subscribe(sessionId)
  const cancellation = token.onCancellationRequested(() => {
    void runtime.cancel(sessionId).catch(() => {
      // A cancel that cannot reach the runtime is already visible as the
      // transport failure this turn's next await rejects with.
    })
  })
  try {
    const messageId = await runtime.prompt(sessionId, buildPromptBlocks(promptInput(request)))
    let received = false
    for (;;) {
      const notification = await subscription.next()
      // Everything before the durable receipt belongs to earlier work on this
      // session, so this turn starts rendering at its own message.
      if (!received) {
        if (!isInboxReceipt(notification, sessionId, messageId)) continue
        received = true
      }
      renderer.handle(notification)
      if (isSessionIdle(notification, sessionId)) return
    }
  } catch (error) {
    stream.markdown(`\n\n**DeepSeek Harness error:** ${errorMessage(error)}\n`)
    stream.button({ command: 'dsh.showLogs', title: 'Show Runtime Logs' })
  } finally {
    cancellation.dispose()
    subscription.close()
  }
}

/** Bridge the pure renderer onto the VS Code response stream. */
function chatSink(stream: vscode.ChatResponseStream): ChatSink {
  return {
    markdown: (value) => { stream.markdown(value) },
    progress: (value) => { stream.progress(value) },
    reference: (path) => {
      const uri = workspaceUri(path)
      if (uri !== undefined) stream.reference(uri)
    },
  }
}

/**
 * Collect the editor context for one request: the files and selections the
 * user attached, plus the active editor when it is not already among them.
 * @param request - the chat request being answered.
 * @returns the prompt input for {@link buildPromptBlocks}.
 */
function promptInput(request: vscode.ChatRequest): PromptInput {
  const attachments = request.references
    .map(reference => toAttachment(reference.value))
    .filter((attachment): attachment is PromptAttachment => attachment !== undefined)
  const active = activeEditorAttachment()
  return {
    text: request.prompt,
    attachments,
    ...active === undefined ? {} : { activeFile: active },
  }
}

function activeEditorAttachment(): PromptAttachment | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined
  const path = vscode.workspace.asRelativePath(editor.document.uri, false)
  if (editor.selection.isEmpty) return { path }
  return {
    path,
    range: { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 },
  }
}

function toAttachment(value: unknown): PromptAttachment | undefined {
  if (value instanceof vscode.Uri) {
    return value.scheme === 'file' ? { path: vscode.workspace.asRelativePath(value, false) } : undefined
  }
  if (value instanceof vscode.Location) {
    if (value.uri.scheme !== 'file') return undefined
    return {
      path: vscode.workspace.asRelativePath(value.uri, false),
      range: { start: value.range.start.line + 1, end: value.range.end.line + 1 },
    }
  }
  return undefined
}

/** Resolve a path a tool reported against the first workspace folder. */
function workspaceUri(path: string): vscode.Uri | undefined {
  if (isAbsolute(path)) return vscode.Uri.file(path)
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return folder === undefined ? undefined : vscode.Uri.file(join(folder, path))
}

function startFailureMarkdown(error: unknown): string {
  return [
    `**The DeepSeek Harness runtime did not start:** ${errorMessage(error)}`,
    '',
    'Check `dsh.runtime.command` and `dsh.runtime.args`. The default expects `dsh` on PATH; inside the monorepo, point them at the workspace CLI.',
  ].join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
