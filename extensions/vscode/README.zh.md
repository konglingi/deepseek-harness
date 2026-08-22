# DeepSeek Harness for VS Code

[English](README.md) | 中文

在 VS Code 中运行 [DeepSeek Harness](../../README.zh.md) Agent（智能体），以原生 chat participant（聊天参与者）的形式面向你已打开的项目工作。扩展管理一个本地 harness 运行时进程，并在 VS Code 自带的 Chat 视图中作答：输入 `@dsh` 提问即可。没有内嵌 web 应用——没有浏览器、没有 webview、没有 HTTP 服务器——因此运行时在其插件树完成加载后即可用，响应也以 VS Code 自己的聊天组件渲染。

## 工作原理

1. 激活时，扩展以编辑器项目目录为工作目录，spawn 所配置的运行时命令（默认 `dsh --profile editor`）。[`editor` profile](../../packages/bundle/editor/README.zh.md) 就是为在 stdio 上提供 [SDK 协议](../../packages/sdk/protocol/README.zh.md) 而组合出的 harness。
2. 扩展执行 SDK `initialize` 握手，把同一目录作为 `cwd`、连同所配置的提供方与模型一起发送。握手得到应答**即**就绪；它同时证明运行时的插件树已完成加载。
3. 每个 `@dsh` 请求会在该聊天对应的会话上排入一条提示词，并把该会话的事件流渲染进响应：助手文本以 markdown 流式输出，每次工具调用成为一行进度，工具触及的文件作为引用附上，`todo_write` 渲染为清单，轮次失败或触及上限也会说明。会话的 agent 报告 idle 时，本轮结束。
4. VS Code 的 Stop 按钮会在运行时中取消该轮（`session/cancel`），而不是丢弃它，因此会话对下一次请求仍然可用。

每个聊天对应一个 harness 会话：没有历史的聊天开启新会话，该聊天中之后的每个请求都延续它，这正是 agent 拥有该对话历史的原因。**DeepSeek Harness: New Session** 会强制下一个请求使用全新会话。

## Agent 能看到你项目的哪些内容

运行时的工作目录就是你打开的项目，因此它的文件、搜索与 shell 工具都作用于该项目——即编辑器展示的同一批文件。

每个请求还会以路径形式额外指明：

- 附加到聊天请求的每个文件或选区（`#file:` 之类），形式为 `path` 或 `path:start-end`
- 活动编辑器中打开的文件，及其被选中的行范围

传递的是路径而非文件内容：运行时用自己的工具按需读取，这样既不会把大文件塞进请求，也让 agent 读到磁盘上的版本。只要文件位于工作区文件夹内，路径就相对于工作区。

## 命令

- `DeepSeek Harness: New Session`
- `DeepSeek Harness: Restart Runtime`
- `DeepSeek Harness: Stop Runtime`
- `DeepSeek Harness: Show Runtime Logs`

## 设置

- `dsh.runtime.command`（默认 `dsh`）：运行时可执行文件。需在 `PATH` 中，或指向一个启动器。`${workspaceFolder}` 会展开为第一个工作区文件夹。
- `dsh.runtime.args`（默认 `["--profile", "editor"]`）：传入的参数；必须启动一个在 stdio 上提供 SDK 协议的运行时。每个标志与值应各自占一个数组项。以 `-` 开头且含空格的项（例如 `--import tsx/esm file.ts --profile editor`）会被拆分；含空格的路径不会。每个参数中的 `${workspaceFolder}` 会展开。
- `dsh.runtime.autoStart`（默认 `true`）：激活时即启动运行时，而不是等到首个请求。
- `dsh.runtime.cwd`（默认取第一个工作区文件夹）：运行时的工作目录，也就是其工具与沙箱策略解析所依据的工作区。`${workspaceFolder}` 会展开。
- `dsh.runtime.handshakeTimeoutMs`（默认 `120000`）：等待 `initialize` 的时间，超时后报启动失败。
- `dsh.runtime.env`：运行时的额外环境变量，例如 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_BASE_URL`。
- `dsh.model.provider`（默认 `deepseek-official`）与 `dsh.model.name`（默认 `deepseek-v4-flash`）：每个会话运行所用的路由。

API Key 属于运行时而非扩展的职责：运行时从其环境（包括 `dsh.runtime.env` 与项目 `.env`）读取 `DEEPSEEK_API_KEY`，或读取它在 `$DSH_HOME` 下管理的凭据。

spawn 会从扩展宿主环境中去掉 Electron/VS Code 调试器与 IPC 变量，使子 Node 成为普通进程。在 Windows 上，若存在 `node.exe` 则优先于 `node` / `dsh` 的 `.cmd` shim；只有 shim 时才经 `cmd.exe` 运行。

## 在 deepseek-harness monorepo 中开发

默认的 `dsh` 命令假定 `PATH` 中已安装 CLI。当针对本仓库开发时，先构建 CLI（`pnpm run build`），然后在 `.vscode/settings.json` 中把扩展指向工作区构建产物：

```json
{
  "dsh.runtime.command": "node",
  "dsh.runtime.args": ["${workspaceFolder}/apps/cli/lib/bin.js", "--profile", "editor"],
  "dsh.runtime.cwd": "${workspaceFolder}"
}
```

若要从 TypeScript 源码经 `tsx` 启动（而非已构建的 `lib/`）：

```json
{
  "dsh.runtime.command": "node",
  "dsh.runtime.args": [
    "--import", "tsx/esm", "${workspaceFolder}/apps/cli/src/bin.ts", "--profile", "editor"
  ],
  "dsh.runtime.cwd": "${workspaceFolder}"
}
```

单个数组项 `--import tsx/esm …/bin.ts --profile editor` 也会被拆成上述 token。

若源码启动较慢，请提高 `dsh.runtime.handshakeTimeoutMs`。当某个请求报告启动失败时，使用 **Show Runtime Logs**：日志中包含完整命令行、解析后的可执行文件、运行时的 stderr 及其退出码。

## 构建

```sh
pnpm install
pnpm --filter dsh-vscode run build     # esbuild -> dist/extension.js
pnpm --filter dsh-vscode run package    # produces dsh-vscode.vsix (via npx @vscode/vsce)
```

在该目录中按 `F5` 可启动用于手动测试的 Extension Development Host。

## 局限

- **审批不可交互。** SDK 协议不承载审批请求，因此需要提权的操作会被运行时的失败即拒绝策略拒绝；聊天中会报告该工具失败。在默认的 `workspace-write` 沙箱下，工作区内的写入无需审批。
- **工具结果是概要而非卡片。** 一次工具调用渲染为一行进度加文件引用；完整参数、差异与输出保留在会话日志中，Web UI（`dsh web`）仍会完整渲染它们。
- **单个工作区文件夹。** 运行时按第一个工作区文件夹启动；多根窗口中的路径都以它为基准发送与解析。
- **会话按聊天、按窗口存在。** 运行时在退出前保留会话；扩展不列出也不恢复更早的会话。
