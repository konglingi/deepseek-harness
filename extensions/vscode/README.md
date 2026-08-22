# DeepSeek Harness for VS Code

English | [中文](README.zh.md)

Run the [DeepSeek Harness](../../README.md) agent inside VS Code. The extension launches and manages a local `dsh web` backend and embeds the full Harness Web UI (chat, tool cards, approvals, workspaces, sessions, models/credentials, subagents, goals, plan mode, settings) in an editor panel — the same UI served by `dsh web`, reused as-is.

## How it works

1. On activation the extension starts a backend by running the configured command (default `dsh web`), appending `--host 127.0.0.1` and a `--port`.
2. It parses the backend's `dsh web: http://127.0.0.1:<port>` line to learn the URL.
3. The **Open DeepSeek Harness** action opens a Webview panel whose iframe loads that URL through `vscode.env.asExternalUri`, so the entire Web UI runs in VS Code and talks to the backend over its normal HTTP + WebSocket `/api` transport.

The DeepSeek API key is entered inside the embedded **Models** page, exactly as in the browser Web UI; no key is needed to start the backend.

## Commands

- `DeepSeek Harness: Open Panel`
- `DeepSeek Harness: Restart Backend`
- `DeepSeek Harness: Stop Backend`
- `DeepSeek Harness: Show Backend Logs`

## Settings

- `dsh.backend.command` (default `dsh`): backend executable. Must be on `PATH`, or point at a launcher (see below).
- `dsh.backend.args` (default `["web"]`): arguments; must start the `web` server. `--host`/`--port` are added automatically.
- `dsh.backend.port` (default `0`): `0` picks a free port.
- `dsh.backend.autoStart` (default `true`): start the backend on activation.
- `dsh.backend.cwd` (default first workspace folder): backend working directory.
- `dsh.backend.env`: extra environment variables (for example `DEEPSEEK_BASE_URL`).

## Developing inside the deepseek-harness monorepo

The default `dsh` command assumes an installed CLI on `PATH`. When developing against this repository, first build the CLI (`pnpm run build`), then point the extension at the workspace build in your `.vscode/settings.json`:

```json
{
  "dsh.backend.command": "node",
  "dsh.backend.args": ["${workspaceFolder}/apps/cli/lib/bin.js", "web"]
}
```

(VS Code does not expand `${workspaceFolder}` inside these string settings; use an absolute path, or set `dsh.backend.cwd` to the repo root and use a relative `apps/cli/lib/bin.js`.)

## Build

```sh
pnpm install
pnpm --filter dsh-vscode run build     # esbuild -> dist/extension.js
pnpm --filter dsh-vscode run package    # produces dsh-vscode.vsix (via npx @vscode/vsce)
```

Press `F5` in this folder to launch an Extension Development Host for manual testing.

## Remote / Codespaces

Over Remote-SSH, Dev Containers, or Codespaces, `asExternalUri` forwards the loopback port to a generated external host. Because the backend applies a loopback trust fence, pass a matching `--trusted-host` via `dsh.backend.args` for that host. Local (desktop) usage needs no extra configuration.
