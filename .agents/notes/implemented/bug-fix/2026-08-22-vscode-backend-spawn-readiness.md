# Agent Note: VS Code extension sanitizes its runtime spawn and bounds readiness

Status: implemented

English | [中文](2026-08-22-vscode-backend-spawn-readiness.zh.md)

## Problem

Configuring the VS Code extension to launch the workspace CLI (`node --import tsx/esm apps/cli/src/bin.ts …`) leaves it stuck on starting even when the same argv works from a terminal. The extension spawns through the VS Code extension host, which hands a child Electron debugger and IPC environment, resolves `node` to a `.cmd` shim on Windows, and — with an unbounded wait — hangs forever on a child that produces no output.

Spawn hygiene is independent of what the extension then speaks to that child; the transport decision is the [native chat participant](../architecture/2026-08-22-vscode-native-chat-over-sdk-jsonrpc.md).

## Decision

`extensions/vscode` launches the runtime with piped stdio and `windowsHide`. It drops `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ASAR`, `VSCODE_INSPECTOR_OPTIONS`, `NODE_CHANNEL_FD`, and `NODE_UNIQUE_ID`, and strips inspect/`vscode` `--require` flags from `NODE_OPTIONS`, so the child is an ordinary Node process. On Windows it resolves `node` / `dsh` through `PATHEXT`, preferring `.exe` in each PATH directory and using `shell: true` only for `.cmd`/`.bat` shims; stop uses `taskkill /T /F` so a `cmd.exe` wrapper cannot leave `node` running.

It expands `${workspaceFolder}` in command, args, and cwd because `workspace.getConfiguration().get()` does not. An args array slot that starts with `-` and contains whitespace is tokenized with quote-aware splitting (`--import tsx/esm file.ts "--profile" editor` becomes five argv entries); a path slot that contains spaces is left intact. Readiness is the SDK `initialize` answer, bounded by `dsh.runtime.handshakeTimeoutMs` (default 120s, minimum 1s); a start failure names the command line, the resolved executable, and the child's exit code in the runtime OutputChannel.

## Alternatives considered

**Match a startup line on stdout.** Log text is the wrong readiness signal for a piped child: a hung or quiet process never prints it, and on the SDK transport stdout is the protocol channel. The handshake answer is both the readiness fact and proof that the plugin tree settled.

**Always `shell: true` on Windows.** That would run npm shims, but it would also wrap `node.exe` in `cmd.exe` and make SIGTERM miss the grandchild; resolving `.exe` first and tree-killing with `taskkill /T` is the narrower fix.

**Reject a mashed args slot with a configuration error.** Users paste `--import tsx/esm file.ts …` into one Settings array item; Node then reports `bad option: --import tsx/esm …`. Splitting flag fragments and leaving spaced paths intact matches that paste without breaking `C:\Program Files\…` script paths.

**Attach to an already-running harness instead of spawning.** The extension owns lifecycle (restart/stop) and needs the child's own stdio for the protocol, which no attach can supply.

## Consequences

A source `tsx` launch from the extension host becomes ready without a TTY, and a silent child fails with its exit code instead of spinning. Unit tests in `extensions/vscode/tests/launch.spec.ts` pin argv coercion, mashed `--import` array slots, env scrubbing, Windows `.exe` preference, the piped stdio options, and the timeout floor. Manual Extension Development Host verification of a Windows `node --import tsx/esm` launch remains a coverage gap this suite cannot close.
