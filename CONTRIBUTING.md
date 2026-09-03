# 贡献指南

感谢参与 `chatgpt-mcp-bridge`。提交改动前请阅读根目录 `AGENTS.md` 和 `SECURITY.md`。

## 开发流程

```bash
corepack enable
pnpm install
pnpm check
pnpm test:coverage
pnpm smoke
```

所有 MCP Tool 必须保持只读，外部输入必须通过 Zod 校验，文件路径必须经过 `PathPolicy`。Git 与 ripgrep 只能通过固定 executable 和参数数组执行，禁止 shell、任意参数透传、网络访问及 workspace 动态切换。

新增或修改功能时必须补充相应的单元测试、集成测试、安全边界测试和文档。请勿在 issue、测试、日志或提交中包含真实 API Key、Token、用户名、绝对路径或私有源码。

安全漏洞请使用 GitHub Security Advisories 私下报告，不要公开披露未修复漏洞。
