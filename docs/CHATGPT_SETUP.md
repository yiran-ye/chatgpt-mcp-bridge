# ChatGPT 接入

## 推荐流程：OpenAI Secure MCP Tunnel

Tunnel 是通用的 MCP 入口，不绑定某个 Git 仓库。`--workspace` 才决定当前读取的项目，所以切换项目时只需重启本地 MCP Server。

### 1. 启动本地 MCP

```bash
chatgpt-mcp-bridge serve \
  --workspace /path/to/project \
  --transport http \
  --host 127.0.0.1 \
  --port 8765
```

健康检查：`curl http://127.0.0.1:8765/health`。也可先用 MCP Inspector 验证 `http://127.0.0.1:8765/mcp` 的 initialize、tools/list 和 tools/call。

### 2. 创建通用 Tunnel

在 OpenAI Platform 的 Tunnels 页面创建一个名为 `chatgpt-mcp-bridge` 的 Tunnel，并授权给需要使用它的 ChatGPT workspace。创建仅含 `Tunnels: Use` 权限的 Restricted Runtime API Key；不要使用 Admin Key 运行长期进程，也不要把 Key 写入仓库。

OpenAI 官方说明见 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。Tunnel 支持本地 stdio 或私有 HTTP MCP；对于写入/命令模式，推荐 stdio，使本地服务无需开放 HTTP 监听端口。

### 3. 初始化 tunnel-client

将创建好的 Restricted Runtime API Key 复制出来，并把下面的
`YOUR_RUNTIME_API_KEY` 替换成真实 Key。该环境变量只在当前终端窗口中有效；
关闭终端后需要重新设置。不要把 Key 写进仓库、脚本或提交记录。

```bash
export CONTROL_PLANE_API_KEY='YOUR_RUNTIME_API_KEY'

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile chatgpt-mcp-bridge \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-server-url http://127.0.0.1:8765/mcp \
  --health-listen-addr 127.0.0.1:8080

tunnel-client doctor --profile chatgpt-mcp-bridge --explain
tunnel-client run --profile chatgpt-mcp-bridge
```

写入模式的 stdio profile 示例：

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile chatgpt-mcp-bridge-write \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "chatgpt-mcp-bridge serve --workspace /path/to/project --transport stdio --access workspace-write"

tunnel-client doctor --profile chatgpt-mcp-bridge-write --explain
tunnel-client run --profile chatgpt-mcp-bridge-write
```

`command-exec` 在 `--mcp-command` 中加入 `--access command-exec`。配置会优先读取项目根目录的 `.chatgpt-mcp-bridge/config.json`，不存在时回退到全局 `~/.chatgpt-mcp-bridge/config.json`；也可以通过 `--config /absolute/path/config.json` 显式覆盖。

例如，假设复制到的 Key 是 `example-runtime-key`，对应命令就是
`export CONTROL_PLANE_API_KEY='example-runtime-key'`。单引号需要保留，但不要保留
`YOUR_RUNTIME_API_KEY` 这个占位文字。执行命令后可用下面的命令确认变量已设置；
它只显示是否成功，不会打印 Key：

```bash
test -n "$CONTROL_PLANE_API_KEY" && echo "API Key 已设置"
```

如果使用 macOS，并希望以后不再重复粘贴 Key，可以先将它保存到系统钥匙串。
执行下面的命令后，终端会等待输入；粘贴 Key 并按回车，输入内容不会显示在屏幕上：

```bash
read -s "RUNTIME_KEY?请粘贴 Runtime API Key，然后按回车："
echo
security add-generic-password \
  -a "$USER" \
  -s "chatgpt-mcp-bridge-tunnel" \
  -w "$RUNTIME_KEY" \
  -U
unset RUNTIME_KEY
```

以后打开新终端时，再用下面的命令从钥匙串读取 Key：

```bash
export CONTROL_PLANE_API_KEY="$(security find-generic-password \
  -a "$USER" \
  -s "chatgpt-mcp-bridge-tunnel" \
  -w)"
```

Windows 或 Linux 用户可以使用系统 Secret Manager，或者每次只在当前终端中执行
前面的 `export` 命令。`tunnel-client run` 和本地 MCP Server 在 ChatGPT 使用期间都必须保持运行。

### 4. 在 ChatGPT 创建连接

在可用的 ChatGPT Plugins/Connectors 入口创建插件，连接方式选择 Tunnel，选择 `chatgpt-mcp-bridge`，身份验证选择“无身份验证”，建议将插件命名为 `LocalCode`。本地服务没有 OAuth；Tunnel 负责从 OpenAI 控制面到本机 MCP 的连接。

Developer Mode、Plugins 或自定义 MCP 功能入口依赖账号、workspace、管理员策略和产品界面；不要假设一定可见，也不要声称个人 ChatGPT Pro 一定具备入口。

若要通过 HTTP Tunnel 使用 `workspace-write` 或 `command-exec`，本地 MCP 必须保持 loopback，并通过 `CHATGPT_MCP_BRIDGE_TOKEN` 或 `--auth-token` 设置至少 32 字符的 Bearer Token；只有在 tunnel-client profile 已配置相应的 MCP 侧认证时才使用该方式，否则使用上面的 stdio profile。优先启用宿主逐次审批或仅写工具审批。完全免审批只适用于可信机器、可信工作区和严格命令目录。

本项目是社区维护的非官方开源项目，与 OpenAI 无隶属、合作、认证或背书关系。

不要默认使用无认证 Cloudflare Quick Tunnel，不要把本地 MCP 裸露到公网。若以后使用公共 HTTPS，必须部署正式 TLS、认证、访问控制与密钥轮换。public bind 的最低要求是 `--allow-public-bind` 加 `CHATGPT_MCP_BRIDGE_TOKEN`/`--auth-token`，但这不替代生产安全网关。
