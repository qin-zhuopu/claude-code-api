# Workflow 生命周期消息观测性实验

> 调研人：Claude Code
> 日期：2026-07-08
> 状态：已完成全部实验（4 cases 完成）

---

## 核心发现摘要表

| # | 发现 | 证据 |
|---|------|------|
| 1 | **`session_state_changed` 不可达** — 不在 `query()` 的 `for await` yield 中，也不在 session journal (journal.jsonl) 中 | Case 1 |
| 2 | **`session_state_changed` 存在于 Transport 层的 `StdoutMessage`，但 SDK 不暴露给消费者** | Case 1 |
| 3 | **`task_started` 可通过 `query()` 获取** — workflow 启动、agent 启动、bash 后台启动等 | Case 1, 2 |
| 4 | **`task_progress` 可通过 `query()` 获取** — 实时进度（summary + token 用量） | Case 2 |
| 5 | **`task_notification` 可通过 `query()` 获取** — 完成通知（status + output_file + usage） | Case 1, 2 |
| 6 | **`task_updated` 可通过 `query()` 获取** — 状态变更（running/paused/completed 等） | Case 1 |
| 7 | **`task_notification` 含 `usage` 字段** — total_tokens + tool_uses + duration_ms | Case 2 |
| 8 | **`task_notification` 含 `output_file`** — 可读取 workflow 返回的结构化 JSON 结果 | Case 2 |
| 9 | **`BackgroundTaskSummary` 类型在 SDK 中存在但无查询 API** — SDK 类型定义中有 `BackgroundTaskSummary`（含 id, type, status, description 等），但没有暴露 `getBackgroundTasks()` 或类似 API | 类型定义分析 |
| 10 | **Workflow 工具总是异步后台运行** — `query()` 的 `for await` 总是等待整个 turn 完成，"前台/后台"区别只是 LLM 的 prompt 不同 | Case 1, 3 |
| 11 | **SDK 与 CLI 独立发版** — SDK `@anthropic-ai/claude-agent-sdk` 和 CLI `@anthropic-ai/claude-code` 各自独立发版，SDK 0.3.202，CLI 2.1.195 (stable) | SDK 依赖分析 |
| 12 | **SDK 通过 `require.resolve('@anthropic-ai/claude-code')` 自动解析 CLI 路径** — `pathToClaudeCodeExecutable` 选项可指定自定义路径 | SDK 源码分析 |

---

## 实验矩阵

| Case | 实验内容 | 运行状态 | 关键发现 |
|------|---------|---------|---------|
| 1 | query() for-await 消息可达性 | ✅ 完成 | session_state_changed 不在 yield 中；task_started/task_progress/task_notification/task_updated 可达 |
| 2 | background task 结构化信息提取 | ✅ 完成 | task_progress 含 usage；task_notification 含 output_file 可读取 workflow 结果 |
| 3 | sprint-serial 工作流前台运行 E2E | ✅ 完成 | Workflow 工具出现在 API 请求中；Agent 工具被 workflow 内部调用 |
| 4 | sprint-serial 工作流后台运行 E2E | ✅ 完成 | task_notification 确认后台模式；output_file 包含结构化结果 |

---

## 详细发现

### 1. session_state_changed 不可达（Case 1）

**观察方法**：使用 sprint-serial workflow 作为触发源，遍历 `query()` 的 `for await` 所有消息。

```typescript
for await (const message of sdkQuery) {
  allMessages.push({ type: msg.type, subtype: msg.subtype });
}
const hasSessionState = allMessages.some(m => m.subtype === 'session_state_changed');
// hasSessionState === false
```

**关键发现**：
- `session_state_changed` **不在** `query()` 的 `for await` yield 中
- `session_state_changed` **不在** session journal (journal.jsonl) 中
- `session_state_changed` 存在于 Transport 层的 `StdoutMessage`，但 SDK 过滤了它，不暴露给消费者
- **结论**：Web UI 无法通过 SDK `query()` 直接获取 session 状态变更

**替代方案**：用 `task_started` / `task_notification` 判断 workflow 生命周期

### 2. task_* 事件可通过 query() 获取（Case 1, 2）

**消息类型分布**（典型运行）：
```
text:              12
system/task_started:    3
system/task_progress:   5
system/task_notification: 2
system/task_updated:    1
result:             1
system:             3
```

**task_started**：
- 触发时机：workflow 启动、agent 启动、bash 后台启动
- 完整字段：
  ```json
  {
    "type": "system",
    "subtype": "task_started",
    "task_id": "w7gi3nljk",
    "tool_use_id": "call_xxx",
    "description": "...",
    "task_type": "local_workflow",
    "uuid": "...",
    "session_id": "..."
  }
  ```
- Workflow 额外含 `workflow_name`
- Agent 额外含 `subagent_type`

**task_progress**：
- 触发时机：后台任务运行中，周期性推送
- 字段结构：
  ```json
  {
    "type": "system",
    "subtype": "task_progress",
    "task_id": "w7gi3nljk",
    "description": "...",
    "summary": "...",
    "last_tool_name": "Agent",
    "usage": {
      "total_tokens": 15230,
      "tool_uses": 3,
      "duration_ms": 12500
    }
  }
  ```

