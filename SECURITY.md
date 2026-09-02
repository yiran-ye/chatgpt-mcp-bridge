# 安全策略

本项目的安全边界是“固定 workspace 内、策略允许的只读数据”。MCP 工具不提供写入、命令执行或网络访问。

## 防护

- 启动时 canonicalize workspace；每次文件访问都 resolve + realpath + `path.relative` 检查，拒绝绝对路径、`..`、编码 traversal 和越界 symlink。
- 强制敏感规则高于默认 ignore 与 `.local-code-mcp-ignore`，不可关闭。
- Git/rg 通过固定 executable 与参数数组启动，`shell=false`；Git ref、path 分开验证，pathspec 前使用 `--`。
- Git 禁用 pager、external diff、textconv、color 和 optional locks；工具不 fetch、不修改仓库。
- 输出、文件、diff、搜索、子进程、请求体、请求时间和并发均有限制；分页游标使用每进程随机密钥的 HMAC 防篡改。
- Client 只看到相对路径和 workspace 名称；错误不返回栈、用户名、环境变量、remote 凭证或绝对路径。
- 审计日志默认关闭；启用后只记录元数据，不记录正文、patch、搜索内容或 Token。

## HTTP

默认只监听 `127.0.0.1`。loopback 模式为了兼容 MCP Client，允许缺失 Origin；若提供 Origin，则只接受 loopback Origin。public bind 必须同时设置 `--allow-public-bind` 和 Bearer Token，且缺失 Origin 会被拒绝。服务不配置任意 CORS。

请勿将服务裸露到公网。若未来通过公共 HTTPS 暴露，必须使用可信反向代理、TLS、正式身份认证、访问控制、轮换密钥和网络隔离；Bearer Token 只是最低启动门槛。

## 报告漏洞

请私下报告，避免提交包含真实密钥、路径、源码或利用细节的公开 issue。报告应包含最小复现和受影响版本。
