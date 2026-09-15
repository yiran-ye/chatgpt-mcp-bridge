# MCP Tools

默认注册十个内置只读工具和三个固定 MCP 网关。以下十个内置工具声明 `readOnlyHint=true`、`destructiveHint=false`、`idempotentHint=true`、`openWorldHint=false`。输入由 Zod 校验，返回 `structuredContent.data` 和模型可读 JSON 文本。

- `change_context`：Review 第一入口，汇总改动、统计与指令文件。
- `workspace_info`：项目、语言、顶层结构、Git 与 remote 脱敏摘要。
- `workspace_instructions`：根目录 AGENTS 指令，优先级 override > uppercase > lowercase。
- `git_status`：porcelain v2 结构化状态。
- `git_changed_files`：包括 untracked 的全部改动文件。
- `git_diff`：`unstaged`、`staged`、`working_tree` 分页 patch。
- `git_compare`：安全的 merge-base/direct ref 比较。
- `read_file`：UTF-8 文本按行读取，同时返回完整文件 SHA-256。
- `search_workspace`：受限 rg / Node fallback 搜索。
- `list_directory`：有限深度、分页目录列表。

所有路径均为 workspace 相对路径。删除项和二进制仅返回元数据；untracked 不会被 `git_diff` 自动展开正文。

显式启用 `workspace-write` 后增加：

- `apply_patch`：单文件 `create_file`、`update_file` 或 `delete_file`；声明为非只读、破坏性、非幂等、封闭世界工具。
- `save_attachment`：将文件原始字节保存到工作区，最多 20 MiB，不覆盖已有目标；声明为非只读、非破坏性、非幂等、开放世界工具。

显式启用 `command-exec` 后再增加：

- `run_command`：选择用户配置中的命令 ID；声明为非只读、破坏性、非幂等、开放世界工具。非零退出和超时作为含 stdout/stderr 的结构化结果返回。

显式启用 `full-access` 后同样增加 `apply_patch`、`save_attachment` 与 `run_command`，但 `run_command` 不使用命令白名单，输入为：

- `executable`：PATH 中的程序名，或通过 `PathPolicy` 校验的 workspace 相对可执行文件；不接受绝对路径。
- `args`：可选参数数组；不接受 shell 字符串，也不解析 shell 元字符。
- `cwd`：可选 workspace 相对目录，默认 `.`。
- `timeoutMs`：可选，默认 60000，最大 600000。
- `maxOutputBytes`：可选，默认 262144，最大 1048576。

`full-access` 子进程完整继承 Bridge 进程环境，包括 `HOME`、`JAVA_HOME`、工具配置及 Token 等凭据；无需额外环境参数。命令结果可能包含程序主动打印的环境值，不会按全部环境值自动脱敏。该模式没有 OS 沙箱，程序仍可能访问当前系统用户可访问的文件与网络。`command-exec` 继续使用最小环境和显式 `forwardEnv`。

两种命令模式都会响应 MCP 取消信号。HTTP 传输下，命令还受请求 deadline 限制（默认 30 秒）；客户端取消、连接中断或 deadline 到期会终止进程树。工具参数中的更长 `timeoutMs` 不会覆盖 HTTP deadline。

## 保存附件

`save_attachment` 的输入为 `{file, path}`：

- `file.download_url`、`file.file_id` 必填；`file.mime_type`、`file.file_name` 可选。四个属性都在工具 schema 中声明，`_meta["openai/fileParams"]` 为 `["file"]`，以便 ChatGPT 传入真实附件。
- `path` 必填，包含文件名，使用 `/` 分隔的工作区相对路径，例如 `assets/image.png`；父目录可自动创建。不接受绝对路径、`..`、反斜杠、空段、`.` 段、Windows 设备名称、冒号或以空格/点结尾的路径段。
- 原文件名和 MIME 仅作提示，不决定落盘路径；不解析、转换、执行或解压文件。沿用 ignore：`.jar`、`.war`、`.class` 及依赖/构建目录默认拒绝；`.zip` 默认可保存（是否入库由工作区自身的 Git 忽略规则决定），需要禁止的工作区可在 `.chatgpt-mcp-bridge-ignore` 中加回 `*.zip`。ignore 策略同时决定读取可见性：放开后工作区已有的 `.zip` 也会开始出现在 `list_files`、`search` 结果中，并在 `git_status` 中标记为可读。

