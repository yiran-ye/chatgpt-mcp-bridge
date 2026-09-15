# Changelog

## [Unreleased]

## [0.7.0] - 2026-09-15

- `save_attachment` 默认允许保存 `.zip` 归档（`.jar`/`.war`/`.class` 仍拒绝）；是否入库由工作区自身的 Git 忽略规则决定，需要禁止的工作区可在 `.chatgpt-mcp-bridge-ignore` 中加回 `*.zip`，该策略同时影响 list/search/git_status 的读取可见性。
- 附件域名在系统解析全部落在代理 Fake-IP 网段（`198.18.0.0/15`）时，自动回退公共 DoH（按 `1.1.1.1`、`8.8.8.8` IP 直连查询）获取真实公网地址，结果与系统解析一视同仁地通过公网校验并固定连接；hosts、内网 split-DNS 与安全软件 sinkhole 的结果不经公共解析器、不被绕过，直接维持拒绝。
- DoH 响应经 Zod 严格校验：`Status` 必须为 0，畸形或超过 16 KiB 的响应视为该端点失败并回退下一解析器；取消后不再尝试下一公共解析器。
- `DOWNLOAD_BLOCKED` 错误信息只回显客户端提供的域名，不包含解析到的地址或链接参数；仓库忽略 `.zcode/` 本地目录。

## [0.6.0] - 2026-09-14

- 修复附件多地址 DNS 首个地址不可达时无法下载的问题，仅在已验证公网地址之间回退；明确原子提交边界，避免提交期间取消将成功保存误报为超时。
- 新增写模式下的 `save_attachment`，通过 ChatGPT 文件参数接收图片和文档，原样保存到工作区；单文件最多 20 MiB，自动创建安全父目录，同名时报冲突，返回大小与 SHA-256。
- 工具目录保留 `openai/fileParams` 元数据。附件下载限制公网 HTTPS、固定已验证 DNS 地址、逐跳校验重定向，并支持限额、25 秒超时、取消及临时文件清理；同步更新网络能力摘要、协议/安全测试和客户端联调说明。
- 补丁创建同时校验真实父目录下的目标策略，防止目录别名绕过受保护的 Git/Bridge 或 ignore 路径；stdio 退出时向活动工具传播取消信号。

## [0.5.2] - 2026-09-08

- `full-access` 命令完整继承 Bridge 进程环境，修复过滤 `HOME`、`JAVA_HOME` 等变量导致的开发工具启动问题；继承包括 Token 等凭据，命令输出不按全部环境值自动脱敏。`command-exec` 保持最小环境与显式转发策略。

## [0.5.1] - 2026-09-08

- 修复 Windows 将非目录父路径误判为配置缺失的问题；缺失路径会检查现存父目录，拒绝普通文件、悬空链接和越界链接。

## [0.5.0] - 2026-09-08

- 新增项目级 MCP 配置自动加载，支持 stdio 和 Streamable HTTP 上游，无需启用开关；配置授权调用上游全部工具，本地工具仍由 --access 控制。
- 始终提供 mcp_list_servers、mcp_list_tools、mcp_call_tool 三个固定入口。升级时刷新一次插件，此后增删服务或修改工具参数只需重启 Bridge。
- 支持原始 JSON Schema 校验、目录分页、环境变量引用、状态诊断、取消传播和上游进程树清理；HTTP 上游访问保持本机监听与强 Token 要求。
- 修复 HTTP 超时后重复写入响应的问题；GET SSE 使用独立连接配额（默认 16），建立后不受普通请求 deadline 限制，避免阻塞 POST。
- 支持工作区内安全的文件和目录符号链接，校验链接与目标路径并使用真实元数据；stdio 兼容空白行，继续拒绝非法协议及超限消息。

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
