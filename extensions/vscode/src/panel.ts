import * as vscode from 'vscode'
import type { BackendManager, BackendStatus } from './backend'
import { escapeAttribute, escapeText, getNonce } from './html'

/**
 * The full-width editor panel that embeds the DeepSeek Harness Web UI. It
 * resolves the managed backend URL through {@link vscode.env.asExternalUri}
 * (so it also works over Remote/Codespaces port forwarding) and renders it in
 * an iframe. A singleton: `dsh.open` reveals the existing panel if present.
 */
export class HarnessPanel {
  static readonly viewType = 'dsh.panel'
  private static current: HarnessPanel | undefined

  /** Create the panel, or reveal and reload the existing one. */
  static async createOrShow(backend: BackendManager): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active
    if (HarnessPanel.current !== undefined) {
      HarnessPanel.current.panel.reveal(column)
      await HarnessPanel.current.load()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      HarnessPanel.viewType,
      'DeepSeek Harness',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    HarnessPanel.current = new HarnessPanel(panel, backend)
    await HarnessPanel.current.load()
  }

  private readonly disposables: vscode.Disposable[] = []

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly backend: BackendManager,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.disposables.push(this.backend.onDidChangeStatus(status => this.onStatus(status)))
    this.disposables.push(this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === 'retry') void this.backend.restart()
    }))
  }

  private onStatus(status: BackendStatus): void {
    if (status.state === 'ready') {
      void this.load()
    } else if (status.state === 'starting') {
      this.panel.webview.html = this.loadingHtml()
    } else if (status.state === 'error') {
      this.panel.webview.html = this.errorHtml(status.message ?? 'The backend failed to start.')
    }
  }

  private async load(): Promise<void> {
    this.panel.webview.html = this.loadingHtml()
    let url: string
    try {
      url = await this.backend.ensureStarted()
    } catch (error) {
      this.panel.webview.html = this.errorHtml(error instanceof Error ? error.message : String(error))
      return
    }
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url))
    this.panel.webview.html = this.iframeHtml(external.toString())
  }

  private iframeHtml(src: string): string {
    const origin = originOf(src)
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `frame-src ${origin} http://127.0.0.1:* http://localhost:*`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    iframe { border: 0; width: 100%; height: 100vh; display: block; }
  </style>
</head>
<body>
  <iframe src="${escapeAttribute(src)}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`
  }

  private loadingHtml(): string {
    return this.frameHtml('Starting the DeepSeek Harness backend…', false)
  }

  private errorHtml(message: string): string {
    return this.frameHtml(message, true)
  }

  private frameHtml(message: string, showRetry: boolean): string {
    const nonce = getNonce()
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ')
    const retryButton = showRetry
      ? '<button id="retry">Restart backend</button>'
      : '<div class="spinner">Please wait…</div>'
    const retryScript = showRetry
      ? `<script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('retry').addEventListener('click', () => vscodeApi.postMessage({ type: 'retry' }));
  </script>`
      : ''
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; }
    .message { margin-bottom: 16px; white-space: pre-wrap; }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .spinner { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="message">${escapeText(message)}</div>
  ${retryButton}
  ${retryScript}
</body>
</html>`
  }

  private dispose(): void {
    HarnessPanel.current = undefined
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    this.panel.dispose()
  }
}

/** The scheme+host+port origin of a URL, for a Content-Security-Policy allowance. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
