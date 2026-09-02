# ChatGPT Review Prompts

## 示例一：Review 未提交代码

@LocalCode

请 Review 当前项目的全部未提交修改。

先调用 change_context 和 git_status，
再分别检查 staged、unstaged 和 untracked 文件。
读取 git_diff 后，根据改动主动搜索并读取相关调用方和被调用方。

重点检查：

1. 逻辑错误；
2. 空指针；
3. 并发问题；
4. SQL 性能；
5. 事务边界；
6. 接口兼容性；
7. 安全问题；
8. 是否遗漏测试；
9. 是否违反 AGENTS.md；
10. 是否存在未处理的边界条件。

只做 Review，不修改任何文件。
按严重程度输出问题，并标明文件和行号。
没有问题时也要明确说明检查范围和仍然存在的不确定性。

## 示例二：复查 Codex 修改

@LocalCode

重新检查当前工作区修改。

重点确认上一次 Review 提出的每一个问题是否已经修复。
不要只相信修改摘要，必须重新读取当前 git diff 和相关源码。
输出：

- 已解决问题；
- 未解决问题；
- 新引入问题；
- 建议补充的测试。

## 示例三：分支 Review

@LocalCode

Review 当前分支相对于 origin/main 的全部修改。

使用 git_compare，base 为 origin/main，head 为 HEAD。
根据 diff 主动读取相关源码和调用链。
只 Review，不修改文件。

## 示例四：项目规划

@LocalCode

分析当前项目中与权限管理有关的实现。

先读取 workspace_info 和 workspace_instructions，
然后搜索 Permission、Auth、Role、User 等相关模块。
输出实现现状、主要调用链、潜在问题和建议改造步骤。
不要修改任何文件。
