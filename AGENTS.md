# AGENTS.md

- 保持 MCP 数据面严格只读。
- 所有路径必须通过 `PathPolicy`，所有外部输入必须经 Zod 校验。
- Git 与 ripgrep 只能通过参数数组执行，禁止 shell。
- 新功能必须包含安全边界测试。
