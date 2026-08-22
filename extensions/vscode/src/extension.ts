import * as vscode from 'vscode'
import { BackendManager } from './backend'
import { HarnessPanel } from './panel'
import { HarnessViewProvider } from './view'

/** Activate the extension: wire the backend manager, views, commands, and status bar. */
export function activate(context: vscode.ExtensionContext): void {
  const backend = new BackendManager()
  context.subscriptions.push(backend)

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'dsh.open'
  const renderStatusBar = (): void => {
    const { state, url, message } = backend.status
    statusBar.text = `${STATUS_ICON[state]} Harness`
    statusBar.tooltip = state === 'ready'
      ? `DeepSeek Harness backend: ${url ?? ''}`
      : `DeepSeek Harness backend: ${state}${message !== undefined ? ` — ${message}` : ''}`
    statusBar.show()
  }
  renderStatusBar()
  context.subscriptions.push(statusBar, backend.onDidChangeStatus(renderStatusBar))

  const view = new HarnessViewProvider(backend)
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(HarnessViewProvider.viewType, view),
    vscode.commands.registerCommand('dsh.open', () => HarnessPanel.createOrShow(backend)),
    vscode.commands.registerCommand('dsh.restartBackend', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting DeepSeek Harness backend…' },
        async () => { await backend.restart() },
      )),
    vscode.commands.registerCommand('dsh.stopBackend', () => { backend.stop() }),
    vscode.commands.registerCommand('dsh.showLogs', () => { backend.showLogs() }),
  )

  const autoStart = vscode.workspace.getConfiguration('dsh').get<boolean>('backend.autoStart', true)
  if (autoStart) {
    void backend.ensureStarted().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(
        `DeepSeek Harness backend failed to start: ${message}`,
        'Show Logs',
      ).then((choice) => {
        if (choice === 'Show Logs') backend.showLogs()
      })
    })
  }
}

/** Deactivate the extension. The backend is disposed via context subscriptions. */
export function deactivate(): void {
  // Nothing to do: BackendManager.dispose() runs through context.subscriptions.
}

const STATUS_ICON: Record<string, string> = {
  stopped: '$(circle-slash)',
  starting: '$(sync~spin)',
  ready: '$(rocket)',
  error: '$(error)',
}