成功返回 `structuredContent.data: {path, bytes, sha256}`，路径为实际的工作区相对路径，SHA-256 由下载字节计算。文件内容不会进入工具响应。`read_file` 仍只支持原有大小限制内的 UTF-8 文本，不能用来读取已保存的二进制附件。

单文件硬上限 20 MiB（20,971,520 字节），不依赖响应头的长度声明；排队、下载及提交前准备限时 25 秒，同时响应更短的宿主或 HTTP deadline。提交前超时、取消或下载失败不会创建目标，并清理临时文件；已创建的空父目录可能保留。域名先经系统解析；仅当结果全部位于代理 Fake-IP 网段 `198.18.0.0/15` 时，才自动改用公共 DoH（按 `1.1.1.1`、`8.8.8.8` IP 直连查询，单次 3 秒）获取公网地址，DoH 结果与系统结果一视同仁地通过公网校验后才固定连接。hosts、内网 split-DNS 与安全软件 sinkhole 的解析结果不经公共解析器、不被绕过，直接维持拒绝；拒绝信息只回显客户端提供的域名，不包含解析到的地址。连接失败时仅依次尝试同次校验通过的公网地址，每次等待响应头最多 3 秒；不重试证书错误、HTTP 错误或正文传输，临时链接失效时需要客户端提供新的文件参数。

临时文件同步并关闭、路径复查完成后进入原子提交。提交一旦开始，服务等待提交和清理完成，返回实际成功或失败，晚到的取消不再改写为 `TIMEOUT`；这一不可取消阶段可能超出 25 秒。客户端断连或 HTTP deadline 仍可能使结果无法送达，此时目标可能已保存，重试前应先检查目标是否存在。

错误码包括 `FILE_CONFLICT`（目标已存在，另选名称）、`FILE_TOO_LARGE`、`DOWNLOAD_BLOCKED`（地址策略拒绝）、`DOWNLOAD_FAILED`（下载或保存失败）、`TIMEOUT`，以及已有路径策略错误。拒绝覆盖参数；目标已存在时不下载。只接受公网 HTTPS 标准端口，最多三次重定向；不会发送本地环境凭据、Cookie 或 Bridge Bearer Token。

工具默认不可用；通过 `--access workspace-write` 或更高模式启用。写模式具备附件下载网络能力，所以 `workspace_info.security.networkDisabledForTools` 为 false。默认工具总数为 13，`workspace-write` 为 15，命令模式为 16。

## 上游 MCP 工具

三个固定入口始终存在，无需 `--enable-mcp`。项目非空有效配置在启动时自动加载，未配置时服务目录为空。

| 工具 | 输入 | 结果 |
|---|---|---|
| `mcp_list_servers` | `{}` | `{enabled, servers}`，包含服务 ID、状态、工具数和安全错误码 |
| `mcp_list_tools` | `{serverId, cursor?}` | `{serverId, tools, nextCursor?}`，保留原始名称及输入／输出 Schema、说明、注解 |
| `mcp_call_tool` | `{serverId, toolName, arguments?}` | 原生 `content`、`structuredContent` 和 `isError` |

`arguments` 必须是 JSON 对象，省略时使用 `{}`。网关结果不使用内置工具的 `structuredContent.data` 包装。两个查询入口只读；调用入口固定声明非只读、可能有破坏性、非幂等及开放世界。上游 annotations 仅作为目录数据返回。

`mcp_list_tools` 每页最多 100 个工具、完整结果最多 1 MiB，签名 `nextCursor` 绑定工作区、服务和目录内容。插件的 `tools/list` 不随上游配置或目录变化。配置和上游目录在启动时固定，变更后重启 Bridge 即可；迁移到固定入口时刷新一次插件。`workspace_info.mcp` 返回代理是否启用及各服务的状态和工具数；开启代理时整体 `security.readOnly` 为 false，`localToolsReadOnly` 反映内置工具权限。

上游参数由 Zod 校验容器并由 Ajv 校验 Schema；不转换参数或补默认值。Bridge 错误使用 `isError: true` 和安全错误码，包含 `MCP_CONFIG_INVALID`、`MCP_SCHEMA_INVALID`、`MCP_UPSTREAM_UNAVAILABLE`、`MCP_UPSTREAM_FAILED`、`TIMEOUT`、`OUTPUT_LIMIT_EXCEEDED`。更多限制见 [MCP_PROXY.md](MCP_PROXY.md)。
