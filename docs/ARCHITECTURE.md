# 架构

CLI 将一个 canonical workspace 注入同一套 MCP Tool Registry；stdio 与 Streamable HTTP 复用该注册表。

请求链路：Transport → Zod input schema → Tool → Workspace/Git/Search/Patch/Command Service → Path/Ignore/Sensitive Policy → OutputLimiter/CursorService → structuredContent + 简洁 JSON 文本。

`GitRunner`、rg runner、白名单命令与 `full-access` 命令都使用参数数组和 `shell=false`。`PathPolicy` 是直接文件访问、命令 cwd 及 `full-access` workspace 相对 executable 的统一入口；`MutationCoordinator` 将同一工作区的补丁和命令串行化。MCP handler 的取消信号会贯穿命令服务，HTTP 层还把客户端取消、断连和请求 deadline 转换为进程树终止。HTTP 层同时处理 host、Origin、Bearer、速率、并发和请求体限制。一个进程只持有一个 workspace，不提供动态切换工具。
