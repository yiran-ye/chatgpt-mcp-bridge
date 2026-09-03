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

### 3. 初始化 tunnel-client

```bash
export CONTROL_PLANE_API_KEY="$(security find-generic-password -a "$USER" -s "chatgpt-mcp-bridge-tunnel" -w)"

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile chatgpt-mcp-bridge \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-server-url http://127.0.0.1:8765/mcp \
  --health-listen-addr 127.0.0.1:8080

tunnel-client doctor --profile chatgpt-mcp-bridge --explain
tunnel-client run --profile chatgpt-mcp-bridge
```

macOS 可将 Runtime API Key 存入 Keychain；其他平台请使用系统 Secret Manager 或仅在当前 shell 中导出环境变量。`tunnel-client run` 和本地 MCP Server 在 ChatGPT 使用期间都必须保持运行。

### 4. 在 ChatGPT 创建连接

在可用的 ChatGPT Plugins/Connectors 入口创建插件，连接方式选择 Tunnel，选择 `chatgpt-mcp-bridge`，身份验证选择“无身份验证”，建议将插件命名为 `LocalCode`。本地服务没有 OAuth；Tunnel 负责从 OpenAI 控制面到本机 MCP 的连接。

Developer Mode、Plugins 或自定义 MCP 功能入口依赖账号、workspace、管理员策略和产品界面；不要假设一定可见，也不要声称个人 ChatGPT Pro 一定具备入口。

本项目是社区维护的非官方开源项目，与 OpenAI 无隶属、合作、认证或背书关系。

不要默认使用无认证 Cloudflare Quick Tunnel，不要把本地 MCP 裸露到公网。若以后使用公共 HTTPS，必须部署正式 TLS、认证、访问控制与密钥轮换。public bind 的最低要求是 `--allow-public-bind` 加 `CHATGPT_MCP_BRIDGE_TOKEN`/`--auth-token`，但这不替代生产安全网关。
