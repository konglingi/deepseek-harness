# Agent Note: VS Code extension is a native chat participant over the SDK protocol

Status: implemented

[English](2026-08-22-vscode-native-chat-over-sdk-jsonrpc.md) | 中文

## Problem

在 VS Code webview 中复用 Web UI（[被否决的提案](../../rejected/architecture/2026-08-22-vscode-extension-webview-reuse.zh.md)）换来了功能对等，但代价在编辑器里格外明显。启动 agent（智能体）意味着在第一条提示词之前先启动一个 web 服务器、再把整个由插件组合出的 React 客户端提供出去，而这是 harness 能做的最慢的一件事。最终得到的是编辑器里的一个浏览器：它不知道 VS Code 打开了哪个项目、聚焦在哪个文件、用户选中了什么，也无法在编辑器中打开文件——因为它是一个跨源 iframe，拿不到 `acquireVsCodeApi`。一个首要任务就是在已打开项目上工作的编辑器集成，不应该还要通过应用内的文件夹选择器重新发现该项目。

## Decision

`extensions/vscode` 是一个原生 chat participant（聊天参与者）。它向 VS Code 的 Chat 视图贡献 `@dsh`，把 harness 运行时作为子进程 spawn，并通过 [SDK stdio 协议](../../../../packages/sdk/protocol/README.zh.md) 驱动它。没有 webview、没有 HTTP、没有前端 bundle。

三个部分承载该决策，各自落在拥有它的层。

**harness 以 profile 的形式组合出该传输。** [`@deepseek-ai/dsh-editor-app`](../../../../packages/bundle/editor/README.zh.md) 是一个在 `dsh-base` 之上挂载 [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.zh.md) 的 profile bundle（配置包），因此 `dsh --profile editor` 就是一个在 stdio 上讲该协议、且不启动其他任何东西的完整 harness。它只重述编辑器要改变的内容：编辑器 persona，以及关闭模块重载 HMR。它有意保留 base 的 agent 平面各行——工具、提示词分节、委派后端——因为该组合不挂载 agent preset，而由 SDK 创建的 agent 从全局层读取这些注册。于是扩展所需的一切都是插件组合，而非扩展代码。

**协议获得了取消能力。** `session/cancel` 以 `user` 原因取消会话的活跃驱动并丢弃其待处理的收件箱工作；对运行时未持有 agent 的会话，返回 `{ cancelled: false }`。VS Code 的 Stop 按钮是一等交互，为兑现它而杀掉运行时会丢掉整段对话；正是这个缺口曾让 SDK 不适合交互式客户端。

**扩展拥有编辑器知识。** 它以工作区文件夹作为工作目录启动运行时，并把同一路径作为 `initialize.cwd` 发送，因此文件工具、沙箱策略与 persona 的 `{{cwd}}` 都对准已打开的项目，无需任何选择器。每个请求会把该聊天的附件以及活动编辑器的文件与选区，作为相对于工作区的路径指明，而不是内联内容：运行时用自己的工具按需读取，既不把大文件塞进请求，也让 agent 读到磁盘上的版本。一个聊天对应一个 harness 会话（历史为空则新建），本轮会把该会话的事件流渲染进响应——文本增量作为 markdown、工具调用作为进度行并把触及的文件作为引用附上、`todo_write` 作为清单，取消、触及上限或失败的 `turn/end` 作为收尾一行。

协议是镜像而非导入：`src/jsonrpc.ts` 重述了 Python SDK 同样重述的那些帧，这让扩展保持为一个只以 `vscode` 为 external 的独立 esbuild bundle，也让它留在工作区 TypeScript 聚合与 `packages/*` 各项检查之外。

## Alternatives considered

**保留 iframe 并加一层宿主桥。** 在 iframe 与扩展宿主之间用 postMessage 打开文件、接管工作区。否决：它保留了用户所反对的 web 服务器启动，而每个原生能力都会变成一条私有协议消息，叠在一个本已自带协议的 UI 之上。

**在扩展里用自定义 webview 重建 Web UI 的聊天。** 否决：正是打包的 React 客户端让当前界面变重，而工具卡片与审批的第二套实现会与 `packages/client/ui-*` 漂移，却不拥有其中任何一部分。VS Code 的聊天组件已经能渲染流式 markdown、进度、引用与按钮。

**驱动只面向自动化的 ACP 服务器。** 与此前同样的理由被否决：ACP 只提交助手文本，没有工具活动、会话列表或模式界面，因此基于它的聊天在提示词与答案之间什么都不会显示。

**在扩展宿主内加载 cordis 与插件树。** 否决：harness 是 ESM 并从自己的安装目录解析插件，而扩展宿主加载的是一个 CommonJS bundle；子进程还能把崩溃或挂起的 agent 挡在编辑器进程之外。

**把运行时组合以 `cordis.yml` 的形式放进扩展。** 否决：扩展里的配置文件会引用它在 `.vsix` 中无法解析的插件，而 profile 组合——bundle、用户 patch 层、`--patch` 覆盖——本就是 harness 自己的扩展点。用 profile 能把组合留在用户可覆盖的位置。

**自动放行提权，让 agent 永不被阻塞。** 否决：在协议尚未承载审批请求时，失败即拒绝是安全的答案，而在用户自己的仓库中静默授予提权，恰是这个 seam 存在所要防止的失效。交互式审批需要协议扩展。

## Consequences

启动耗时就只有运行时的插件树，agent 从第一个请求起就在已打开的项目上工作。扩展比它取代的 webview 版本更小：一个进程管理器、一个行协议 peer，以及三个纯模块（提示词组装、事件渲染、会话标识），`extensions/vscode/tests` 无需 VS Code 宿主即可覆盖它们——57 个单元测试覆盖 argv/环境处理、帧关联与超时、事件到聊天的投影、路径附件与会话铸造。

`apps/cli/tests/editor-profile.spec.ts` 以无密钥方式钉住另一半：它从源码启动随附的 profile，并驱动扩展所讲的协议——握手、`session/cancel`、`shutdown`、退出码 0——断言 stdout 只承载了三个响应帧、别无其他，因此挂载了 stdout 日志器的组合会在那里失败，而不是在编辑器里失败。

Web UI 仍然拥有：作为交互的审批、带参数与差异的工具卡片、会话列表与恢复、模型与模式选择器、工作区与目标。聊天界面会报告工具失败与轮次结果，但不提供这些界面；`dsh web` 仍是同一份会话日志之上的全功能客户端。多根窗口绑定到第一个文件夹。

覆盖缺口：没有测试驱动真实的 `vscode.chat` 请求（该 API 需要运行中的编辑器），因此 participant 注册、状态栏与命令接线通过 Extension Development Host 手动验证。SDK 快照套件（`examples/jsonrpc-agent/tests`）没有取消场景：中断一次回放轮次需要该套件提供流中取消的钩子并重新录制 fixture，而取消在回放中落点的时机并不是稳定的期望输出。Python SDK 尚未暴露 `session/cancel`；它镜像该协议，可在出现交互式 Python 消费者时补上该方法。
