# Changelog

## [Unreleased]

- 将 GET SSE 连接配额与普通 HTTP 请求并发分离，新增独立连接上限（默认 16）；SSE 建立后取消普通请求 deadline，防止长连接阻塞 POST 或被定时中断。

- 修复 HTTP deadline 后迟到结果重复写入响应的问题，并在取消及服务关闭时结束待处理请求和 SSE 流。
- 支持工作区内安全的文件／目录符号链接，使用目标元数据并校验链接与目标路径；上游 stdio 兼容空白行，保留协议与大小限制。

- 新增项目级 `.chatgpt-mcp-bridge/mcp.json` 自动加载，支持本地 stdio 与 Streamable HTTP MCP；通过三个始终注册的固定网关发现和调用全部上游工具，配置变化后重启 Bridge 即可，无需刷新插件。旧 `--enable-mcp` 参数保留兼容。
- 新增共享上游运行时、原始 JSON Schema 校验、目录分页、故障状态摘要、取消传播和进程树清理；HTTP 代理要求 loopback 和强 Token。
- 配置支持环境变量引用；诊断不连接上游，配置凭据和上游 stderr 不进入摘要或审计日志，并补充代理安全边界测试与使用文档。

## [0.4.0] - 2026-09-04

- 新增 `--access full-access` 模式，无需预先配置命令白名单即可执行 PATH 中的程序，或通过 `PathPolicy` 校验的工作区相对程序。
- 命令执行继续使用参数数组、`shell: false` 和最小环境变量，并补充 executable、目录、敏感路径、输出及超时边界校验。
- HTTP 请求超时、客户端断开或 MCP 取消现在会终止对应的命令进程树并释放写任务互斥队列，避免命令在客户端超时后继续后台运行。

## [0.3.2] - 2026-09-03

- CLI 参数错误现在返回明确的 `INVALID_INPUT` 提示，不再误报为 `INTERNAL_ERROR`。
- 新增项目级 `.chatgpt-mcp-bridge/config.json`，优先级高于全局配置，并在 `config` 输出中显示生效路径、来源和存在状态。
- 新增完整 CLI 命令的 `cmb` 缩写别名。

## [0.3.1] - 2026-09-03

- 修正 GitHub Actions 调用 Release 辅助脚本时的参数分隔兼容性，并升级 Action 运行时。
- 新增 `chatgpt-mcp-bridge --version` 与 `chatgpt-mcp-bridge --help`。
- 将默认命令配置文件统一迁移至 `~/.chatgpt-mcp-bridge/config.json`。

## [0.3.0] - 2026-09-03

- 新增显式启用的 workspace 文件补丁和受控命令执行能力。
- 新增访问模式、用户级命令配置、HTTP 写模式强认证及安全边界测试。
- 新增基于 Git 标签和 Changelog 的 GitHub Release 自动化。

## [0.2.2] - 2026-09-03

- 更新 npm 安装与 Secure MCP Tunnel 配置说明。
- 修正本地发布脚本相关的仓库维护配置。

## [0.2.1] - 2026-09-03

- 文档与版本过渡标签；该版本未发布到 npm，也不创建 GitHub Release。

## [0.2.0] - 2026-09-03

- 项目、npm 包、CLI、MCP Server 标识和配置文件统一更名为 `chatgpt-mcp-bridge`。
- 补充通用 OpenAI Secure MCP Tunnel 与 ChatGPT Plugins/Connectors 接入文档。
- 修复全局链接安装后的 CLI 启动入口。
- 增加开源仓库元数据和非官方项目声明。

## [0.1.0] - 2026-09-02

- 内部初始版本：只读文件、搜索、Git 状态/差异/比较和 Streamable HTTP/stdio MCP；未以当前包名发布到 npm。
