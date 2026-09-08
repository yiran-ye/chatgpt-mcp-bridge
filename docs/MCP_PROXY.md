# 项目级 MCP 服务代理

在项目的 `.chatgpt-mcp-bridge/mcp.json` 中配置其他 MCP 服务，Bridge 启动时会自动加载，无需 `--enable-mcp`。ChatGPT 始终使用三个固定入口发现和调用上游工具，插件接口不随配置内容变化。

## 配置

```json
{
  "version": 1,
  "mcpServers": {
    "local": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "<MCP 包名>"],
      "cwd": ".",
      "env": {
        "SERVICE_TOKEN": "${env:SERVICE_TOKEN}"
      }
    },
    "remote": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:REMOTE_MCP_TOKEN}"
      }
    }
  }
}
```

将占位包名、地址和环境变量替换为实际服务所需的值；没有认证需求时省略 `env` 或 `headers`。服务名称最多 32 字符，以英文字母开头，后续允许字母、数字、下划线和连字符。

- `stdio`：必填 `command`，可以是 PATH 程序名或工作区相对可执行文件；禁止绝对 executable 路径。`args` 默认 `[]`，`cwd` 默认工作区根目录 `.`，`env` 默认 `{}`。相对 executable 和 cwd 均相对于工作区根目录解析。
- `http`：必填 `url`，支持 Streamable HTTP 的 HTTP/HTTPS 地址；`headers` 默认 `{}`。不接受含用户名、密码或 fragment 的 URL，不跟随重定向。
- 只有 `env` 和 `headers` 的值会展开 `${env:变量名}`；变量不存在会使启动失败，空字符串则作为已设置的值处理。command、args、cwd 和 URL 不展开变量或 shell 语法。
- 配置最大 64 KiB，最多 16 个服务，未知字段会被拒绝。不要将真实密钥提交到 Git；建议使用环境变量引用。

本地 MCP 以 Bridge 所在 OS 用户身份运行。子进程获得 PATH、HOME、临时目录、语言设置等基础环境，以及 `env` 中显式提供的值；不会自动转发 Bridge Token 或其他任意环境变量。Windows 的 `.cmd`/`.bat` 启动器不会通过 shell 执行，可改用 `node` 加对应 CLI 的 JavaScript 入口路径。

## 启动与 ChatGPT 接入

已有 HTTP 接入或 Tunnel 的用户，先设置至少 32 字符的随机 Bearer Token，并让客户端使用相同 Token，然后启动：

```bash
cmb serve /path/to/project
```

Token 使用已有的 `CHATGPT_MCP_BRIDGE_TOKEN` 环境变量或 `--auth-token` 参数。代理模式的 HTTP 监听必须是 loopback，禁止 public bind。ChatGPT 的连接配置步骤见 [CHATGPT_SETUP.md](CHATGPT_SETUP.md)。从直接暴露上游工具的版本迁移时，刷新一次插件以获取固定入口；之后增删服务、工具或修改参数结构，只需重启 Bridge，无需刷新插件。

stdio 客户端使用：

```bash
cmb serve /path/to/project --transport stdio
```

配置文件中的非空服务列表授权启动上游并调用其全部工具，包括写入、命令及网络操作；`--access` 仍控制 Bridge 自身的 `apply_patch`、`run_command`。即使使用默认 `--access read-only`，已配置的上游仍可执行其支持的操作。没有配置或 `mcpServers` 为空时不启动或连接上游，三个入口仍保留；`mcp_list_servers` 返回 `{enabled: false, servers: []}`。旧 `--enable-mcp` 参数仅为兼容保留，不再控制启用状态。

无效 JSON、环境引用、路径或不可安全读取的配置会使启动失败。只有配置文件确实缺失才按未配置处理；配置中引用的 cwd 或 executable 缺失是错误。

## 工具与故障处理

三个固定入口始终注册，上游 Schema、名称及注解只出现在查询结果中，不会写入插件工具定义：

| 固定工具 | 参数 | 用途 |
|---|---|---|
| `mcp_list_servers` | `{}` | 返回 `{enabled, servers}`，查询服务 ID、传输类型、连接状态、工具数量和安全错误码 |
| `mcp_list_tools` | `{serverId, cursor?}` | 返回 `{serverId, tools, nextCursor?}`，获取原始名称、说明及输入／输出 Schema、注解 |
| `mcp_call_tool` | `{serverId, toolName, arguments?}` | 按服务 ID 和原始工具名称执行，`arguments` 为 JSON 对象，默认 `{}` |

