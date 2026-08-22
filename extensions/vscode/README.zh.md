# DeepSeek Harness for VS Code

[English](README.md) | 中文

在 VS Code 中运行 [DeepSeek Harness](../../README.md) Agent。扩展会启动并管理一个本地 `dsh web` 后端，并在编辑器面板中内嵌完整的 Harness Web UI（聊天、工具卡片、审批、工作区、会话、模型/密钥、子代理、目标、计划模式、设置）——即 `dsh web` 所提供的同一套 UI，原样复用。

## 工作原理

1. 激活时，扩展通过运行所配置的命令（默认 `dsh web`）启动后端，并追加 `--host 127.0.0.1` 与一个 `--port`。
2. 它解析后端输出的 `dsh web: http://127.0.0.1:<port>` 行以获知 URL。
3. **Open DeepSeek Harness** 操作会打开一个 Webview 面板，其 iframe 通过 `vscode.env.asExternalUri` 加载该 URL，于是整套 Web UI 在 VS Code 内运行，并通过其常规的 HTTP + WebSocket `/api` 传输与后端通信。

DeepSeek API Key 在内嵌的 **Models** 页中录入，与浏览器 Web UI 完全一致；启动后端本身无需密钥。

## 命令

- `DeepSeek Harness: Open Panel`
- `DeepSeek Harness: Restart Backend`
- `DeepSeek Harness: Stop Backend`
- `DeepSeek Harness: Show Backend Logs`

## 设置

- `dsh.backend.command`（默认 `dsh`）：后端可执行文件。需在 `PATH` 中，或指向一个启动器（见下文）。
- `dsh.backend.args`（默认 `["web"]`）：传入的参数；必须启动 `web` 服务。`--host`/`--port` 会自动追加。
- `dsh.backend.port`（默认 `0`）：`0` 表示自动选择空闲端口。
- `dsh.backend.autoStart`（默认 `true`）：激活时自动启动后端。
- `dsh.backend.cwd`（默认取第一个工作区文件夹）：后端工作目录。
- `dsh.backend.env`：后端的额外环境变量（例如 `DEEPSEEK_BASE_URL`）。

## 在 deepseek-harness monorepo 中开发

默认的 `dsh` 命令假定 `PATH` 中已安装 CLI。当针对本仓库开发时，先构建 CLI（`pnpm run build`），然后在 `.vscode/settings.json` 中把扩展指向工作区构建产物：

```json
{
  "dsh.backend.command": "node",
  "dsh.backend.args": ["${workspaceFolder}/apps/cli/lib/bin.js", "web"]
}
```

（VS Code 不会在这些字符串设置中展开 `${workspaceFolder}`；请使用绝对路径，或把 `dsh.backend.cwd` 设为仓库根目录并使用相对的 `apps/cli/lib/bin.js`。）

## 构建

```sh
pnpm install
pnpm --filter dsh-vscode run build     # esbuild -> dist/extension.js
pnpm --filter dsh-vscode run package    # produces dsh-vscode.vsix (via npx @vscode/vsce)
```

在该目录中按 `F5` 可启动用于手动测试的 Extension Development Host。

## 远程 / Codespaces

在 Remote-SSH、Dev Containers 或 Codespaces 下，`asExternalUri` 会把 loopback 端口转发到一个生成的外部 host。由于后端启用了 loopback 信任围栏，请通过 `dsh.backend.args` 为该 host 传入匹配的 `--trusted-host`。本地（桌面）使用无需额外配置。
