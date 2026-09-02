# 开发

环境：Node.js 20+、Corepack、pnpm、Git；ripgrep 推荐但非必需。

```bash
corepack enable
pnpm install
pnpm check
pnpm test:coverage
pnpm smoke
```

测试在系统临时目录动态创建隔离 Git 仓库，不依赖用户项目。新增工具时必须同时添加 Zod 输入/输出、只读 annotations、安全策略测试与文档。不得引入 shell、任意 Git/rg 参数、网络请求或 workspace 动态切换。
