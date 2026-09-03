# 开发

环境：Node.js 20+、Corepack、pnpm、Git；ripgrep 推荐但非必需。

```bash
corepack enable
pnpm install
pnpm check
pnpm test:coverage
pnpm smoke
```

测试在系统临时目录动态创建隔离 Git 仓库，不依赖用户项目。新增工具时必须同时添加 Zod 输入/输出、准确 annotations、安全策略测试与文档。Git/rg 必须使用参数数组；命令工具不得接受未经目录配置的 executable 或 shell 字符串。

版本说明先写入 `CHANGELOG.md` 的 `Unreleased`。`pnpm release minor` 会运行检查、生成 release commit 与 annotated tag、发布 npm 并推送标签；标签触发 GitHub Actions，以相同 Changelog 段创建 GitHub Release。
