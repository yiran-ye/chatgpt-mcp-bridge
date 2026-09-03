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
