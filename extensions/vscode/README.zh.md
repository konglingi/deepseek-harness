# DeepSeek Harness for VS Code

[English](README.md) | 中文

在 VS Code 中运行 [DeepSeek Harness](../../README.zh.md) Agent。扩展会启动并管理一个本地 `dsh web` 后端，并在编辑器面板中内嵌完整的 Harness Web UI（聊天、工具卡片、审批、工作区、会话、模型/密钥、子代理、目标、计划模式、设置）——即 `dsh web` 所提供的同一套 UI，原样复用。

## 工作原理

1. 激活时，扩展通过运行所配置的命令（默认 `dsh web`）启动后端，并追加 `--no-open`、`--host 127.0.0.1` 与一个 `--port`。
2. 当 stdout 打印 `dsh web: http://127.0.0.1:<port>`，或该 loopback 端口开始接受 HTTP 时（以先发生者为准），扩展将后端视为就绪；若在 `dsh.backend.readyTimeoutMs` 内两者都未发生，则报启动失败。
3. **Open DeepSeek Harness** 操作会打开一个 Webview 面板，其 iframe 通过 `vscode.env.asExternalUri` 加载该 URL，于是整套 Web UI 在 VS Code 内运行，并通过其常规的 HTTP + WebSocket `/api` 传输与后端通信。

DeepSeek API Key 在内嵌的 **Models** 页中录入，与浏览器 Web UI 完全一致；启动后端本身无需密钥。

## 命令

- `DeepSeek Harness: Open Panel`
- `DeepSeek Harness: Restart Backend`
- `DeepSeek Harness: Stop Backend`
- `DeepSeek Harness: Show Backend Logs`

## 设置

- `dsh.backend.command`（默认 `dsh`）：后端可执行文件。需在 `PATH` 中，或指向一个启动器。`${workspaceFolder}` 会展开为第一个工作区文件夹。
- `dsh.backend.args`（默认 `["web"]`）：传入的参数；必须启动 `web` 服务。`--no-open`/`--host`/`--port` 会自动追加。每个参数中的 `${workspaceFolder}` 会展开。
- `dsh.backend.port`（默认 `0`）：`0` 表示自动选择空闲端口。
- `dsh.backend.autoStart`（默认 `true`）：激活时自动启动后端。
- `dsh.backend.cwd`（默认取第一个工作区文件夹）：后端工作目录。`${workspaceFolder}` 会展开。
- `dsh.backend.readyTimeoutMs`（默认 `120000`）：等待 `dsh web:` URL 或 HTTP 就绪的时间，超时后报启动失败。
- `dsh.backend.env`：后端的额外环境变量（例如 `DEEPSEEK_BASE_URL`）。

spawn 会从扩展宿主环境中去掉 Electron/VS Code 调试器与 IPC 变量，使子 Node 成为普通进程。在 Windows 上，若存在 `node.exe` 则优先于 `node` / `dsh` 的 `.cmd` shim；只有 shim 时才经 `cmd.exe` 运行。

## 在 deepseek-harness monorepo 中开发

默认的 `dsh` 命令假定 `PATH` 中已安装 CLI。当针对本仓库开发时，先构建 CLI（`pnpm run build`），然后在 `.vscode/settings.json` 中把扩展指向工作区构建产物：

```json
{
  "dsh.backend.command": "node",
  "dsh.backend.args": ["${workspaceFolder}/apps/cli/lib/bin.js", "web"],
  "dsh.backend.cwd": "${workspaceFolder}"
}
```

若要从 TypeScript 源码经 `tsx` 启动（而非已构建的 `lib/`）：

```json
{
  "dsh.backend.command": "node",
  "dsh.backend.args": ["--import", "tsx/esm", "${workspaceFolder}/apps/cli/src/bin.ts", "web"],
  "dsh.backend.cwd": "${workspaceFolder}"
}
```

若源码启动较慢，请提高 `dsh.backend.readyTimeoutMs`。面板一直停在启动页时，使用 **Show Backend Logs**：超时且无进程输出表示子进程从未跑起来；出现 `dsh web:` 行或 HTTP 绑定后，面板应离开该页。

## 构建

```sh
pnpm install
pnpm --filter dsh-vscode run build     # esbuild -> dist/extension.js
pnpm --filter dsh-vscode run package    # produces dsh-vscode.vsix (via npx @vscode/vsce)
```

在该目录中按 `F5` 可启动用于手动测试的 Extension Development Host。

## 远程 / Codespaces

在 Remote-SSH、Dev Containers 或 Codespaces 下，`asExternalUri` 会把 loopback 端口转发到一个生成的外部 host。由于后端启用了 loopback 信任围栏，请通过 `dsh.backend.args` 为该 host 传入匹配的 `--trusted-host`。本地（桌面）使用无需额外配置。
