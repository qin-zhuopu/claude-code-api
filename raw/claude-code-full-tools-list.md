# Claude Code 全量工具列表

> 来源：`raw/claude-code-docs/docs/tools-reference.md`（2026-07-07 最新版）
> SDK 版本：`@anthropic-ai/claude-agent-sdk` 0.3.202
> CLI 版本：`@anthropic-ai/claude-code` 2.1.195 (stable)

---

## 工具列表（42 个）

| # | Tool | 描述 | 需要权限 |
|---|------|------|----------|
| 1 | `Agent` | 启动 subagent，拥有独立上下文窗口 | No |
| 2 | `Artifact` | 发布 HTML/Markdown 为 claude.ai 私有交互页面 | Yes |
| 3 | `AskUserQuestion` | 向用户提问（多项选择题），无超时默认 | No |
| 4 | `Bash` | 执行 shell 命令 | Yes |
| 5 | `CronCreate` | 创建周期性或一次性定时任务 | No |
| 6 | `CronDelete` | 取消定时任务 | No |
| 7 | `CronList` | 列出所有定时任务 | No |
| 8 | `Edit` | 对文件进行精确字符串替换 | Yes |
| 9 | `EnterPlanMode` | 进入 plan 模式设计方案 | No |
| 10 | `EnterWorktree` | 创建或进入 git worktree | No |
| 11 | `ExitPlanMode` | 提交方案并退出 plan 模式 | Yes |
| 12 | `ExitWorktree` | 退出 worktree 会话 | No |
| 13 | `Glob` | 按模式匹配查找文件 | No |
| 14 | `Grep` | 搜索文件内容（基于 ripgrep） | No |
| 15 | `ListMcpResourcesTool` | 列出 MCP 服务器的资源 | No |
| 16 | `LSP` | 语言服务器协议：跳转定义、查找引用等 | No |
| 17 | `Monitor` | 后台监控命令/WS，逐行推送事件 | Yes |
| 18 | `NotebookEdit` | 修改 Jupyter notebook 单元格 | Yes |
| 19 | `PowerShell` | 执行 PowerShell 命令 | Yes |
| 20 | `PushNotification` | 发送桌面/手机推送通知 | No |
| 21 | `Read` | 读取文件内容 | No |
| 22 | `ReadMcpResourceTool` | 读取 MCP 资源 | No |
| 23 | `RemoteTrigger` | 创建/运行 claude.ai Routines | No |
| 24 | `ReportFindings` | 结构化报告代码审查结果 | No |
| 25 | `ScheduleWakeup` | 重调度 `/loop` 下次迭代时间 | No |
| 26 | `SendMessage` | 向 agent 队友发消息 / 恢复 subagent | No |
| 27 | `SendUserFile` | 向用户发送文件（含可选标题） | No |
| 28 | `ShareOnboardingGuide` | 上传 ONBOARDING.md 并分享链接 | Yes |
| 29 | `Skill` | 在主会话中执行 skill | Yes |
| 30 | `TaskCreate` | 在任务列表中创建新任务 | No |
| 31 | `TaskGet` | 获取任务详情 | No |
| 32 | `TaskList` | 列出所有任务及状态 | No |
| 33 | `TaskOutput` | (已弃用) 获取后台任务输出，推荐用 Read | No |
| 34 | `TaskStop` | 停止后台任务 / agent / 队友 | No |
| 35 | `TaskUpdate` | 更新任务状态、依赖、详情或删除任务 | No |
| 36 | `TodoWrite` | (已弃用) 管理会话任务清单，默认禁用 | No |
| 37 | `ToolSearch` | 搜索并加载延迟工具（MCP tool search） | No |
| 38 | `WaitForMcpServers` | 等待 MCP 服务器连接 | No |
| 39 | `WebFetch` | 获取 URL 内容并提取 | Yes |
| 40 | `WebSearch` | 执行网络搜索 | Yes |
| 41 | `Workflow` | 运行动态工作流脚本 | Yes |
| 42 | `Write` | 创建或覆盖文件 | Yes |

