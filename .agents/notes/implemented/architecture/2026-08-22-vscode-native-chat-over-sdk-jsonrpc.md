# Agent Note: VS Code extension is a native chat participant over the SDK protocol

Status: implemented

English | [中文](2026-08-22-vscode-native-chat-over-sdk-jsonrpc.zh.md)

## Problem

Reusing the Web UI in a VS Code webview ([the rejected proposal](../../rejected/architecture/2026-08-22-vscode-extension-webview-reuse.md)) bought feature parity at a cost the editor makes obvious. Starting the agent means booting a web server and serving the whole plugin-composed React client before the first prompt, which is the slowest thing the harness can do. What arrives is a browser inside the editor: it does not know which project VS Code has open, which file is focused, or what the user selected, and it cannot open a file in the editor because it is a cross-origin iframe with no `acquireVsCodeApi`. An editor integration whose first job is to work on the open project should not have to re-discover that project through an in-app folder picker.

## Decision

`extensions/vscode` is a native chat participant. It contributes `@dsh` to VS Code's Chat view, spawns a harness runtime as a child process, and drives it over the [SDK stdio protocol](../../../../packages/sdk/protocol/README.md). No webview, no HTTP, no frontend bundle.

Three pieces carry the decision, each in the layer that owns it.

**The harness composes the transport as a profile.** [`@deepseek-ai/dsh-editor-app`](../../../../packages/bundle/editor/README.md) is a profile bundle that mounts [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) over `dsh-base`, so `dsh --profile editor` is a complete harness that speaks the protocol on stdio and starts nothing else. It restates only what the editor changes: an editor persona, and module-reload HMR off. It deliberately keeps the base agent-plane rows — tools, prompt sections, delegation backends — because this composition mounts no agent presets and SDK-created agents read those registrations from the global layer. Everything the extension needs is therefore plugin composition, not extension code.

**The protocol gained cancellation.** `session/cancel` cancels a session's live driver with cause `user` and drops its pending inbox work, answering `{ cancelled: false }` for a session the runtime holds no agent for. VS Code's Stop button is a first-class interaction, and killing the runtime to honor it would throw away the conversation; this is the gap that made the SDK unfit for an interactive client.

**The extension owns editor knowledge.** It launches the runtime with the workspace folder as the working directory and sends that same path as `initialize.cwd`, so the file tools, the sandbox policy, and the persona's `{{cwd}}` all resolve against the open project with no picker. Each request names the chat's attachments and the active editor's file and selection as workspace-relative paths, never as inlined content: the runtime reads what it needs with its own tools, which keeps a large file out of the request and lets the agent read the version on disk. One chat maps to one harness session (empty history mints a new one), and the turn renders that session's event stream into the response — text deltas as markdown, tool calls as progress lines with the touched files attached as references, `todo_write` as a checklist, and a cancelled, capped, or failed `turn/end` as a closing line.

The wire is mirrored, not imported: `src/jsonrpc.ts` restates the frames the Python SDK also restates, which keeps the extension a standalone esbuild bundle with `vscode` as its only external, and keeps it out of the workspace TypeScript aggregates and the `packages/*` gates.

## Alternatives considered

**Keep the iframe and add a host bridge.** Post messages between the iframe and the extension host to open files and adopt the workspace. Rejected: it keeps the web-server boot the user objected to, and every native affordance becomes a new message in a private protocol layered on top of a UI that already has its own.

**Rebuild the Web UI's chat as a custom webview in the extension.** Rejected: a bundled React client is what makes the current surface heavy, and a second implementation of tool cards and approvals would drift from `packages/client/ui-*` while owning none of it. VS Code's chat parts already render streamed markdown, progress, references, and buttons.

**Drive the automation-only ACP server.** Rejected for the same reason as before: ACP commits assistant text only, with no tool activity, session listing, or mode surface, so a chat over it would show nothing between the prompt and the answer.

**Load cordis and the plugin tree inside the extension host.** Rejected: the harness is ESM and resolves plugins from its own installation, while the extension host loads one CommonJS bundle; a subprocess also keeps a crashing or hung agent out of the editor's process.

**Ship the runtime composition as a `cordis.yml` inside the extension.** Rejected: a config file in the extension would name plugins it cannot resolve from a `.vsix`, and profile composition — bundles, the user's patch layer, `--patch` overlays — is the harness's own extension point. A profile keeps the composition where a user can override it.

**Auto-approve escalations so the agent is never blocked.** Rejected: the fail-closed default is the safe answer while the protocol carries no approval request, and silently granting escalation in the user's own repository is the one failure this seam exists to prevent. Interactive approvals need a protocol addition.

## Consequences

Startup is the runtime's plugin tree and nothing else, and the agent works on the open project from the first request. The extension is smaller than the webview version it replaces: the process manager, a line-protocol peer, and three pure modules (prompt assembly, event rendering, session identity) that `extensions/vscode/tests` covers without a VS Code host — 57 unit tests over argv/env handling, frame correlation and timeouts, the event-to-chat projection, path attachments, and session minting.

`apps/cli/tests/editor-profile.spec.ts` pins the other half keylessly: it boots the shipped profile from source and drives the protocol the extension speaks — handshake, `session/cancel`, `shutdown`, exit 0 — asserting stdout carried three response frames and nothing else, so a composition that mounts a stdout logger fails there rather than in an editor.

What the Web UI still owns: approvals as interaction, tool cards with arguments and diffs, session lists and resume, model and mode pickers, workspaces, and goals. The chat surface reports tool failures and turn outcomes but not those surfaces, and `dsh web` remains the full-feature client over the same session log. Multi-root windows bind to the first folder.

Coverage gaps: no test drives a real `vscode.chat` request (the chat API needs a running editor), so the participant registration, status bar, and command wiring are verified by hand in an Extension Development Host. The SDK snapshot suite (`examples/jsonrpc-agent/tests`) has no cancel scenario: interrupting a replayed turn needs a mid-stream cancellation hook in that harness plus re-recorded fixtures, and the point at which a cancel lands in a replay is not a stable expected output. The Python SDK does not expose `session/cancel` yet; it mirrors the protocol and can add the method when an interactive Python consumer needs it.
