# DeepSeek Harness for VS Code

English | [中文](README.zh.md)

Run the [DeepSeek Harness](../../README.md) agent inside VS Code, as a native chat participant over the project you have open. The extension manages a local harness runtime process and answers in VS Code's own Chat view: type `@dsh` and ask. There is no embedded web app — no browser, no webview, no HTTP server — so the runtime starts as fast as its plugin tree settles and the response renders with VS Code's own chat parts.

## How it works

1. On activation the extension spawns the configured runtime command (default `dsh --profile editor`) with the editor's project directory as its working directory. The [`editor` profile](../../packages/bundle/editor/README.md) is the harness composed to serve the [SDK protocol](../../packages/sdk/protocol/README.md) on stdio.
2. It performs the SDK `initialize` handshake, sending that same directory as `cwd` plus the configured provider and model. The handshake answering **is** readiness; it also proves the runtime's plugin tree settled.
3. Each `@dsh` request queues one prompt on the chat's session and renders that session's event stream into the response: assistant text streams as markdown, each tool call becomes a progress line, files the tools touch are attached as references, `todo_write` renders as a checklist, and a failed or capped turn says so. The turn ends when the session's agent reports idle.
4. VS Code's Stop button cancels the turn in the runtime (`session/cancel`) instead of abandoning it, so the session stays usable for the next request.

Each chat maps to one harness session: a chat with no history starts a new one, and every later request in that chat continues it, which is what gives the agent the conversation's history. **DeepSeek Harness: New Session** forces the next request onto a fresh session.

## What the agent sees of your project

The runtime's working directory is the project you have open, so its file, search, and shell tools operate on that project — the same files the editor shows.

Each request additionally names, as paths:

- every file or selection attached to the chat request (`#file:` and friends), as `path` or `path:start-end`
- the file open in the active editor, with its selected line range

Paths travel, not file contents: the runtime reads what it needs with its own tools, which keeps a large file out of the request and lets the agent read the version on disk. Paths are workspace-relative whenever the file is inside a workspace folder.

## Commands

- `DeepSeek Harness: New Session`
- `DeepSeek Harness: Restart Runtime`
- `DeepSeek Harness: Stop Runtime`
- `DeepSeek Harness: Show Runtime Logs`

## Settings

- `dsh.runtime.command` (default `dsh`): runtime executable. Must be on `PATH`, or point at a launcher. `${workspaceFolder}` expands to the first workspace folder.
- `dsh.runtime.args` (default `["--profile", "editor"]`): arguments; must launch a runtime that serves the SDK protocol on stdio. Each flag and value is its own array item. A slot that starts with `-` and contains spaces (for example `--import tsx/esm file.ts --profile editor`) is split; a path that contains spaces is not. `${workspaceFolder}` expands in each argument.
- `dsh.runtime.autoStart` (default `true`): start the runtime on activation instead of on the first request.
- `dsh.runtime.cwd` (default first workspace folder): the runtime's working directory, and therefore the workspace its tools and sandbox policy resolve against. `${workspaceFolder}` expands.
- `dsh.runtime.handshakeTimeoutMs` (default `120000`): how long to wait for `initialize` before reporting a start failure.
- `dsh.runtime.env`: extra environment variables, for example `DEEPSEEK_API_KEY` or `DEEPSEEK_BASE_URL`.
- `dsh.model.provider` (default `deepseek-official`) and `dsh.model.name` (default `deepseek-v4-flash`): the route every session runs on.

The API key is a runtime concern, not an extension one: the runtime reads `DEEPSEEK_API_KEY` from its environment (including `dsh.runtime.env` and a project `.env`) or the credentials it manages under `$DSH_HOME`.

The spawn drops Electron/VS Code debugger and IPC variables from the extension host so the child Node is a normal process. On Windows, `node` / `dsh` `.cmd` shims are resolved to `node.exe` when present, or run through `cmd.exe` when only a shim exists.

## Developing inside the deepseek-harness monorepo

The default `dsh` command assumes an installed CLI on `PATH`. When developing against this repository, first build the CLI (`pnpm run build`), then point the extension at the workspace build in your `.vscode/settings.json`:

```json
{
  "dsh.runtime.command": "node",
  "dsh.runtime.args": ["${workspaceFolder}/apps/cli/lib/bin.js", "--profile", "editor"],
  "dsh.runtime.cwd": "${workspaceFolder}"
}
```

To launch from TypeScript sources through `tsx` instead of the built `lib/`:

```json
{
  "dsh.runtime.command": "node",
  "dsh.runtime.args": [
    "--import", "tsx/esm", "${workspaceFolder}/apps/cli/src/bin.ts", "--profile", "editor"
  ],
  "dsh.runtime.cwd": "${workspaceFolder}"
}
```

A single array item `--import tsx/esm …/bin.ts --profile editor` is also split into those tokens.

If a source launch is slow, raise `dsh.runtime.handshakeTimeoutMs`. Use **Show Runtime Logs** when a request reports a start failure: the log holds the exact command line, the resolved executable, the runtime's stderr, and its exit code.

## Build

```sh
pnpm install
pnpm --filter dsh-vscode run build     # esbuild -> dist/extension.js
pnpm --filter dsh-vscode run package    # produces dsh-vscode.vsix (via npx @vscode/vsce)
```

Press `F5` in this folder to launch an Extension Development Host for manual testing.

## Limitations

- **Approvals are not interactive.** The SDK protocol carries no approval request, so an action that needs escalation is rejected by the runtime's fail-closed policy; the chat reports the tool failure. Writes inside the workspace do not need approval under the default `workspace-write` sandbox.
- **Tool results are summarized, not carded.** A tool call renders as a progress line plus file references; the full arguments, diffs, and outputs live in the session log, which the Web UI (`dsh web`) still renders in full.
- **One workspace folder.** The runtime is launched for the first workspace folder; a multi-root window sends and resolves paths against that one.
- **Sessions are per chat, per window.** The runtime keeps a session until it exits; the extension does not list or resume earlier sessions.
