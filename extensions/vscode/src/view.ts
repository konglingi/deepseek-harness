import * as vscode from 'vscode'
import type { BackendManager, BackendStatus } from './backend'
import { escapeText, getNonce } from './html'

/**
 * The activity-bar landing view. The full three-column Web UI belongs in the
 * wide editor panel (see {@link HarnessPanel}); this narrow sidebar shows
 * backend status and action buttons that dispatch the extension commands.
 */
export class HarnessViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.landing'

  private view: vscode.WebviewView | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly backend: BackendManager) {
    this.disposables.push(this.backend.onDidChangeStatus(status => this.render(status)))
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      switch (message.type) {
        case 'open':
          void vscode.commands.executeCommand('dsh.open')
          break
        case 'restart':
          void vscode.commands.executeCommand('dsh.restartBackend')
          break
        case 'logs':
          void vscode.commands.executeCommand('dsh.showLogs')
          break
        default:
          break
      }
    }, undefined, this.disposables)
    webviewView.onDidDispose(() => { this.view = undefined }, undefined, this.disposables)
    this.render(this.backend.status)
  }

  private render(status: BackendStatus): void {
    if (this.view === undefined) return
    this.view.webview.html = this.html(status)
  }

  private html(status: BackendStatus): string {
    const nonce = getNonce()
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ')
    const label = STATUS_LABEL[status.state]
    const detail = status.state === 'ready'
      ? escapeText(status.url ?? '')
      : status.message !== undefined
        ? escapeText(status.message)
        : ''
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    .status { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-weight: 600; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: ${STATUS_COLOR[status.state]}; }
    .detail { color: var(--vscode-descriptionForeground); font-size: 12px; word-break: break-all; margin-bottom: 14px; }
    button {
      display: block; width: 100%; margin-bottom: 8px; text-align: left;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: none; padding: 8px 12px; cursor: pointer; border-radius: 2px;
    }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="status"><span class="dot"></span><span>${escapeText(label)}</span></div>
  <div class="detail">${detail}</div>
  <button id="open">Open DeepSeek Harness</button>
  <button id="restart" class="secondary">Restart backend</button>
  <button id="logs" class="secondary">Show backend logs</button>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    for (const [id, type] of [['open','open'],['restart','restart'],['logs','logs']]) {
      document.getElementById(id).addEventListener('click', () => vscodeApi.postMessage({ type }));
    }
  </script>
</body>
</html>`
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }
}

const STATUS_LABEL: Record<BackendStatus['state'], string> = {
  stopped: 'Backend stopped',
  starting: 'Backend starting…',
  ready: 'Backend ready',
  error: 'Backend error',
}

const STATUS_COLOR: Record<BackendStatus['state'], string> = {
  stopped: 'var(--vscode-descriptionForeground)',
  starting: 'var(--vscode-charts-yellow)',
  ready: 'var(--vscode-charts-green)',
  error: 'var(--vscode-errorForeground)',
}
