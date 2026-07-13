# SDK Bash 检测机制（CLAUDE_CODE_GIT_BASH_PATH）

## 核心结论

**Claude Agent SDK 本身不自动探测 bash.exe 路径**，它只读取环境变量 `CLAUDE_CODE_GIT_BASH_PATH`。自动探测是 CodePilot 包装层做的事。

## 分层职责

| 层级 | 文件 | 职责 |
|------|------|------|
| **SDK 本身** | `node_modules/@anthropic-ai/claude-agent-sdk/` | 仅读取 `CLAUDE_CODE_GIT_BASH_PATH` 环境变量，不自动探测 |
| **CodePilot 包装层** | `src/lib/platform.ts` | `findGitBash()` 自动探测 bash.exe 路径 |
| **CodePilot 子进程启动** | `src/lib/sdk-subprocess-env.ts` | 将探测到的路径注入 SDK 子进程的 env |

## 数据流

```
findGitBash()                          // platform.ts:523-564
  │
  ├─ 1. 读 CLAUDE_CODE_GIT_BASH_PATH 环境变量
  ├─ 2. 查硬盘常见路径（C:\Program Files\Git\bin\bash.exe）
  └─ 3. 通过 where git 反推 ../bin/bash.exe
        │
        ▼
prepareSdkSubprocessEnv()             // sdk-subprocess-env.ts:68-72
  │
  if (win32 && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    env.CLAUDE_CODE_GIT_BASH_PATH = findGitBash()
  }
        │
        ▼
SDK 子进程                            // 读取 process.env.CLAUDE_CODE_GIT_BASH_PATH
```

## findGitBash() 探测顺序

`src/lib/platform.ts:523-564`

1. **环境变量优先** — 如果 `CLAUDE_CODE_GIT_BASH_PATH` 已设且文件存在，直接返回
2. **常见路径兜底** — 检查 `C:\Program Files\Git\bin\bash.exe` 和 `C:\Program Files (x86)\Git\bin\bash.exe`
3. **where git 反推** — 执行 `where git`，从 git.exe 路径推导 `../bin/bash.exe`

## 平台差异

### Windows

- 没有系统自带 bash，**必须**通过 `CLAUDE_CODE_GIT_BASH_PATH` 指定 Git Bash 的 `bash.exe` 路径
- 如果没设，CodePilot 会自动探测并注入
- Shell 方言默认 **PowerShell**；bash 只在显式设置了 `CLAUDE_CODE_GIT_BASH_PATH` 时才启用
- 判断逻辑在 `platform.ts:468-470`（`windowsBashOptIn()`）

### Linux / macOS

- 系统自带 bash（`/bin/bash`），**完全忽略** `CLAUDE_CODE_GIT_BASH_PATH`
- 设置该变量不会产生任何影响
- SDK 的 `sdk.d.ts` 和官方文档均标注为 "Windows only"

### WSL

- Node.js 的 `process.platform` 返回 `'linux'`，走 Linux 分支
- 不被视为 win32，不需要 `CLAUDE_CODE_GIT_BASH_PATH`

## 相关常量

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_GIT_BASH_PATH` | SDK 官方环境变量，Windows only，指向 bash.exe |
| `CLAUDE_CODE` | 进入 Claude Code 会话时的标记，CodePilot 会在子进程 env 中删除它，防止 SDK 误判为"嵌套会话" |

## 涉及文件

- `src/lib/platform.ts` — `findGitBash()`, `windowsBashOptIn()`, `getPlatformShell()`
- `src/lib/sdk-subprocess-env.ts` — `prepareSdkSubprocessEnv()` 统一注入点
- `src/lib/error-classifier.ts` — `MISSING_GIT_BASH` 错误分类（Windows 缺 Git Bash 时上报）
- `src/__tests__/unit/platform-shell.test.ts` — `CLAUDE_CODE_GIT_BASH_PATH` 相关测试
- `raw/sdk-query-options-reference.md` — SDK 官方环境变量文档（第 397 行）