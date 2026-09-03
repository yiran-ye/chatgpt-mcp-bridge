# AGENTS.md

- MCP 数据面默认只读；写入和命令能力必须由启动参数显式启用，且不得通过 MCP 调用提权。
- 所有路径必须通过 `PathPolicy`，所有外部输入必须经 Zod 校验。
- Git 与 ripgrep 只能通过参数数组执行，禁止 shell。
- 新功能必须包含安全边界测试。
