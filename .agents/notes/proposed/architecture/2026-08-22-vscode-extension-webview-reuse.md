# Agent Note: VS Code extension reuses the Web UI over a managed backend

Status: proposed

English | [中文](2026-08-22-vscode-extension-webview-reuse.zh.md)

## Problem

Editors are a primary place developers want the agent, but the product UI is a plugin-composed React app whose features live across dozens of `packages/client/ui-*` plugins loaded at runtime by the Cordis client. Reimplementing that surface natively in VS Code would duplicate the entire client tier and immediately drift from the shipped Web UI. We want an in-editor experience with full feature parity without forking the UI.

## Proposal

Ship a VS Code extension at [extensions/vscode](../../../../extensions/vscode/README.md) that reuses the existing Web UI instead of rebuilding it. The extension owns two responsibilities: manage a local backend process and embed the Web UI.

The extension spawns `dsh web` (a configurable command), forcing `--no-open`, `--host 127.0.0.1`, and a `--port`. It treats the backend as ready when stdout matches `dsh web: http://127.0.0.1:<port>` or when that loopback port accepts HTTP, whichever happens first ([spawn and readiness](../../implemented/bug-fix/2026-08-22-vscode-backend-spawn-readiness.md)). It then opens a Webview editor panel whose `<iframe>` loads that URL through `vscode.env.asExternalUri`, so the unchanged Web UI runs inside VS Code and talks to the backend over its normal HTTP + WebSocket `/api` transport ([contract](../../../../packages/host/apiproxy/src/api/rpc.ts), browser entry [apps/web/src/main.ts](../../../../apps/web/src/main.ts)). The DeepSeek API key is entered through the embedded Models page, so the backend starts without credentials.

The extension is a standalone bundled deliverable: an esbuild single-file CommonJS bundle with `vscode` external, joined to the workspace only for dependency install. It is deliberately kept out of the `tsconfig.host.json`/`tsconfig.client.json` aggregates, the `tsdown` lib pipeline, the `check-workspace-constraints` globs, and the `packages/*` publint/coverage/`@deepseek-ai/dsh-*` gates — modeled after `website`, which is a private workspace member with its own out-of-band build.

## Alternatives considered

- **Native VS Code UI over the JSON-RPC SDK.** Rebuild chat, tool cards, approvals, sessions, and settings as native or custom-webview UI driven by [packages/sdk](../../../../packages/sdk/README.md). Rejected for the first version: it re-creates the entire `packages/client/ui-*` tier, and the stdio SDK currently lacks on-wire approvals and mid-turn cancel, so it could not reach parity.
- **Agent Client Protocol.** Drive the automation-only ACP server. Rejected: ACP is automation-only and emits committed assistant text only, with no session load/list, model/mode pickers, tool cards, or approvals, so it cannot back a full UI.
- **Serve the built frontend from the extension itself.** Bundle `apps/web/dist` and connect it to a host over `/api`. Rejected as more work with no parity gain over pointing an iframe at the managed `dsh web`, which already serves that frontend and the plugin bundles.
- **Place the extension under `packages/` or `apps/`.** Rejected: `packages/extensions/` already denotes Cordis dynamic-plugin packages, and `apps/*` release members carry publint/version/publication policy. A top-level `extensions/` folder names the editor-integration boundary without inheriting those gates.

## Acceptance criteria

The extension builds to `dist/extension.js` via esbuild and typechecks under its own tsconfig. Activating it starts `dsh web`, and the panel embeds a live Web UI that reaches the backend (a real prompt round-trips and renders). `pnpm install`, `knip`, and `check-workspace-constraints` still pass with the new workspace member. Packaging produces a `.vsix`.

## Risks

Over Remote/Codespaces, `asExternalUri` rewrites the host, which the backend loopback trust fence rejects until a matching `--trusted-host` is supplied; the first version targets local desktop and documents the remote caveat. Reusing the Web UI in an iframe gives parity but limited VS Code-native integration (for example tool diffs are not mapped to native diff views), left for a later iteration. Embedding the whole UI in an iframe couples the extension to the Web UI's CSP and same-origin transport assumptions, which hold for the loopback backend the extension launches.
