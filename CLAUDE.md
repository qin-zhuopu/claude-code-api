# Claude Code API

REST API 服务，将 `@anthropic-ai/claude-agent-sdk` 封装为 HTTP 接口。

## 子模块（只读）

所有子模块均为**只读引用**，不允许做任何修改（包括但不限于：commit、push、修改文件）。

| 子模块 | 路径 | 用途 |
|--------|------|------|
| CodePilot | `repos/CodePilot` | CodePilot 源码参考 |
| claude-code-docs | `raw/claude-code-docs` | SDK 官方文档引用 |

如有新文档需要写入，应放在本仓库的 `docs/` 目录下。

## 版本锁定（SDK 与文档保持一致）

**锁版本的目的是让 SDK 行为与 `raw/claude-code-docs` 子模块的文档保持一致**，避免观测性测试的实测结论与文档描述对不上。

规则：
- `@anthropic-ai/claude-agent-sdk` 与 `@anthropic-ai/claude-code` 的版本，应与 `raw/claude-code-docs` 子模块指向的文档版本对应。
- **更新时两者一起更新**：升级 SDK 版本时，同步把 `claude-code-docs` 子模块拉到对应日期的最新 commit；反之更新文档子模块后，也应把 SDK 升级到匹配版本。
- 升级 SDK 后，需复验受影响的观测性测试（尤其 changelog 中提到行为变更的部分，如后台任务、subagent、close 语义），确保 `raw/*-behavior.md` 的结论仍然成立，否则更新文档并标注版本。

当前锁定版本：
- `claude-agent-sdk` `0.3.220`
- `claude-code` `2.1.218`
- `claude-code-docs` 子模块：`2026-07-25`（commit `fcfa378e`）

**npm 镜像源**：项目根 `.npmrc` 固定使用淘宝镜像 `https://registry.npmmirror.com`。原因：`claude-agent-sdk` 的平台原生二进制包（如 `claude-agent-sdk-win32-x64`，解压后约 265MB）在公司私有源上下载极慢/下不动，换淘宝镜像可正常拉取。`package-lock.json` 中相关包的 `resolved` 地址也已指向淘宝镜像。

## 命令执行约定

- **禁止对命令输出使用 `tail`/`head` 截断**——运行命令（如 `npm install`、测试、构建）时用 `... | tail` / `| head` 会看不到完整过程和中间信息，掩盖真实执行情况。让命令输出完整落到日志文件（`> /tmp/xxx.log 2>&1`），再用其它方式查看。
- **读取已有文件时可以用 `tail`/`head`**——对日志文件、输出文件做 `tail -n`、`head -n` 查看是允许的；也可用 `Read` 工具或 `grep` 精确取行。区别在于：截断的是"正在运行的命令的实时输出"（禁止）还是"已落盘文件的内容"（允许）。