例如先调用 `mcp_list_tools({serverId: "local"})`，再按返回的 Schema 调用 `mcp_call_tool({serverId: "local", toolName: "search", arguments: {query: "example"}})`。实际参数以所配置服务的查询结果为准。工具原名不会改写，不同服务可以拥有同名工具；旧 `mcp_<服务名>__<工具名>` 别名不再提供。

每个服务最多发现 256 个工具，目录总大小最多 1 MiB；`mcp_list_tools` 每页最多 100 项，完整返回结果不超过 1 MiB，并提供绑定工作区、服务和目录版本的签名游标。重启后旧游标失效，应重新查询第一页。两个目录查询只读；统一调用入口始终标记为非只读、可能有破坏性、非幂等和开放世界，不随上游注解变化。

输入/输出 JSON Schema 保留原始结构。参数先经 Zod 校验，再按上游 JSON Schema 校验，不执行类型转换、补默认值或删除字段；支持 Draft 2020-12 和显式声明的 Draft 7，禁止外部 `$ref` 和异步 Schema。原生 `content`、`structuredContent`、`isError` 按协议返回，目录中未提供的 annotations 使用可能有副作用的开放世界默认值。网关结果不采用内置工具的 `structuredContent.data` 包装。

Bridge 启动时连接上游并固定工具目录。HTTP 请求共享这些连接，不会每次重新启动 MCP 程序。配置或工具列表变化后重启 Bridge；首版不热重载，不自动重试工具调用，也不自动重新启动断开的服务。

连接与发现总时限 10 秒，调用时限 30 秒，上游调用并发上限 32。HTTP 调用还受 Bridge 的请求 deadline 限制。参数和结果各限制为 1 MiB；超限返回错误，不截断成看似完整的结果。stdio 消息和 HTTP JSON 响应/SSE 单事件还受传输层大小限制。

单个服务不可用、返回非法 Schema 或不受支持的工具目录时，该服务标记为 `error`，其余服务和内置工具继续可用。调用 `mcp_list_servers` 或 `workspace_info` 查看服务状态、工具数和安全错误码。`security.readOnly`、`workspaceContained`、`networkDisabledForTools` 会反映已开启的上游访问能力，`localToolsReadOnly` 单独反映内置工具权限。

本地诊断不会启动上游或发送网络请求：

```bash
cmb config /path/to/project
cmb doctor /path/to/project
```

这两个命令读取并校验配置、环境引用及路径，仅显示服务 ID、传输类型和配置是否存在。`doctor` 的 `connectivityChecked: false` 表示未实际检测上游连通性。

客户端取消和 HTTP deadline 会向上游传递 MCP 取消通知；它们不保证上游撤销已产生的副作用。服务停止、stdio EOF 或启动中断时，Bridge 关闭连接并清理本地上游进程树。上游启动器的 stderr 不会被转发到 Bridge 的输出或审计日志。

## 边界与嵌入接口

首版只代理 MCP Tools，不代理 Resources、Prompts、OAuth 登录、Sampling、Elicitation 或 MCP Tasks。配置中的服务必须可信；Bridge 的 `PathPolicy` 约束自身访问配置和启动路径，不能限制上游服务自行执行的文件及网络操作，也不会自动脱敏上游工具主动返回的业务内容。

嵌入方可以显式调用 `await McpProxyRuntime.create(workspace)`，或传入配置对象作为第二个参数，第三个参数可传启动取消信号。通过 `runtime.listTools(serverId)` 查询原始目录，通过 `runtime.callTool(serverId, toolName, arguments, signal?)` 调用；随后通过 `BridgeOptions.mcpProxy` 注入运行时。`createMcpServer` 保持同步，本身不读取配置或自动建立上游连接。`startHttpServer` 和 `startStdio` 拥有该运行时的关闭责任；直接使用 `createMcpServer` 的调用方应自行调用 `runtime.close()`。同一个运行时不可跨工作区或独立服务实例共享，单个 HTTP 服务内部的请求会自动复用它。
