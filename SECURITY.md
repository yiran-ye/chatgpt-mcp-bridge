# 安全策略

本项目默认安全边界是“固定 workspace 内、策略允许的只读数据”。`workspace-write`、`command-exec` 与 `full-access` 是启动时显式启用的高权限模式，MCP 调用不能切换模式。

## 防护

- 启动时 canonicalize workspace；每次文件访问都 resolve + realpath + `path.relative` 检查，拒绝绝对路径、`..`、编码 traversal 和越界 symlink。
- 强制敏感规则高于默认 ignore 与 `.chatgpt-mcp-bridge-ignore`，不可关闭。
- Git/rg 和允许的命令通过 executable 与参数数组启动，`shell=false`；Git ref、path 分开验证，pathspec 前使用 `--`。
- Git 禁用 pager、external diff、textconv、color 和 optional locks；工具不 fetch、不修改仓库。
- 输出、文件、diff、搜索、子进程、请求体、请求时间和并发均有限制；分页游标使用每进程随机密钥的 HMAC 防篡改。
- Client 只看到相对路径和 workspace 名称；错误不返回栈、用户名、环境变量、remote 凭证或绝对路径。
- 审计日志默认关闭；启用后只记录元数据，不记录正文、patch、搜索内容或 Token。

## 写入与命令

- `apply_patch` 只处理单个 UTF-8 普通文件；更新和删除使用 SHA-256 乐观锁，写入使用同目录临时文件和原子替换。
- 敏感路径、ignore、`.git` 和 `.chatgpt-mcp-bridge-ignore` 对直接读写始终阻止；新文件还会验证真实父目录，避免符号链接逃逸。
- `command-exec` 下的 `run_command` 只能选择启动时加载配置中的命令 ID。模型不能覆盖 executable、固定参数、环境变量、超时或输出上限。
- `full-access` 是显式例外：无需白名单即可提交 executable 与参数数组，但仍使用 `shell=false`；PATH 程序名之外的 executable 必须是经 `PathPolicy` 校验的 workspace 相对路径，绝对路径、敏感路径、ignore 路径和越界符号链接会被拒绝。
- `full-access` 子进程仅获得最小环境，不自动继承 Bridge 进程中的 Token 或其他任意环境变量。
- 命令同时监听 MCP 取消信号与 HTTP 请求生命周期；客户端取消、断连或 HTTP deadline 到期时会终止整个进程树，避免失联命令继续后台运行并占用互斥队列。
- 命令执行不是系统沙箱。被执行的程序具有当前 OS 用户的权限和潜在网络能力，也可能间接访问受保护路径；`command-exec`、`full-access` 与宿主的免审批模式只能用于可信工作区。

## HTTP

默认只监听 `127.0.0.1`。loopback 模式为了兼容 MCP Client，允许缺失 Origin；若提供 Origin，则只接受 loopback Origin。只读模式的 public bind 必须同时设置 `--allow-public-bind` 和 Bearer Token。写入、白名单命令和 `full-access` 模式禁止 public bind，且 HTTP loopback 也要求至少 32 字符的 Bearer Token。服务不配置任意 CORS。

请勿将服务裸露到公网。若未来通过公共 HTTPS 暴露，必须使用可信反向代理、TLS、正式身份认证、访问控制、轮换密钥和网络隔离；Bearer Token 只是最低启动门槛。

## 报告漏洞

请通过 GitHub Security Advisories 的“Report a vulnerability”私下报告，避免提交包含真实密钥、路径、源码或利用细节的公开 issue。报告应包含最小复现和受影响版本。
