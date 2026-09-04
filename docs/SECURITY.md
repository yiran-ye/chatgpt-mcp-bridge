# 安全设计细节

根目录 [SECURITY.md](../SECURITY.md) 是规范入口。本文件补充实现约束：游标绑定工具类型、请求摘要和位置，HMAC 密钥只存在于进程内，因此重启后旧游标失效；文件限制默认 1 MiB，diff 单页默认 64 KiB、硬上限 128 KiB；目录深度上限 3；读取行数上限 500；搜索结果上限 100。

直接写入的 patch 上限 256 KiB、结果文件上限 1 MiB。`command-exec` 默认使用目录配置的超时和输出上限；`full-access` 默认超时 60 秒、stdout/stderr 合计上限 256 KiB，并允许调用方在硬边界内下调或上调。两种模式的硬超时均为 10 分钟、stdout/stderr 合计硬上限均为 1 MiB；附加参数最多 64 个且单项最多 4096 字节。命令配置最大 64 KiB，未知字段会被拒绝。项目级 `.chatgpt-mcp-bridge/config.json` 只允许 Bridge 控制面加载，MCP 文件读取与写入工具不能访问或修改它。

`full-access` 不加载命令配置，直接 executable 输入由严格 Zod schema 校验。PATH 程序名之外的 executable 和 cwd 必须经过 `PathPolicy`；执行仍使用参数数组与 `shell=false`，子进程仅获得最小环境。Windows 额外保留非敏感的 `PATHEXT` 与 `SystemDrive`，以维持系统组件和子程序查找兼容性。

命令执行器监听 MCP 与 HTTP 请求取消信号，并与自身 timeout 共用进程树终止逻辑。HTTP 请求 deadline 默认 30 秒，因此 HTTP 命令的有效上限不会因工具参数或命令配置中的更长 timeout 而延长；失联命令不会继续持有 `MutationCoordinator`。

在 Windows 上创建 symlink 通常需要额外权限，因此相关测试可按平台条件跳过；macOS/Linux 完整测试该边界。
