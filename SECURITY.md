# 安全策略

本项目默认安全边界是“固定 workspace 内、策略允许的只读数据”。本地 `workspace-write`、`command-exec`、`full-access` 须通过启动参数启用；项目 MCP 配置独立授权上游调用。Bridge 不提供通过 MCP 切换权限的接口。

## 防护

- 启动时 canonicalize workspace；每次文件访问都 resolve + realpath + `path.relative` 检查，拒绝绝对路径、`..`、编码 traversal 和越界 symlink。
- 强制敏感规则高于默认 ignore 与 `.chatgpt-mcp-bridge-ignore`，不可关闭。
- Git/rg 和允许的命令通过 executable 与参数数组启动，`shell=false`；Git ref、path 分开验证，pathspec 前使用 `--`。
- Git 禁用 pager、external diff、textconv、color 和 optional locks；工具不 fetch、不修改仓库。
- 输出、文件、diff、搜索、子进程、请求体、请求时间和并发均有限制；分页游标使用每进程随机密钥的 HMAC 防篡改。
- 内置文件/Git 工具只展示相对路径和 workspace 名称；Bridge 生成的错误不返回栈、用户名、环境变量、remote 凭证或绝对路径。
- 审计日志默认关闭；启用后只记录元数据，不记录正文、patch、搜索内容或 Token。

## 写入与命令

- `apply_patch` 只处理单个 UTF-8 普通文件；更新和删除使用 SHA-256 乐观锁，写入使用同目录临时文件和原子替换。
- 敏感路径、ignore、`.git` 和 `.chatgpt-mcp-bridge-ignore` 对直接读写始终阻止；新文件还会验证真实父目录，避免符号链接逃逸。
- `command-exec` 下的 `run_command` 只能选择启动时加载配置中的命令 ID。模型不能覆盖 executable、固定参数、环境变量、超时或输出上限。
- `full-access` 是显式例外：无需白名单即可提交 executable 与参数数组，但仍使用 `shell=false`；PATH 程序名之外的 executable 必须是经 `PathPolicy` 校验的 workspace 相对路径，绝对路径、敏感路径、ignore 路径和越界符号链接会被拒绝。
- `full-access` 子进程完整继承 Bridge 进程环境，包括 Token 等凭据；命令结果可能包含程序主动打印的环境值，不会按全部环境值自动脱敏。审计日志仍只记录元数据。`command-exec` 继续使用最小环境和显式 `forwardEnv`，显式转发值继续脱敏。
- 命令同时监听 MCP 取消信号与 HTTP 请求生命周期；客户端取消、断连或 HTTP deadline 到期时会终止整个进程树，避免失联命令继续后台运行并占用互斥队列。
- 命令执行不是系统沙箱。被执行的程序具有当前 OS 用户的权限和潜在网络能力，也可能间接访问受保护路径；`command-exec`、`full-access` 与宿主的免审批模式只能用于可信工作区。

## 上游 MCP 代理

启动时自动加载 `.chatgpt-mcp-bridge/mcp.json`，非空有效配置授权启动上游并调用其全部工具，包括写入、命令和网络能力。无需 `--enable-mcp`。配置缺失或服务列表为空时不启动上游；非法配置使启动失败。Bridge 的网关不接受动态地址、启动命令或配置修改请求，普通文件工具仍不能修改 MCP 配置。配置读取、cwd 和相对 executable 受 `PathPolicy` 约束；上游自身的文件、命令及网络行为不受 Bridge 工作区沙箱约束。

三个网关入口始终注册，未配置时调用入口返回不可用错误。目录查询标记只读；统一调用入口固定标记为非只读、可能有破坏性、非幂等、开放世界，不随上游注解变化。上游工具定义作为查询结果返回，不生成动态插件接口。

配置由 Zod 严格校验；环境引用仅支持 env/headers 并在展开后重新校验。HTTP 不跟随重定向、不自动登录或加载外部 JSON Schema 引用。上游工具参数经 Zod 和 JSON Schema 校验，超大消息/结果被拒绝；目录和调用均有数量、时间及并发限制。

代理调用失败不会自动重试。取消向上游传播但不保证副作用回滚；退出或启动取消时清理本地上游进程树。配置凭据、上游 stderr 和调用正文不写入诊断或审计日志。上游工具业务结果按协议透传，必须信任所配置服务，不应把此机制当作对任意上游内容的脱敏器。

## HTTP

默认只监听 `127.0.0.1`。loopback 模式为了兼容 MCP Client，允许缺失 Origin；若提供 Origin，则只接受 loopback Origin。未启用代理的只读模式 public bind 必须同时设置 `--allow-public-bind` 和 Bearer Token。写入、白名单命令、`full-access` 和 MCP 代理模式禁止 public bind，且 HTTP loopback 也要求至少 32 字符的 Bearer Token。CLI 在启动上游前完成此项校验。服务不配置任意 CORS。

请勿将服务裸露到公网。若未来通过公共 HTTPS 暴露，必须使用可信反向代理、TLS、正式身份认证、访问控制、轮换密钥和网络隔离；Bearer Token 只是最低启动门槛。

## 报告漏洞

请通过 GitHub Security Advisories 的“Report a vulnerability”私下报告，避免提交包含真实密钥、路径、源码或利用细节的公开 issue。报告应包含最小复现和受影响版本。
