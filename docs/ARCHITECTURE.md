# 架构

CLI 将一个 canonical workspace 注入同一套 MCP Tool Registry；stdio 与 Streamable HTTP 复用该注册表。

工具注册先进入统一 `ToolCatalog`，通过 SDK 的 `tools/list` 和 `tools/call` 发布。内置工具继续使用原有 Zod schema 与服务层。`registerMcpGateway` 始终注册三个固定入口，上游原始 JSON Schema 仅作为 `mcp_list_tools` 的查询结果返回；调用时额外使用隔离的 Ajv 编译器校验。运行时按服务 ID 和原始工具名称分层索引，目录分页游标绑定服务及当前目录。

CLI 在启动时读取一次项目 MCP 配置；非空有效配置自动创建 `McpProxyRuntime`，通过 `BridgeOptions.mcpProxy` 注入，无需 `--enable-mcp`。配置缺失或服务列表为空时不创建运行时，但固定网关仍注册。运行时为各上游建立持久的 stdio/Streamable HTTP Client，固定发现的工具和路由，供同一 HTTP 服务的全部请求复用。单次请求关闭 `McpServer` 不会关闭上游；服务关闭时统一释放运行时。配置及启动路径先完成 Zod/PathPolicy 校验，HTTP 强认证检查使用同一配置快照，并先于上游进程启动。`config`/`doctor` 仅做本地校验和摘要，不创建运行时。

Bridge 使用 SDK 的 Web Standard Transport 生成响应，由 Bridge 统一写入 Node HTTP 响应。无状态 POST 使用 JSON 响应模式，收到工具结果后才发送响应头；deadline 先返回 HTTP 408 再取消工具，迟到结果会丢弃，避免 SDK 再次写入已结束的响应。GET SSE 使用独立连接配额和支持背压、取消的流转发，不占用普通请求并发槽位。握手仍受请求 deadline 限制，成功建立 SSE 后取消该定时器；客户端断连或服务关闭会结束响应并释放连接名额和传输。HTTP 上游仍同时支持 JSON 和 SSE 响应。

请求链路：Transport → Zod input schema → Tool → Workspace/Git/Search/Patch/Attachment/Command Service → Path/Ignore/Sensitive Policy → OutputLimiter/CursorService → structuredContent + 简洁 JSON 文本。

`GitRunner`、rg runner、白名单命令与 `full-access` 命令都使用参数数组和 `shell=false`。`PathPolicy` 是直接文件访问、命令 cwd 及 `full-access` workspace 相对 executable 的统一入口；`MutationCoordinator` 将同一工作区的补丁、附件保存和命令串行化。MCP handler 的取消信号会贯穿命令服务，HTTP 层还把客户端取消、断连和请求 deadline 转换为进程树终止。HTTP 层同时处理 host、Origin、Bearer、速率、并发和请求体限制。一个进程只持有一个 workspace，不提供动态切换工具。

`save_attachment` 经 `ToolCatalog` 发布官方文件参数 schema 和 `_meta`。附件服务校验目标后，使用独立的公网 HTTPS 下载器获取限额字节流，经同目录临时文件原子创建目标。下载器仅在同次验证的 DNS 地址内进行连接失败回退且逐跳检查重定向；文件服务复查目标路径与临时文件身份。HTTP 生命周期和 stdio 关闭信号均传入附件服务，提交前取消不会发布目标；临时文件同步、关闭并复查路径后进入不可取消的原子提交，服务等待实际结果，HTTP deadline 或断连仍可能丢弃返回结果。
