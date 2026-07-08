# 前后台工具调用机制调研 — 交接文档

> 调研人：Claude Code  
> 日期：2026-07-08  
> 状态：**进行中** — 已收集资料，待编写测试用例和洞察文档  
> 交接对象：研究院 Agent

---

## 1. 调研课题

探索 Claude Code 中所有工具的 **前台/后台运行机制**：

- 哪些工具只能前台运行？哪些只能后台？哪些可切换？
- TUI 中 Ctrl+B 的精确行为边界
- 后台任务完成后 SDK 如何获取输出？
- `task_notification` 消息的完整结构
- `backgroundTasks()` 的 SDK 控制接口
- 前台→后台→前台 的完整状态机

## 2. 已完成工作

### 2.1 已阅读的文档

| 文件 | 关键信息 |
|------|---------|
| `raw/claude-code-docs/docs/tools-reference.md` | 全部 50+ 工具列表、权限要求、Agent/Agent 工具行为 |
| `raw/claude-code-docs/docs/commands.md` | 全部命令列表、/tasks /background /fork 等命令说明 |
| `raw/claude-code-docs/docs/sub-agents.md` | subagent 前台/后台机制（第 723-740 行）、v2.1.198 默认后台运行、Ctrl+B 后台化、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` |
| `raw/claude-code-docs/docs/interactive-mode.md` | Ctrl+B 后台化 Bash 命令、shell 模式、后台任务清理规则 |
| `raw/claude-code-docs/docs/agent-view.md` | 后台 session 管理、attach/detach、resume 机制 |
| `raw/claude-code-docs/docs/keybindings.md` | `task:background` → Ctrl+B / Ctrl+X Ctrl+B 快捷键映射 |
| `raw/claude-code-docs/docs/workflows.md` | Workflow 工具运行机制、后台子 agent 编排 |
| `raw/claude-code-docs/docs/changelog.md` | Ctrl+B 历史演进：统一 Bash+Agent 后台化、background subagent 权限提示、depth limit 等 |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `backgroundTasks()` 方法、`SDKControlBackgroundTasksRequest`、`BackgroundTaskSummary`、`SDKTaskNotificationMessage`、`task_notification` subtype |
| `repos/CodePilot/src/lib/claude-client.ts` | CodePilot 对 `task_notification` 的处理（只提取 status/summary/task_id） |
| `repos/CodePilot/src/lib/agent-task-runner.ts` | CodePilot 自有 headless runner — 不依赖 SDK async agent |
| `repos/CodePilot/src/lib/headless-claude.ts` | `consumeHeadlessStream()` — 服务端消费 SSE 流的完整实现 |

### 2.2 已知信息汇总

#### 工具按运行方式分类

| 类别 | 工具 | 能否 Ctrl+B 后台化？ |
|------|------|---------------------|
| **可前台/可后台切换** | `Bash`, `Agent` (subagent), `PowerShell`, `Workflow` | ✅ 是 — 阻塞中可用 Ctrl+B |
| **天生后台运行** | `Monitor` | ❌ 无需 — 启动即返回 taskId |
| **纯阻塞（瞬时）** | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `TaskCreate/Get/List/Update`, `CronCreate/Delete/List`, `ExitPlanMode`, `EnterPlanMode`, `EnterWorktree`, `ExitWorktree`, `ListMcpResources`, `ReadMcpResource`, `ReportFindings`, `SendMessage`, `ToolSearch`, `WaitForMcpServers`, `Artifact`, `AskUserQuestion`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `ShareOnboardingGuide`, `Skill`, `SendUserFile`, `WebFetch`, `WebSearch` | ❌ 否 — 瞬时完成，无后台概念 |
| **条件性可用** | `LSP` | ❌ 否 — 瞬时 |

#### 关键 SDK 接口

```typescript
// SDK Query 对象上的方法
backgroundTasks(toolUseId?: string): Promise<boolean>;
// toolUseId: 后台化指定 tool_use 启动的任务
// 省略:     后台化所有前台任务（Ctrl+B 语义）
// 返回:     true=至少后台化了一个，false=无匹配的前台任务
```

```typescript
// task_notification 消息结构（来自 sdk.d.ts）
interface SDKTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  task_type: string;       // 'shell' | 'subagent' | 'monitor' | 'workflow' | 'local_workflow'
  status: string;          // 'completed' | 'failed' | 'stopped'
  summary: string;
  error?: string;
  // ... 更多字段待确认
}
```

```typescript
// BackgroundTaskSummary（来自 sdk.d.ts）
interface BackgroundTaskSummary {
  id: string;
  type: string;            // 同 task_type
  status: string;
  description: string;
  command?: string;        // Bash 命令
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
}
```

#### Ctrl+B 的精确行为

- **可后台化的**：正在执行的 Bash 命令、正在运行的 Agent (subagent)、PowerShell 命令
- **不可后台化的**：瞬时工具（Read/Glob/Grep 等）、Monitor（本身就在后台）、AskUserQuestion（等待用户输入）
- **Tmux 用户**：需按两次 Ctrl+B（第一次被 tmux 拦截）
- **SDK 等效**：`backgroundTasks(toolUseId?)` 方法
- **禁用方式**：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`

