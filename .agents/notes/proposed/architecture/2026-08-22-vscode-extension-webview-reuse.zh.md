# Agent Note: VS Code extension reuses the Web UI over a managed backend

Status: proposed

[English](2026-08-22-vscode-extension-webview-reuse.md) | 中文

## Problem

编辑器是开发者最想使用 Agent 的场景之一，但产品 UI 是一个由插件组合而成的 React 应用，其功能分散在数十个 `packages/client/ui-*` 插件中，由 Cordis 客户端在运行时加载。在 VS Code 中原生重写这套界面会复制整个客户端层，并立即与已发布的 Web UI 产生漂移。我们希望在编辑器内获得功能全量对齐的体验，同时不分叉 UI。

## Proposal

在 [extensions/vscode](../../../../extensions/vscode/README.md) 发布一个 VS Code 扩展，复用现有 Web UI 而非重建。扩展承担两项职责：管理一个本地后端进程，并内嵌 Web UI。

扩展启动 `dsh web`（命令可配置），强制附加 `--host 127.0.0.1` 与 `--port`，并通过匹配进程 stdout 的 `dsh web: http://127.0.0.1:<port>` 行获知绑定 URL。随后打开一个 Webview 编辑器面板，其 `<iframe>` 经 `vscode.env.asExternalUri` 加载该 URL，于是未改动的 Web UI 在 VS Code 内运行，并通过其常规的 HTTP + WebSocket `/api` 传输与后端通信（[契约](../../../../packages/host/apiproxy/src/api/rpc.ts)，浏览器入口 [apps/web/src/main.ts](../../../../apps/web/src/main.ts)）。DeepSeek API Key 通过内嵌的 Models 页录入，因此后端无需凭据即可启动。

该扩展是一个独立打包的交付物：由 esbuild 打成单文件 CommonJS 包、将 `vscode` 外部化，仅为依赖安装而加入 workspace。它被刻意排除在 `tsconfig.host.json`/`tsconfig.client.json` 聚合、`tsdown` lib 流水线、`check-workspace-constraints` 的 globs 以及 `packages/*` 的 publint/coverage/`@deepseek-ai/dsh-*` 门禁之外 —— 参照 `website`：一个拥有独立带外构建的私有 workspace 成员。

## Alternatives considered

- **基于 JSON-RPC SDK 的 VS Code 原生 UI。** 用原生或自建 Webview 重写聊天、工具卡片、审批、会话与设置，由 [packages/sdk](../../../../packages/sdk/README.md) 驱动。首版否决：它会重建整个 `packages/client/ui-*` 层，且 stdio SDK 目前缺少线上审批与中途取消，无法达到对齐。
- **Agent Client Protocol。** 驱动仅供自动化的 ACP 服务器。否决：ACP 仅供自动化、只回传已提交的助手文本，没有会话加载/列举、模型/模式选择、工具卡片或审批，无法支撑完整 UI。
- **由扩展自行托管构建后的前端。** 打包 `apps/web/dist` 并连接到某个 host 的 `/api`。否决：相比把 iframe 指向受管的 `dsh web`（其本就提供该前端与插件包），这样做工作量更大且无对齐收益。
- **将扩展放在 `packages/` 或 `apps/` 下。** 否决：`packages/extensions/` 已表示 Cordis 动态插件包，而 `apps/*` 发布成员带有 publint/版本/发布策略。顶层 `extensions/` 目录标示编辑器集成边界，且不继承这些门禁。

## Acceptance criteria

扩展经 esbuild 构建为 `dist/extension.js`，并在其自身 tsconfig 下通过类型检查。激活后启动 `dsh web`，面板内嵌一个可达后端的实时 Web UI（真实提示能往返并渲染）。加入新 workspace 成员后，`pnpm install`、`knip` 与 `check-workspace-constraints` 仍通过。打包产出 `.vsix`。

## Risks

在 Remote/Codespaces 下，`asExternalUri` 会改写 host，后端的 loopback 信任围栏在未提供匹配的 `--trusted-host` 前会拒绝；首版面向本地桌面，并在文档中标注远程注意事项。以 iframe 复用 Web UI 带来对齐，但 VS Code 原生集成有限（例如工具 diff 未映射到原生 diff 视图），留待后续迭代。将整套 UI 内嵌于 iframe，使扩展耦合于 Web UI 的 CSP 与同源传输假设，而这些假设对扩展所启动的 loopback 后端成立。
