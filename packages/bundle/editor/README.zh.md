# `@deepseek-ai/dsh-editor-app`

[English](README.md) | 中文

以 profile bundle（配置包）形式提供的编辑器界面：[`cordis.patch.yml`](cordis.patch.yml) 把 [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.zh.md) 挂载到 [`dsh-base`](../base/README.zh.md) 层之上，因此 `dsh --profile editor` 是一个只在 stdio 上讲 [SDK 协议](../../sdk/protocol/README.zh.md) 的 harness 运行时。它的客户端是编辑器扩展——[`extensions/vscode`](../../../extensions/vscode/README.zh.md) 是随附的那一个——由扩展启动该运行时、驱动轮次，并把会话事件流渲染到编辑器自带的聊天 UI 中。此包没有运行时 API；profile 组合器通过 `dsh.bundle.patch` 清单字段解析该 patch，而非通过代码。

`dsh --profile editor` 不启动 HTTP 服务器、不提供前端、也不挂载终端 UI，因此其插件树完成加载后即达到就绪。stdout 只承载 JSON-RPC 帧；诊断信息应走 stderr，而添加 stdout 日志器的 profile 层会破坏协议通道。

base 的 agent（智能体）平面各行保持挂载。[`dsh-web-app`](../web-app/README.zh.md) 会把工具、提示词分节与委派后端移到按会话的 agent preset 之后，而此 bundle 不挂载 preset 名册：SDK 服务器创建的 agent 从全局层读取这些注册，因此在此处禁用某一行会让每个编辑器会话都失去该能力。本层只重述编辑器要改变的内容——persona，以及被禁用的模块重载行。

工作区绑定属于客户端：扩展以编辑器项目目录作为工作目录启动运行时，并把同一路径作为 `initialize.cwd` 发送，文件工具、沙箱策略与 persona 中的 `{{cwd}}` 都以它为基准解析。

## Model Experience

### 编辑器界面 persona

#### What the model sees

`system-prompt` 的 persona 声明该 agent 运行在用户的编辑器内、位于 `{{cwd}}` 的项目上，用户在编辑器的聊天视图中跟随其进展，且它读写的文件就是该编辑器中打开的文件。此处不贡献其他分节、工具或 schema；这些全部归属 base 层插入的相应行。

#### Token effect

每个会话一段 persona 段落，在进程内保持恒定。

#### KV Cache effect

persona 位于系统提示词开头，且在进程生命周期内固定，因此不会跨轮次失效缓存。

## Known Limitations and Deferred Work

- **审批失败即拒绝**——base 的 `ask` 策略在此传输上没有应答者，因为 SDK 协议不承载审批请求；需要提权的操作会被拒绝，并表现为 `approval/asked` 与 `approval/decided` 审计事件。交互式审批需要协议扩展，而不是在此处改配置。
- **patch 替换整行 config**——profile 覆盖必须重述该行保留的每个字段；不存在深度合并层。
- **该 profile 不接受应用参数**——组合出的插件树不解析 argv，因此 `dsh --profile editor <args>` 会忽略启动器标志之后的一切。
