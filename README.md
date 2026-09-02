# local-code-mcp

`local-code-mcp` 是一个独立、只读的本地代码 MCP Server。它把**单个**本地 Git 工作区的状态、diff、源码和项目指令安全地提供给 ChatGPT、MCP Inspector 或其他 MCP Client，用于 Code Review 与架构分析。

它刻意只有数据面：没有写文件、删除文件、shell、任意 Git 命令、构建、网络访问、浏览器控制、Computer Use、Codex Skill、C2C 或 Agent 编排。它借鉴了 `codex-with-chatgpt` 的只读数据面思路，但为独立实现，不包含“Codex 控制 ChatGPT 网页”等控制面。

## 安装

需要 Node.js 20+、Git，推荐安装 ripgrep。使用 Corepack 与 pnpm：

```bash
corepack enable
pnpm install
pnpm build
pnpm link --global
```

全局安装发布包可用 `pnpm add -g local-code-mcp`。升级用 `pnpm update -g local-code-mcp`，卸载用 `pnpm remove -g local-code-mcp`。

## 启动与开发

将一个实例绑定到任意本地项目（切换项目需停止并以新 workspace 重启）：

```bash
local-code-mcp serve /path/to/project
local-code-mcp serve --workspace /path/to/project --transport http --host 127.0.0.1 --port 8765 --mcp-path /mcp
local-code-mcp serve --workspace /path/to/project --transport stdio
local-code-mcp doctor /path/to/project
local-code-mcp config /path/to/project
```

开发命令：`pnpm dev -- serve .`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:coverage`、`pnpm build`、`pnpm smoke`、`pnpm check`。构建产物位于 `dist/`。

## 使用 MCP Inspector

先启动 HTTP Server，再运行：

```bash
pnpm start -- serve --workspace /path/to/project --transport http
pnpm dlx @modelcontextprotocol/inspector
```

在 Inspector 中连接 `http://127.0.0.1:8765/mcp`。查看未提交修改时先调用 `change_context` 和 `git_status`，再调用三个 scope 的 `git_diff`；Review 当前分支相对 main 时调用 `git_compare`，设置 `base=main`、`head=HEAD`、`mode=merge_base`。

stdio 客户端配置示例：

```json
{
  "mcpServers": {
    "LocalCode": {
      "command": "local-code-mcp",
      "args": ["serve", "--workspace", "/path/to/project", "--transport", "stdio"]
    }
  }
}
```

stdio 模式的 stdout 仅用于 MCP 协议，日志写入 stderr。

## ChatGPT 接入

优先通过 OpenAI Secure MCP Tunnel 将本机的 `http://127.0.0.1:8765/mcp` 安全接入；具体步骤见 [docs/CHATGPT_SETUP.md](docs/CHATGPT_SETUP.md)。ChatGPT Developer Mode、Plugins 或自定义 MCP 入口是否可用取决于账号、workspace 与当前产品界面；本项目不会声称个人 ChatGPT Pro 一定拥有入口。建议先用 MCP Inspector 验证。

不要用无认证隧道或把本地端口裸露到公网。非 loopback bind 必须显式提供 `--allow-public-bind`，并通过 `LOCAL_CODE_MCP_TOKEN` 或 `--auth-token` 配置 Bearer Token。

## Ignore 与敏感文件

在目标 workspace 根目录创建 `.local-code-mcp-ignore`，语法兼容 gitignore。默认跳过 `.git`、依赖、构建产物、IDE 目录和常见大型二进制；强制敏感策略始终优先，不能由 include 规则覆盖。默认阻止 `.env*`、私钥/证书、credentials/secrets 配置、生产配置、service-account、kubeconfig、`.npmrc`、`.netrc` 等。`SecretService.java` 这类普通源码不会只因名称含 Secret 被阻止。

完整安全模型见 [SECURITY.md](SECURITY.md)，工具契约见 [docs/TOOLS.md](docs/TOOLS.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常见问题

- `NOT_A_GIT_REPOSITORY`：确认 `--workspace` 指向 Git 仓库。
- `PATH_BLOCKED` / `SENSITIVE_FILE`：检查默认策略与 `.local-code-mcp-ignore`；强制敏感策略不可关闭。
- 搜索较慢：安装 `rg`；缺少时会使用安全 Node fallback。
- 端口占用：使用 `--port` 更换端口，默认仍为 8765。
- public bind 启动失败：必须同时设置显式许可与至少 16 字符 Token。
- ChatGPT 中看不到入口：先用 Inspector；入口取决于账号、workspace 与产品界面。

Review Prompt 示例见 [examples/review-prompts.md](examples/review-prompts.md)。

## 许可证

MIT。本项目独立实现，没有复制或嵌入参考项目源码。
