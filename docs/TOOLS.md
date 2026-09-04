# MCP Tools

默认十个工具声明 `readOnlyHint=true`、`destructiveHint=false`、`idempotentHint=true`、`openWorldHint=false`。输入由 Zod 校验，返回 `structuredContent.data` 和模型可读 JSON 文本。

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

显式启用 `command-exec` 后再增加：

- `run_command`：选择用户配置中的命令 ID；声明为非只读、破坏性、非幂等、开放世界工具。非零退出和超时作为含 stdout/stderr 的结构化结果返回。

显式启用 `full-access` 后同样增加 `apply_patch` 与 `run_command`，但 `run_command` 不使用命令白名单，输入为：

- `executable`：PATH 中的程序名，或通过 `PathPolicy` 校验的 workspace 相对可执行文件；不接受绝对路径。
- `args`：可选参数数组；不接受 shell 字符串，也不解析 shell 元字符。
- `cwd`：可选 workspace 相对目录，默认 `.`。
- `timeoutMs`：可选，默认 60000，最大 600000。
- `maxOutputBytes`：可选，默认 262144，最大 1048576。

`full-access` 子进程只继承最小环境。该模式没有 OS 沙箱，程序仍可能访问当前系统用户可访问的文件与网络。

两种命令模式都会响应 MCP 取消信号。HTTP 传输下，命令还受请求 deadline 限制（默认 30 秒）；客户端取消、连接中断或 deadline 到期会终止进程树。工具参数中的更长 `timeoutMs` 不会覆盖 HTTP deadline。
