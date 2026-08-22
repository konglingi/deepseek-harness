# Agent Note: VS Code extension sanitizes spawn and waits for HTTP or stdout

Status: implemented

English | [中文](2026-08-22-vscode-backend-spawn-readiness.zh.md)

## Problem

Configuring the VS Code extension to launch the workspace CLI (`node --import tsx/esm apps/cli/src/bin.ts web`) leaves the panel on "Starting the DeepSeek Harness backend…" even when the same argv serves the Web UI from a terminal. The extension spawned through the VS Code extension host, inherited Electron debugger and IPC environment, waited only for a `dsh web:` stdout line, and never timed out, so a child that produced no captured output hung the UI forever.

This refines spawn and readiness for the [webview-reuse extension](../../proposed/architecture/2026-08-22-vscode-extension-webview-reuse.md); it does not change the iframe-over-managed-backend decision.

## Decision

`extensions/vscode` launches the backend with ignored stdin, piped stdout/stderr, and `windowsHide`. It drops `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ASAR`, `VSCODE_INSPECTOR_OPTIONS`, `NODE_CHANNEL_FD`, and `NODE_UNIQUE_ID`, and strips inspect/`vscode` `--require` flags from `NODE_OPTIONS`, so the child is an ordinary Node process. On Windows it resolves `node` / `dsh` through `PATHEXT`, preferring `.exe` in each PATH directory and using `shell: true` only for `.cmd`/`.bat` shims; stop uses `taskkill /T /F` so a `cmd.exe` wrapper cannot leave `node` running.

The extension appends `--no-open` (the webview is the UI), `--host 127.0.0.1`, and `--port` when the user argv omits them. It expands `${workspaceFolder}` in command, args, and cwd because `workspace.getConfiguration().get()` does not. Readiness is the first of: a `dsh web: http(s)://…` line accumulated across stdout/stderr chunks, or HTTP succeeding on the bound loopback URL. `dsh.backend.readyTimeoutMs` (default 120s, minimum 1s) fails the start with an error that names the URL and whether any process output arrived.

## Alternatives considered

**Keep stdout-only matching and raise the implicit wait.** A piped, hung, or `printUrl: false` child never prints the line, so a longer wait still leaves the panel on Starting.

**Always `shell: true` on Windows.** That would run npm shims, but it would also wrap `node.exe` in `cmd.exe` and make SIGTERM miss the grandchild; resolving `.exe` first and tree-killing with `taskkill /T` is the narrower fix.

**Treat an already-running `dsh web` as the backend instead of spawning.** The extension owns lifecycle (restart/stop, a private port, `--no-open`). Attaching would share a server with a browser tab and skip those commands.

## Consequences

A source `tsx` launch from the extension host can become ready without a TTY, and a silent child fails instead of spinning. HTTP success can precede Loader settlement, so the iframe may load before `/api` exists; the client retries that transport, which is preferred to an unbounded Starting page. Unit tests in `extensions/vscode/tests/launch.spec.ts` pin argv construction, env scrubbing, Windows `.exe` preference, chunk-split stdout, HTTP fallback, timeout, exit, and cancel. Manual Extension Development Host verification of a Windows `node --import tsx/esm` launch remains a coverage gap this suite cannot close.
