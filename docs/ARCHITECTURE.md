# 架构

CLI 将一个 canonical workspace 注入同一套 MCP Tool Registry；stdio 与 Streamable HTTP 复用该注册表。

请求链路：Transport → Zod input schema → Tool → Workspace/Git/Search Service → Path/Ignore/Sensitive Policy → OutputLimiter/CursorService → structuredContent + 简洁 JSON 文本。

`GitRunner` 与 rg runner 只允许固定 executable、参数数组、受限环境、超时和输出上限。`PathPolicy` 是所有正文读取的统一入口。HTTP 层处理 host、Origin、Bearer、速率、并发、请求体和超时。一个进程只持有一个 workspace，不提供动态切换工具。
