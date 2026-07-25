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

## 命令执行约定

- **禁止在 bash 命令中使用 `tail`**（以及 `head` 等截断输出的管道）——会导致看不到命令的完整过程和中间信息，掩盖真实执行情况。需要查看输出时，用 `Read` 工具读输出文件，或用 `grep` 精确取行，而不是截断。