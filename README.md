# chatgpt-mcp-bridge

> 将 ChatGPT 安全连接到本地 Git 工作区的可控 MCP Bridge。

`chatgpt-mcp-bridge` 默认是只读的本地代码 MCP Server。除 Code Review 与架构分析外，也可以由用户在启动时显式开放单文件补丁或预配置命令；MCP 调用本身不能提升权限。

> **非官方项目声明：** 本项目由社区独立维护，与 OpenAI 无隶属、合作、认证或背书关系。ChatGPT、OpenAI 及相关名称是其各自权利人的商标。

默认模式没有写文件、删除文件、命令执行或网络访问。可写模式仍不提供浏览器控制、Computer Use、Codex Skill、C2C 或 Agent 编排。

## 安装

需要 Node.js 20+、Git，推荐安装 ripgrep。推荐直接从 npm 全局安装：

```bash
npm install --global chatgpt-mcp-bridge
```

安装完成后，可在任意目录运行 `chatgpt-mcp-bridge`。升级到最新版：

```bash
npm install --global chatgpt-mcp-bridge@latest
```

如果需要参与开发或从源码运行，再克隆 GitHub 仓库：

```bash
git clone https://github.com/yiran-ye/chatgpt-mcp-bridge.git
cd chatgpt-mcp-bridge
corepack enable
pnpm install
pnpm build
npm link
```

源码升级使用 `git pull && pnpm install && pnpm build`；移除源码全局链接使用 `npm unlink -g chatgpt-mcp-bridge`。如果已经通过 `pnpm setup` 配置了全局 bin 目录，也可以使用 `pnpm link --global`。

## 启动与开发

将一个实例绑定到任意本地项目（切换项目需停止并以新 workspace 重启）：

```bash
chatgpt-mcp-bridge serve /path/to/project
chatgpt-mcp-bridge serve --workspace /path/to/project --transport http --host 127.0.0.1 --port 8765 --mcp-path /mcp
chatgpt-mcp-bridge serve --workspace /path/to/project --transport stdio
chatgpt-mcp-bridge serve --workspace /path/to/project --transport stdio --access workspace-write
chatgpt-mcp-bridge doctor /path/to/project
chatgpt-mcp-bridge config /path/to/project
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
      "command": "chatgpt-mcp-bridge",
      "args": ["serve", "--workspace", "/path/to/project", "--transport", "stdio"]
    }
  }
}
```

stdio 模式的 stdout 仅用于 MCP 协议，日志写入 stderr。

## 可写与命令模式

`workspace-write` 新增 `apply_patch`，只允许在工作区内创建、更新或删除单个 UTF-8 普通文件。更新与删除必须提交 `read_file` 返回的 `sha256`，敏感文件、ignore 路径、`.git` 和 Bridge 配置始终被拒绝。

`command-exec` 同时开放 `apply_patch` 和 `run_command`。它不接受 shell 字符串，只能运行用户配置中的 executable 与参数数组：

```json
{
  "version": 1,
  "commands": {
    "test": {
      "description": "运行项目测试",
      "executable": "pnpm",
      "fixedArgs": ["test"],
      "allowAdditionalArgs": false,
      "forwardEnv": ["CI"],
      "timeoutMs": 60000,
      "maxOutputBytes": 262144
    }
  }
}
```

配置默认位于 `~/.chatgpt-mcp-bridge/config.json`，也可用 `--config` 指定。

```bash
chatgpt-mcp-bridge serve /path/to/project \
  --transport stdio \
  --access command-exec \
  --config /path/to/config.json
```

命令没有 OS/container 沙箱，会继承当前系统用户的文件与网络权限。即使 Bridge 使用参数数组和工作区 cwd，被允许的程序仍可能修改工作区外文件；只应配置你完全信任的命令。

## ChatGPT 接入

优先通过 OpenAI Secure MCP Tunnel 将本机的 `http://127.0.0.1:8765/mcp` 安全接入；具体步骤见 [docs/CHATGPT_SETUP.md](docs/CHATGPT_SETUP.md)。ChatGPT Developer Mode、Plugins 或自定义 MCP 入口是否可用取决于账号、workspace 与当前产品界面；本项目不会声称个人 ChatGPT Pro 一定拥有入口。建议先用 MCP Inspector 验证。

Tunnel 与具体代码项目解耦：Tunnel 固定指向 `http://127.0.0.1:8765/mcp`，而 `--workspace` 决定当前暴露哪个本地仓库。切换项目时停止并重启 MCP Server 即可，不需要为每个仓库创建 Tunnel。

不要用无认证隧道或把本地端口裸露到公网。只读模式的非 loopback bind 必须显式提供 `--allow-public-bind` 和 Bearer Token；写入/命令模式禁止 public bind。写入/命令模式使用 HTTP 时还必须提供至少 32 字符的 Token。

## Ignore 与敏感文件

在目标 workspace 根目录创建 `.chatgpt-mcp-bridge-ignore`，语法兼容 gitignore。默认跳过 `.git`、依赖、构建产物、IDE 目录和常见大型二进制；强制敏感策略始终优先，不能由 include 规则覆盖。默认阻止 `.env*`、私钥/证书、credentials/secrets 配置、生产配置、service-account、kubeconfig、`.npmrc`、`.netrc` 等。`SecretService.java` 这类普通源码不会只因名称含 Secret 被阻止。

完整安全模型见 [SECURITY.md](SECURITY.md)，工具契约见 [docs/TOOLS.md](docs/TOOLS.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常见问题

- `NOT_A_GIT_REPOSITORY`：确认 `--workspace` 指向 Git 仓库。
- `PATH_BLOCKED` / `SENSITIVE_FILE`：检查默认策略与 `.chatgpt-mcp-bridge-ignore`；强制敏感策略不可关闭。
- 搜索较慢：安装 `rg`；缺少时会使用安全 Node fallback。
- 端口占用：使用 `--port` 更换端口，默认仍为 8765。
- public bind 启动失败：仅只读模式允许，且必须同时设置显式许可与 Token。
- `COMMAND_CONFIG_INVALID`：检查用户级配置是否存在、严格符合 JSON schema 且至少包含一个命令。
- `PATCH_CONFLICT`：文件在读取后已变化，重新调用 `read_file` 获取正文和哈希。
- ChatGPT 中看不到入口：先用 Inspector；入口取决于账号、workspace 与产品界面。

Review Prompt 示例见 [examples/review-prompts.md](examples/review-prompts.md)。

## 许可证

MIT。本项目独立实现，没有复制或嵌入参考项目源码。
