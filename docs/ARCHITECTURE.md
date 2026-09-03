# 架构

CLI 将一个 canonical workspace 注入同一套 MCP Tool Registry；stdio 与 Streamable HTTP 复用该注册表。

请求链路：Transport → Zod input schema → Tool → Workspace/Git/Search/Patch/Command Service → Path/Ignore/Sensitive Policy → OutputLimiter/CursorService → structuredContent + 简洁 JSON 文本。

`GitRunner`、rg runner 与 `CommandService` 都使用参数数组和 `shell=false`。`PathPolicy` 是直接文件访问及命令 cwd 的统一入口；`MutationCoordinator` 将同一工作区的补丁和命令串行化。HTTP 层处理 host、Origin、Bearer、速率、并发、请求体和超时。一个进程只持有一个 workspace，不提供动态切换工具。
