# ChatGPT 接入

## 推荐流程：OpenAI Secure MCP Tunnel

1. 本地启动：`local-code-mcp serve --workspace /path/to/project --transport http`。
2. 用 MCP Inspector 验证 `http://127.0.0.1:8765/mcp` 的 initialize、tools/list 和 tools/call。
3. 按 OpenAI 当前官方界面与文档配置 Secure MCP Tunnel，将上述 loopback 地址作为本地 MCP 地址。
4. 在可用的 ChatGPT MCP/Connector 入口添加服务并命名为 `LocalCode`。

Developer Mode、Plugins 或自定义 MCP 功能入口依赖账号、workspace、管理员策略和产品界面；不要假设一定可见，也不要声称个人 ChatGPT Pro 一定具备入口。

不要默认使用无认证 Cloudflare Quick Tunnel，不要把本地 MCP 裸露到公网。若以后使用公共 HTTPS，必须部署正式 TLS、认证、访问控制与密钥轮换。public bind 的最低要求是 `--allow-public-bind` 加 `LOCAL_CODE_MCP_TOKEN`/`--auth-token`，但这不替代生产安全网关。
