# Agent Note: VS Code extension sanitizes spawn and waits for HTTP or stdout

Status: implemented

[English](2026-08-22-vscode-backend-spawn-readiness.md) | 中文

## Problem

将 VS Code 扩展配置为启动工作区 CLI（`node --import tsx/esm apps/cli/src/bin.ts web`）后，面板会停在 “Starting the DeepSeek Harness backend…”，即使同一组 argv 在终端里可以提供 Web UI。扩展经由 VS Code 扩展宿主 spawn，继承了 Electron 调试器与 IPC 环境，只等待 stdout 中的 `dsh web:` 行，且从不超时，因此一个没有被捕获到输出的子进程会让 UI 永久挂起。

这只收紧 [webview 复用扩展](../../proposed/architecture/2026-08-22-vscode-extension-webview-reuse.zh.md) 的 spawn 与就绪判定，并不改变「在受管后端之上用 iframe」的决策。

## Decision

`extensions/vscode` 启动后端时忽略 stdin、管道连接 stdout/stderr，并设置 `windowsHide`。它会去掉 `ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ASAR`、`VSCODE_INSPECTOR_OPTIONS`、`NODE_CHANNEL_FD` 和 `NODE_UNIQUE_ID`，并从 `NODE_OPTIONS` 中剥掉 inspect / `vscode` 的 `--require` 标志，使子进程成为普通 Node 进程。在 Windows 上，它按 `PATHEXT` 解析 `node` / `dsh`，在每个 PATH 目录中优先 `.exe`，仅对 `.cmd`/`.bat` shim 使用 `shell: true`；停止时使用 `taskkill /T /F`，以免 `cmd.exe` 包装进程留下仍在运行的 `node`。

扩展在用户 argv 未包含时追加 `--no-open`（webview 即 UI）、`--host 127.0.0.1` 和 `--port`。它会在 command、args 与 cwd 中展开 `${workspaceFolder}`，因为 `workspace.getConfiguration().get()` 不会展开该标记。就绪是以下两者中先发生的：跨 stdout/stderr 分块累积到的 `dsh web: http(s)://…` 行，或绑定的 loopback URL 上 HTTP 成功。`dsh.backend.readyTimeoutMs`（默认 120s，最小 1s）会在超时后以错误结束启动，错误中会写出该 URL 以及是否出现过任何进程输出。

## Alternatives considered

**继续只匹配 stdout，并拉长隐式等待。** 被管道接住、挂起或 `printUrl: false` 的子进程永远不会打印该行，更长的等待仍会让面板停在 Starting。

**在 Windows 上始终 `shell: true`。** 这样能运行 npm shim，但也会把 `node.exe` 包进 `cmd.exe`，使 SIGTERM 打不中孙进程；先解析 `.exe` 再用 `taskkill /T` 杀进程树是更窄的修复。

**把已经在跑的 `dsh web` 当作后端，而不再 spawn。** 扩展拥有生命周期（重启/停止、私有端口、`--no-open`）。去附着会与浏览器标签页共享服务器，并跳过这些命令。

## Consequences

从扩展宿主发起的 `tsx` 源码启动可以在没有 TTY 的情况下变为就绪，静默子进程会失败而不是空转。HTTP 成功可能早于 Loader 结算，因此 iframe 可能在 `/api` 存在之前加载；客户端会重试该传输，这优于无限的 Starting 页。`extensions/vscode/tests/launch.spec.ts` 中的单元测试钉住 argv 构造、环境清理、Windows `.exe` 优先、跨分块 stdout、HTTP 回退、超时、退出与取消。本套件无法覆盖的缺口是：在 Windows 上手动用 Extension Development Host 验证 `node --import tsx/esm` 启动。