---

## 工具分类

### 按权限要求

| 需要权限（21 个） | 不需要权限（21 个） |
|-------------------|---------------------|
| Artifact, Bash, Edit, EnterPlanMode（不）, ExitPlanMode, Monitor, NotebookEdit, PowerShell, PushNotification（不）, ShareOnboardingGuide, Skill, WebFetch, WebSearch, Workflow, Write | Agent, AskUserQuestion, CronCreate, CronDelete, CronList, Glob, Grep, ListMcpResourcesTool, LSP, PushNotification, Read, ReadMcpResourceTool, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, SendUserFile, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, TodoWrite, ToolSearch, WaitForMcpServers |

纠正：**需要权限的 13 个**：Artifact, Bash, Edit, ExitPlanMode, Monitor, NotebookEdit, PowerShell, ShareOnboardingGuide, Skill, WebFetch, WebSearch, Workflow, Write

**不需要权限的 29 个**：Agent, AskUserQuestion, CronCreate, CronDelete, CronList, EnterPlanMode, EnterWorktree, ExitWorktree, Glob, Grep, ListMcpResourcesTool, LSP, PushNotification, Read, ReadMcpResourceTool, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, SendUserFile, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, TodoWrite, ToolSearch, WaitForMcpServers

### 按执行模式

| 类别 | 工具 |
|------|------|
| **瞬时工具**（无进度推送） | Read, Glob, Grep, CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree, ListMcpResourcesTool, ReadMcpResourceTool, TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TodoWrite, ToolSearch, WaitForMcpServers, ReportFindings, ScheduleWakeup, SendMessage, SendUserFile |
| **后台任务工具**（产生 task_* 事件） | Bash (run_in_background), Agent, Workflow, Monitor |
| **三轮交互工具**（read-before-edit/write） | Edit, Write, NotebookEdit |
| **条件性可用工具**（依赖端点/配置） | Monitor, PushNotification, RemoteTrigger, SendUserFile, LSP, ToolSearch |

### 新增工具（2.1.196+ 版本新增）

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| `ReportFindings` | 2.1.196 | 结构化报告代码审查结果 |
| `SendUserFile` | 2.1.196 | 向用户发送文件 |
| `ScheduleWakeup` (stop 字段) | 2.1.202 | `/loop` 停止控制 |

---

## 权限规则格式

工具权限规则格式为 `ToolName(specifier)`：

| 规则格式 | 适用工具 | 说明 |
|----------|---------|------|
| `Bash(npm run *)` | Bash, Monitor | 命令模式匹配 |
| `PowerShell(Get-ChildItem *)` | PowerShell | 命令模式匹配 |
| `Read(~/secrets/**)` | Read, Grep, Glob, LSP | 路径模式匹配 |
| `Edit(/src/**)` | Edit, Write, NotebookEdit | 路径模式匹配 |
| `Skill(deploy *)` | Skill | 技能名称模式匹配 |
| `Agent(Explore)` | Agent | 子代理类型匹配 |
| `WebFetch(domain:example.com)` | WebFetch | 域名匹配 |
| `WebSearch` | WebSearch | 无 specifier，整体允许/拒绝 |

---

## 关键发现

1. **SDK 和 CLI 各自独立发版**：SDK 版本号和 CLI 版本号无关
2. **SDK 通过 `require.resolve('@anthropic-ai/claude-code')` 自动解析 CLI 路径**
3. **`pathToClaudeCodeExecutable`** 选项可指定自定义 CLI 路径
4. **工具总数 42 个**，需要权限的 13 个，不需要的 29 个
5. **已弃用工具**：`TaskOutput`（推荐 Read）、`TodoWrite`（默认禁用，推荐 Task* 系列）
6. **条件性可用工具**：Monitor、PushNotification、RemoteTrigger、SendUserFile、LSP、ToolSearch 依赖特定端点或配置才能出现