#### 前后台状态机

```
Bash/Agent 前台运行中
    ↓ Ctrl+B 或 backgroundTasks()
转为后台运行 → tool_result 返回 "running in the background"
    ↓ 后台继续执行
    ↓ SDK 推送 task_notification 消息
完成时 → task_notification (status: completed/failed/stopped)
    ↓ 可用 TaskStop 停止
    ↓ 可用 Read 读取输出文件（TaskOutput 已弃用）
```

**后台→前台**：没有直接的"转回前台"操作。后台任务完成后通过 `task_notification` 通知主对话。

#### CodePilot 当前处理方式

```typescript
// repos/CodePilot/src/lib/claude-client.ts:1858
} else if (sysMsg.subtype === 'task_notification') {
  const taskMsg = sysMsg as SDKSystemMessage & {
    status: string; summary: string; task_id: string;
  };
  // 只提取 3 个字段，丢弃 error/task_type 等
  controller.enqueue(formatSSE({
    type: 'status',
    data: JSON.stringify({ notification: true, title, message: taskMsg.summary || '' }),
  }));
}
```

**关键发现**：CodePilot 只提取了 `status`、`summary`、`task_id` 三个字段，**没有获取后台任务的完整输出内容**。

#### v2.1.198 起 subagent 默认后台运行

- 之前：Claude 根据任务自动选择前台/后台
- 之后：subagent 默认后台运行，只有需要结果才能继续时才前台运行
- 后台 subagent 的权限提示会推到主 session 中（v2.1.186 起）
- 按 Esc 可拒绝单个工具调用而不停止 subagent

## 3. 待完成工作

### 3.1 测试用例设计（需要编写）

建议以下 test cases，每个 case 一个实验：

| Case | 实验内容 | 观察目标 |
|------|---------|---------|
| 1 | Bash 前台运行基线 | tool_use/tool_result 完整序列、input_json_delta 次数 |
| 2 | Bash `run_in_background: true` | tool_result 返回结构、是否有 "running in the background" 文本 |
| 3 | Bash 前台→Ctrl+B→后台 | `backgroundTasks()` 调用前后的消息差异 |
| 4 | Agent 前台 subagent | Agent tool_use 的 input 中 `run_in_background` 字段 |
| 5 | Agent 后台 subagent（默认） | 是否有 task_started/task_notification 消息 |
| 6 | 后台 subagent 完成后 | task_notification 的完整字段结构 |
| 7 | Workflow 工具 | 是否产生 task_started 消息、task_notification 中 task_type 值 |
| 8 | Monitor 工具 | 启动后的 taskId 返回、持续推送的事件类型 |
| 9 | 瞬时工具基线（Read） | 对比确认瞬时工具不产生 task 相关消息 |
| 10 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | 验证后台功能完全禁用后的行为差异 |
| 11 | `forwardSubagentText: true` | subagent 文本是否作为 assistant/user 消息转发 |
| 12 | 后台任务输出文件路径 | tool_result 中是否返回 outputFile 路径 |

### 3.2 关键未验证问题

1. **`task_started` 消息是否存在？** — SDK 类型中提到了 `SDKTaskStartedMessage`，但文档中未见明确描述
2. **后台 Bash 的输出文件路径** — tool_result 中是否返回 `outputFile` / `backgroundTaskId`？
3. **`task_notification` 的完整字段** — error/task_type/outputFile 等是否都在？
4. **`run_in_background` 参数在 API 请求中的体现** — input_json_delta 中是否包含该字段？
5. **Workflow 作为后台任务的 task_type** — 是 'workflow' 还是 'local_workflow'？
6. **前台转后台后 tool_result 的结构变化** — 返回 "running in the background" 的确切格式？
7. **Monitor 的持续推送机制** — 是通过 tool_progress 还是独立的 SDK 消息？

