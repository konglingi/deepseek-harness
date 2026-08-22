import * as vscode from 'vscode'
import { registerChatParticipant } from './chat'
import { HarnessRuntime } from './runtime'
import { SessionTracker } from './sessions'

/** Activate the extension: the runtime process, the chat participant, commands, and status bar. */
export function activate(context: vscode.ExtensionContext): void {
  const runtime = new HarnessRuntime()
  const sessions = new SessionTracker()
  context.subscriptions.push(runtime)

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'dsh.showLogs'
  const renderStatusBar = (): void => {
    const { state, message } = runtime.status
    statusBar.text = `${STATUS_ICON[state]} Harness`
    statusBar.tooltip = `DeepSeek Harness runtime: ${state}${message === undefined ? '' : ` — ${message}`}`
    statusBar.show()
  }
  renderStatusBar()
  context.subscriptions.push(statusBar, runtime.onDidChangeStatus(renderStatusBar))

  context.subscriptions.push(
    registerChatParticipant(context, runtime, sessions),
    vscode.commands.registerCommand('dsh.newSession', () => {
      sessions.reset()
      void vscode.window.showInformationMessage('The next DeepSeek Harness request starts a new session.')
    }),
    vscode.commands.registerCommand('dsh.restartRuntime', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting the DeepSeek Harness runtime…' },
        async () => {
          sessions.reset()
          await runtime.restart()
        },
      )),
    vscode.commands.registerCommand('dsh.stopRuntime', () => { runtime.stop() }),
    vscode.commands.registerCommand('dsh.showLogs', () => { runtime.showLogs() }),
  )

  const autoStart = vscode.workspace.getConfiguration('dsh').get<boolean>('runtime.autoStart', true)
  if (autoStart) {
    // Booting alongside activation overlaps the runtime's start with the user
    // opening chat and typing; a failure is reported by the first request that
    // needs it, so activation stays quiet apart from the status bar.
    void runtime.ensureStarted().catch(() => {})
  }
}

/** Deactivate the extension. The runtime is disposed via context subscriptions. */
export function deactivate(): void {
  // Nothing to do: HarnessRuntime.dispose() runs through context.subscriptions.
}

const STATUS_ICON: Record<string, string> = {
  stopped: '$(circle-slash)',
  starting: '$(sync~spin)',
  ready: '$(rocket)',
  error: '$(error)',
}
