# `@deepseek-ai/dsh-editor-app`

English | [中文](README.zh.md)

The editor surface as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) mounts [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.md) over the [`dsh-base`](../base/README.md) layer, so `dsh --profile editor` is a harness runtime that speaks the [SDK protocol](../../sdk/protocol/README.md) on stdio and nothing else. Its client is an editor extension — [`extensions/vscode`](../../../extensions/vscode/README.md) is the shipped one — which spawns the runtime, drives turns, and renders the session-event stream in the editor's own chat UI. The package has no runtime API; the profile composer resolves the patch through the `dsh.bundle.patch` manifest field, never through code.

`dsh --profile editor` starts no HTTP server, serves no frontend, and mounts no terminal UI, so it reaches readiness as soon as its plugin tree settles. Stdout carries JSON-RPC frames only; diagnostics belong on stderr, and a profile layer that adds a stdout logger corrupts the protocol channel.

The base agent-plane rows stay mounted. Unlike [`dsh-web-app`](../web-app/README.md), which moves tools, prompt sections, and delegation backends behind per-session agent presets, this bundle mounts no preset roster: the SDK server creates agents that read those registrations from the global layer, so a row disabled here would leave every editor session without that capability. This layer restates only what the editor changes — the persona, and the disabled module-reload row.

The workspace binding is the client's: the extension launches the runtime with the editor's project directory as its working directory and sends the same path as `initialize.cwd`, which is what the file tools, the sandbox policy, and the persona's `{{cwd}}` resolve against.

## Model Experience

### Editor-surface persona

#### What the model sees

The `system-prompt` persona states that the agent runs inside the user's editor on the project at `{{cwd}}`, that the user follows progress in the editor's chat view, and that the files it reads and writes are the files open in that editor. No other section, tool, or schema is contributed here; every one of those belongs to a row the base layer inserts.

#### Token effect

One persona paragraph per session, constant per process.

#### KV Cache effect

The persona sits at the head of the system prompt and is fixed for the life of the process, so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **Approvals fail closed** — the base `ask` policy has no answerer on this transport, because the SDK protocol carries no approval request; escalation-requiring actions are rejected and appear as `approval/asked` plus `approval/decided` audit events. Interactive approvals need a protocol addition, not a config change here.
- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **The profile takes no app flags** — the composed tree parses no argv, so `dsh --profile editor <args>` ignores everything after the launcher flags.