### 3.3 输出要求

完成后应产出：

1. **测试文件**: `test/integration/tool-foreground-background.spec.ts` — 含 12+ cases
2. **OTEL 日志**: `test/integration/tmp/tool-foreground-background/case-*/` — 完整 request/response JSON
3. **洞察文档**: `raw/tool-foreground-background-behavior.md` — 实验矩阵 + 详细发现 + 实际应用建议
4. **project-guide 更新**: 添加文件映射和文档索引

## 4. 测试编写参考

### 4.1 模板

参考已有测试：

```
test/integration/stream-tool-bash.spec.ts     — Bash 工具流式事件观察（含 permissionMode）
test/integration/stream-tool-croncreate.spec.ts — 瞬时工具观察
test/integration/workflow-tool-mechanism.spec.ts — Workflow 工具观察（刚完成的）
```

### 4.2 公共配置

```typescript
const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'http://10.1.3.115:4000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-LLM-NO-THINK-V1',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};
```

### 4.3 关键注意事项

- 本地 LLM 不一定遵循 `run_in_background: true` 指令 — 测试重点放在 **请求结构**（tools 列表、input_json_delta）而非 LLM 输出内容
- `permissionMode: 'bypassPermissions'` 用于自动授权 Bash 等需要权限的工具
- 每个 case 设 120000ms 超时
- 先 console.error 观察实际值，再写精确断言
- `settingSources: []` 隔离测试，但会阻止 skill 发现

### 4.4 事件收集方法

参考 `stream-tool-bash.spec.ts` 中的 `collectSDKEvents()` 函数：

```typescript
interface CapturedSDKEvent {
  index: number;
  type: string;             // SDK 消息 type
  subtype?: string;         // system 消息的 subtype
  eventType?: string;       // event.type
  deltaType?: string;       // delta.type
  toolName?: string;
  toolUseId?: string;
  inputJsonSnippet?: string;
}
```

重点关注：
- `system` 消息中 `subtype === 'task_started'` 或 `'task_notification'` 的出现
- `stream_event` 中 `input_json_delta` 是否包含 `run_in_background` 字段
- `tool_result` 中是否返回后台任务 ID 或输出文件路径

## 5. SDK 类型关键位置

```
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
  - line ~2507: backgroundTasks() 方法定义
  - line ~2868: SDKControlBackgroundTasksRequest 类型
  - line ~131:  BackgroundTaskSummary 类型
  - line ~4229: task_started.workflow_name 字段
  - line ~3453: WorkflowOutput 类型（含 taskType/workflowName/runIdForResume）
  - line ~6433: StopHookInput 中的 background_tasks 字段

node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts
  - line ~2462: WorkflowInput 类型（含 script/name/scriptPath/args/resumeFromRunId）
  - line ~3453: WorkflowOutput 类型
```

## 6. 相关文件索引

```
docs/handoffs/foreground-background-tools.md    ← 本文件（交接文档）
raw/claude-code-docs/docs/tools-reference.md    ← 工具全景
raw/claude-code-docs/docs/sub-agents.md         ← subagent 前后台机制
raw/claude-code-docs/docs/interactive-mode.md   ← Ctrl+B 行为
raw/claude-code-docs/docs/keybindings.md        ← 快捷键映射
raw/claude-code-docs/docs/agent-view.md         ← 后台 session 管理
raw/claude-code-docs/docs/workflows.md          ← Workflow 运行机制
repos/CodePilot/src/lib/claude-client.ts        ← CodePilot 的 task_notification 处理
repos/CodePilot/src/lib/agent-task-runner.ts    ← CodePilot headless runner
repos/CodePilot/src/lib/headless-claude.ts      ← 服务端流消费实现
test/integration/stream-tool-bash.spec.ts       ← Bash 事件收集模板
test/integration/workflow-tool-mechanism.spec.ts ← 刚完成的 Workflow 测试
```

---

**下一步**：研究院 Agent 请从 3.1 节的测试用例设计开始，逐个编写 case → 运行测试 → 观察 OTEL 日志 → 编写洞察文档 `raw/tool-foreground-background-behavior.md`。
