# 安全设计细节

根目录 [SECURITY.md](../SECURITY.md) 是规范入口。本文件补充实现约束：游标绑定工具类型、请求摘要和位置，HMAC 密钥只存在于进程内，因此重启后旧游标失效；文件限制默认 1 MiB，diff 单页默认 64 KiB、硬上限 128 KiB；目录深度上限 3；读取行数上限 500；搜索结果上限 100。

直接写入的 patch 上限 256 KiB、结果文件上限 1 MiB。`command-exec` 默认使用目录配置的超时和输出上限；`full-access` 默认超时 60 秒、stdout/stderr 合计上限 256 KiB，并允许调用方在硬边界内下调或上调。两种模式的硬超时均为 10 分钟、stdout/stderr 合计硬上限均为 1 MiB；附加参数最多 64 个且单项最多 4096 字节。命令配置最大 64 KiB，未知字段会被拒绝。项目级 `.chatgpt-mcp-bridge/config.json` 只允许 Bridge 控制面加载，MCP 文件读取与写入工具不能访问或修改它。

`full-access` 不加载命令配置，直接 executable 输入由严格 Zod schema 校验。PATH 程序名之外的 executable 和 cwd 必须经过 `PathPolicy`；执行仍使用参数数组与 `shell=false`，子进程仅获得最小环境。Windows 额外保留非敏感的 `PATHEXT` 与 `SystemDrive`，以维持系统组件和子程序查找兼容性。

命令执行器监听 MCP 与 HTTP 请求取消信号，并与自身 timeout 共用进程树终止逻辑。HTTP 请求 deadline 默认 30 秒，因此 HTTP 命令的有效上限不会因工具参数或命令配置中的更长 timeout 而延长；失联命令不会继续持有 `MutationCoordinator`。

在 Windows 上创建 symlink 通常需要额外权限，因此相关测试可按平台条件跳过；macOS/Linux 完整测试该边界。

MCP 代理配置 `.chatgpt-mcp-bridge/mcp.json` 与命令配置独立，最大 64 KiB、最多 16 个服务。普通 MCP 文件读写工具仍无法访问该目录。CLI 根据非空有效配置自动启用上游访问，无需启动开关；嵌入方显式创建并传入 `McpProxyRuntime`。配置只读取一次，HTTP 强认证检查和运行时使用同一配置快照，检查早于上游启动。

固定网关不在输入 Schema 中枚举服务或工具，不接受任意 URL、命令或新增服务。`mcp_list_tools` 每页最多 100 项，完整结果最多 1 MiB；游标签名绑定工作区、服务和目录内容。未知服务或工具、无效参数不会转发。

上游目录每服务最多 256 个工具、总计 1 MiB；Schema 单项最多 256 KiB、深度最多 64、禁止外部引用和异步校验。Schema 编译器相互隔离，防止同一个 `$id` 在不同工具间复用错误校验器。stdio 单消息和 HTTP JSON 响应/SSE 单事件上限为 1 MiB 加 64 KiB 协议余量，工具参数和结果本身各限 1 MiB。上游发现总时限 10 秒，调用时限 30 秒、并发上限 32，客户端不能上调。

HTTP 上游请求只发送至启动时配置的确切地址，禁用重定向；上游不能要求 Bridge 再去其他地址登录或解析 Schema。上游没有被赋予 Sampling、Elicitation、Roots 或动态配置能力。本地上游进程使用参数数组、`shell=false`，在退出、启动中断或连接故障时清理进程树。

工作区内部符号链接使用规范化目标的文件类型、大小及 inode；链接路径和最终目标均经过敏感路径、Bridge 配置及 ignore 检查。越界或悬空链接继续拒绝。上游 stdio 允许空行及仅含空格、制表符、回车的行，但仍先检查原始消息字节上限；非 JSON 日志、非法 JSON-RPC 和无效 UTF-8 继续关闭连接。

HTTP 普通请求由 `HttpOptions.maxConcurrent` 限制（默认 16）；GET SSE 使用独立的 `HttpOptions.maxSseConnections`（默认 16，必须为正整数），包含正在握手的 GET。SSE 配额满时仅拒绝新的 GET，返回 HTTP 503，不占用 POST 的并发预算。成功建立的 SSE 不受普通请求 deadline 限制，仍保留认证、Origin、请求速率限制、断连取消和服务关闭清理；未成功建立的握手继续受 deadline 限制。
