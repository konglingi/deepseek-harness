# Agent Note: VS Code extension sanitizes its runtime spawn and bounds readiness

Status: implemented

[English](2026-08-22-vscode-backend-spawn-readiness.md) | 中文

## Problem

将 VS Code 扩展配置为启动工作区 CLI（`node --import tsx/esm apps/cli/src/bin.ts …`）后，即使同一组 argv 在终端里可用，扩展仍会卡在启动阶段。扩展经由 VS Code 扩展宿主 spawn，宿主会把 Electron 调试器与 IPC 环境交给子进程，在 Windows 上把 `node` 解析成 `.cmd` shim；而在没有上界的等待下，一个不产生输出的子进程会永久挂起。

spawn 的卫生与扩展随后与该子进程讲什么协议无关；传输层的决策见 [原生 chat participant](../architecture/2026-08-22-vscode-native-chat-over-sdk-jsonrpc.zh.md)。

## Decision

`extensions/vscode` 启动运行时时管道连接全部 stdio，并设置 `windowsHide`。它会去掉 `ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ASAR`、`VSCODE_INSPECTOR_OPTIONS`、`NODE_CHANNEL_FD` 和 `NODE_UNIQUE_ID`，并从 `NODE_OPTIONS` 中剥掉 inspect / `vscode` 的 `--require` 标志，使子进程成为普通 Node 进程。在 Windows 上，它按 `PATHEXT` 解析 `node` / `dsh`，在每个 PATH 目录中优先 `.exe`，仅对 `.cmd`/`.bat` shim 使用 `shell: true`；停止时使用 `taskkill /T /F`，以免 `cmd.exe` 包装进程留下仍在运行的 `node`。

它会在 command、args 与 cwd 中展开 `${workspaceFolder}`，因为 `workspace.getConfiguration().get()` 不会展开该标记。以 `-` 开头且含空白的 args 数组项会按引号感知规则拆成多个 argv（`--import tsx/esm file.ts "--profile" editor` 变成五项）；含空格的路径项保持原样。就绪即 SDK `initialize` 的应答，上界为 `dsh.runtime.handshakeTimeoutMs`（默认 120s，最小 1s）；启动失败会在运行时 OutputChannel 中写出命令行、解析后的可执行文件与子进程退出码。

## Alternatives considered

**匹配 stdout 上的启动行。** 对被管道接住的子进程来说，日志文本是错误的就绪信号：挂起或安静的进程永远不会打印它，而在 SDK 传输上 stdout 就是协议通道。握手应答既是就绪事实，也证明插件树已完成加载。

**在 Windows 上始终 `shell: true`。** 这样能运行 npm shim，但也会把 `node.exe` 包进 `cmd.exe`，使 SIGTERM 打不中孙进程；先解析 `.exe` 再用 `taskkill /T` 杀进程树是更窄的修复。

**把粘在一起的 args 项直接判为配置错误。** 用户会把 `--import tsx/esm file.ts …` 贴进 Settings 的一个数组项，Node 随即报 `bad option: --import tsx/esm …`。拆分标志片段、保留带空格的路径，既接受这种粘贴，又不会拆坏 `C:\Program Files\…` 脚本路径。

**附着到已在运行的 harness，而不再 spawn。** 扩展拥有生命周期（重启/停止），并且需要子进程自己的 stdio 来承载协议，而任何附着方式都无法提供它。

## Consequences

从扩展宿主发起的 `tsx` 源码启动可以在没有 TTY 的情况下变为就绪，静默子进程会带着退出码失败而不是空转。`extensions/vscode/tests/launch.spec.ts` 中的单元测试钉住 argv 归一化、粘在一起的 `--import` 数组项、环境清理、Windows `.exe` 优先、管道 stdio 选项与超时下界。本套件无法覆盖的缺口是：在 Windows 上手动用 Extension Development Host 验证 `node --import tsx/esm` 启动。