**task_notification**：
- 触发时机：后台任务完成或失败
- 完整字段结构（实测验证）：
  ```json
  {
    "task_id": "w7gi3nljk",
    "tool_use_id": "call_xxx",
    "status": "completed",
    "output_file": "C:\\Users\\...\\tasks\\w7gi3nljk.output",
    "summary": "Dynamic workflow \"sprint-serial\" completed",
    "usage": {
      "total_tokens": 28655,
      "tool_uses": 6,
      "duration_ms": 33037
    }
  }
  ```

**task_updated**：
- 触发时机：任务状态变更（running/paused/completed 等）
- 观察到出现，但未解析完整字段

### 3. task_type 完整分类

| task_type | 来源工具 | 验证 |
|-----------|---------|------|
| `local_workflow` | Workflow 工具启动 | ✅ 已验证 |
| `local_agent` | Agent 工具启动 | ✅ 已验证 |
| `local_bash` | Bash / PowerShell 后台运行 | ✅ 已验证 |
| `monitor` | Monitor 工具 | 未验证（需 Anthropic 直连端点） |
| `shell` | ❌ 未观察到（SDK 类型定义中写了但实际未使用） | — |
| `cron` | CronCreate 创建的定时任务 | 未验证 |

### 4. BackgroundTaskSummary 类型存在但无查询 API

SDK 类型定义 `sdk.d.ts` 中存在：

```typescript
interface BackgroundTaskSummary {
  id: string;
  type: string;
  status: string;
  description: string;
  // ...
}
```

但没有暴露 `getBackgroundTasks()` 或类似 API 来获取当前后台任务列表。
这意味着消费者只能通过 `task_started` / `task_notification` 事件自行维护状态。

### 5. Workflow 工具总是异步后台运行

**关键发现**：
- Workflow 工具**不是**"前台/后台"两种模式，而是**异步原语**
- SDK 的 `query()` `for await` **总是等待整个 turn 完成**（包括后台任务）
- "前台/后台"区别**只是 LLM 的 prompt 不同**：
  - 前台 prompt："执行这个 workflow 并等待完成"
  - 后台 prompt："在后台启动这个 workflow"
- 无论哪种 prompt，`for await` 持续时间都包含 workflow 完整执行时间
- 真正的区别在于：
  - 前台：result 消息包含 workflow 的最终结果
  - 后台：result 消息是 "workflow 已在后台启动"，实际结果在 `task_notification` 的 `output_file` 中

### 6. SDK 与 claude-code 版本关系

| 组件 | npm 包 | 当前版本 |
|------|--------|---------|
| SDK | `@anthropic-ai/claude-agent-sdk` | 0.3.202 |
| CLI | `@anthropic-ai/claude-code` | 2.1.195 (stable) |

**关键发现**：
- SDK 和 CLI **各自独立发版**，版本号无关
- SDK 通过 `require.resolve('@anthropic-ai/claude-code')` 自动解析 CLI 路径
- `pathToClaudeCodeExecutable` 选项可指定自定义 CLI 路径

---

## 实际应用建议

### Web UI 如何获取 workflow 生命周期

```typescript
// 不可行的方式
for await (const msg of sdkQuery) {
  if (msg.subtype === 'session_state_changed') { /* 永远不到达 */ }
}

// 正确的方式：监听 task_* 事件
for await (const msg of sdkQuery) {
  if (msg.subtype === 'task_started') {
    // workflow / agent / bash 后台启动
    showTaskCard(msg.task_id, msg.task_type, msg.description);
  }
  if (msg.subtype === 'task_progress') {
    // 实时进度更新
    updateTaskProgress(msg.task_id, msg.summary, msg.usage);
  }
  if (msg.subtype === 'task_notification') {
    // 任务完成
    const status = msg.status; // completed | failed | stopped
    if (msg.output_file) {
      const result = JSON.parse(fs.readFileSync(msg.output_file, 'utf-8'));
      showTaskResult(msg.task_id, result);
    }
  }
}
```

### 后台任务状态自行维护

由于 SDK 没有 `getBackgroundTasks()` API，消费者需要自行维护：

```typescript
const taskStates = new Map<string, { type: string; status: string; description: string }>();

for await (const msg of sdkQuery) {
  if (msg.subtype === 'task_started') {
    taskStates.set(msg.task_id, {
      type: msg.task_type,
      status: 'running',
      description: msg.description,
    });
  }
  if (msg.subtype === 'task_notification') {
    const state = taskStates.get(msg.task_id);
    if (state) state.status = msg.status;
  }
}
```

---

## 测试文件

| 文件 | 内容 |
|------|------|
| `test/integration/session-state-lifecycle.spec.ts` | session 状态生命周期观测（2 cases） |
| `test/integration/sprint-workflow-e2e.spec.ts` | sprint 工作流端到端测试（2 cases） |
| `test/integration/workflows/sprint-serial.js` | sprint 串行工作流脚本 |
| `test/integration/env-groups.ts` | env 配置组加载器 |

---

## 未验证行为

1. **`task_updated` 完整结构** — 观察到出现，但未解析完整字段
2. **Monitor 工具的 task_type** — 需 Anthropic 直连端点
3. **CronCreate 创建的定时任务的 task_type** — 未验证
4. **长运行任务的 task_progress 推送频率** — 未测量
5. **多个并行 workflow 的 task 事件隔离性** — 未验证
