# Workflow Web UI 设计方案（V2 — 聊天窗口为核心）

> 基于 SDK 可观测性研究：task_* 事件流、output_file 结构化结果、env 配置组机制
> 日期：2026-07-08
> 状态：设计阶段

---

## 一、设计目标

以**聊天窗口**为主要交互通道，后台任务面板为辅：
- **聊天窗口**：启动 workflow、接收中间回复、收到最终完成通知
- **后台任务列表**：查看运行中的 workflow 结构、展开查看每个子任务的实时进度和历史输出

---

## 二、总体布局

```
┌────────────────────────────────────────────────────────────────────┐
│ Header                                                             │
│ [Logo]  Claude Code    [Env: JEREH ▼]                              │
├──────────────────────────┬─────────────────────────────────────────┤
│                          │                                         │
│  聊天窗口                 │  后台任务面板 (可折叠，默认 380px)        │
│  (Chat Window)           │  ┌───────────────────────────────────┐  │
│                          │  │ 🔍 搜索任务                        │  │
│  ┌────────────────────┐  │  ├───────────────────────────────────┤  │
│  │                    │  │  │                                   │  │
│  │  消息列表           │  │  │  ⚡ Background Tasks (3)          │  │
│  │                    │  │  │                                   │  │
│  │  [user] 帮我跑      │  │  │  ▼ sprint-serial   ⏳ Running    │  │
│  │  sprint-serial      │  │  │    w7gi3nljk  ·  3/5 tasks       │  │
│  │                    │  │  │    ┌──────────────────────────┐  │  │
│  │  [assistant] 好的   │  │  │    │ task-1    ✅  completed  │  │  │
│  │  启动 workflow…     │  │  │    │   ├─ dev   ✅  1 attempt │  │  │
│  │                    │  │  │    │   └─ test  ✅  passed     │  │  │
│  │  [task_card]        │  │  │    ├──────────────────────────│  │  │
│  │  sprint-serial      │  │  │    │ task-2    ✅  completed  │  │  │
│  │  ⏳ Running         │  │  │    ├──────────────────────────│  │  │
│  │  [查看完整进度 →]    │  │  │    │ task-3    ⏳  running    │  │  │
│  │                    │  │  │    │   ├─ dev   ⏳  attempt 2  │  │  │
│  │  [assistant] dev    │  │  │    │   │        tokens: 12K   │  │  │
│  │  agent for task-1   │  │  │    │   │        tools: 3      │  │  │
│  │  正在读取文件…      │  │  │    │   └─ test  ⏸  waiting    │  │  │
│  │                    │  │  │    ├──────────────────────────│  │  │
│  │  [assistant] task-1 │  │  │    │ task-4    ⏹  pending     │  │  │
│  │  ✅ 测试通过！      │  │  │    │ task-5    ⏹  pending     │  │  │
│  │                    │  │  │    └──────────────────────────┘  │  │
│  │  [assistant] task-2 │  │  │                                   │  │
│  │  ✅ 测试通过！      │  │  │  ─────────────────────────────  │  │
│  │                    │  │  │                                   │  │
│  │  [assistant] dev    │  │  │  ✅ sprint-serial    2m30s ago   │  │
│  │  agent 正在修复…    │  │  │    w351c20  ·  5/5 · 28K tokens │  │
│  │                    │  │  │                                   │  │
│  │  ...                │  │  │  ❌ sprint-serial    5h ago       │  │
│  │                    │  │  │    w7abc12  ·  2/5 · stopped     │  │
│  │                    │  │  │                                   │  │
│  └────────────────────┘  │  └───────────────────────────────────┘  │
│  ┌────────────────────┐  │                                         │
│  │ [💡 模板 ▼]        │  │                                         │
│  │ 输入消息…          │  │                                         │
│  │                    │  │                                         │
│  │ ────────────────   │  │                                         │
│  │ Env: [JEREH ▼]     │  │                                         │
│  │ Model: [sonnet ▼]  │  │                                         │
│  └────────────────────┘  │                                         │
│                          │                                         │
└──────────────────────────┴─────────────────────────────────────────┘
```

---

## 三、核心交互流程

### 3.1 启动 Workflow

```
用户输入:
┌──────────────────────────────────────────┐
│ 帮我跑 sprint-serial，tasks 如下:        │
│ [JSON args 预览]                         │
│                                          │
│ [🚀 发送]  [📎 加载模板]                  │
└──────────────────────────────────────────┘

聊天窗口收到:
┌──────────────────────────────────────────┐
│ 🤖 好的，已启动 sprint-serial workflow   │
│                                          │
│ ┌─ Workflow Card ────────────────────┐   │
│ │ sprint-serial                      │   │
│ │ Status: ⏳ Running                 │   │
│ │ [查看完整进度 →] (点击展开右侧面板) │   │
│ └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

### 3.2 运行中的实时更新

**聊天窗口**（增量消息流式到达）：

```
┌──────────────────────────────────────────┐
│ 🤖 task-1 dev agent 正在读取文件…        │
│                                          │
│ 🤖 task-1 dev agent 已完成，             │
│    修改了 2 个文件                        │
│                                          │
│ 🤖 task-1 测试运行中…                    │
│                                          │
│ 🤖 ✅ task-1 测试通过！                  │
│    Test Suites: 1 passed, 1 total         │
│                                          │
│ 🤖 开始 task-2…                          │
│                                          │
│ 🤖 task-2 dev agent (attempt 1/3)        │
│    ⏳ 正在分析需求…                       │
└──────────────────────────────────────────┘
```

**右侧面板**（结构化的任务树实时更新）：

```
▼ sprint-serial   ⏳ Running
  ┌─ task-1 ──────────────── ✅ 28s ─┐
  │ ✅ dev   (1 attempt, 8K tokens)  │
  │ ✅ test  (passed)                │
  └──────────────────────────────────┘
  ┌─ task-2 ──────────────── ⏳ 12s ─┐
  │ ⏳ dev   (attempt 1/3)            │
  │    tokens: 5,230                 │
  │    tools: Read → Grep → Edit     │
  │    ┌─ live output ────────────┐  │
  │    │ Reading src/api/...      │  │
  │    │ Editing handler.ts +3/-1 │  │
  │    │ Running npm test...      │  │
  │    └──────────────────────────┘  │
  │ ⏸ test  (waiting for dev)       │
  └──────────────────────────────────┘
  ├─ task-3  ⏹ pending
  ├─ task-4  ⏹ pending
  └─ task-5  ⏹ pending
```

### 3.3 运行完成

**聊天窗口收到最终通知**：

```
┌──────────────────────────────────────────┐
│ 🤖 ✅ sprint-serial 已完成！             │
│                                          │
│ ┌─ Result Card ──────────────────────┐   │
│ │ sprint-serial  completed  2m30s    │   │
│ │                                    │   │
│ │ ✅ task-1  (1 attempt)             │   │
│ │ ✅ task-2  (2 attempts)            │   │
│ │ ✅ task-3  (1 attempt)             │   │
│ │ ✅ task-4  (1 attempt)             │   │
│ │ ✅ task-5  (3 attempts)            │   │
│ │                                    │   │
│ │ Total: 28,655 tokens · 6 tool uses │   │
│ │ [📥 下载完整结果] [🔍 查看详情]     │   │
│ └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

完成后，右侧面板中的该任务从 "Running" 区域移到历史列表。

### 3.4 快速启动方式

**方式 1：自然语言** — 直接在聊天窗口输入需求
**方式 2：模板选择** — `[💡 模板 ▼]` → 选择 workflow → 弹出 args 编辑框 → 发送
**方式 3：快捷命令** — `/workflow sprint-serial --env jereh --args '{...}'`

---

## 四、右侧后台任务面板

### 4.1 面板结构

```
┌─ Background Tasks Panel ────────────────────────────┐
│ 🔍 搜索任务...                                       │
├───────────────────────────────────────────────────────┤
│                                                      │
│  ▸ 运行中 (1)                                        │
│                                                      │
│  ▼ sprint-serial              ⏳  Running             │
│  w7gi3nljk  ·  started 33s ago                       │
│  ┌────────────────────────────────────────────────┐  │
│  │                                                │  │
│  │  ✅ task-1                           28s       │  │
│  │  ┌─ detail (可展开) ───────────────────────┐  │  │
│  │  │  ✅ dev    1 attempt  ·  8K tokens      │  │  │
│  │  │     [查看 prompt]  [查看输出]            │  │  │
│  │  │  ✅ test   passed  ·  2K tokens         │  │  │
│  │  │     [查看输出]                          │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                                │  │
│  │  ✅ task-2                           15s       │  │
│  │  ┌─ detail ─────────────────────────────────┐ │  │
│  │  │  ✅ dev    2 attempts  ·  12K tokens     │ │  │
│  │  │  ✅ test   passed  ·  3K tokens          │ │  │
│  │  └──────────────────────────────────────────┘ │  │
│  │                                                │  │
│  │  ⏳ task-3                           12s       │  │
│  │  ┌─ detail ─────────────────────────────────┐ │  │
│  │  │  ⏳ dev    attempt 2/3  ·  5.2K tokens   │ │  │
│  │  │     ┌─ Progress ───────────────────┐     │ │  │
│  │  │     │ Summary: Editing handler.ts  │     │ │  │
│  │  │     │ Tokens: 5,230                │     │ │  │
│  │  │     │ Tools: 3                     │     │ │  │
│  │  │     │ ████████████░░░░░░  65%      │     │ │  │
│  │  │     └──────────────────────────────┘     │ │  │
│  │  │     ┌─ Live Output ────────────────┐     │ │  │
│  │  │     │ ⏳ Reading: src/api/handler   │     │ │  │
│  │  │     │ ✅ Edit: handler.ts +3/-1     │     │ │  │
│  │  │     │ ⏳ Running: npm test -- task-3│     │ │  │
│  │  │     │ ...                           │     │ │  │
│  │  │     └──────────────────────────────┘     │ │  │
│  │  │                                          │ │  │
│  │  │  ⏸ test   (waiting for dev)              │ │  │
│  │  └──────────────────────────────────────────┘ │  │
│  │                                                │  │
│  │  ⏹ task-4                          pending     │  │
│  │  ⏹ task-5                          pending     │  │
│  │                                                │  │
│  │  ────────────────────────────────────────      │  │
│  │  Controls:                                     │  │
│  │  [⏹ 停止]  [⏸ 暂停当前]                        │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ──────────────────────────────────────────────      │
│                                                      │
│  ▸ 历史记录 (12)                                     │
│                                                      │
│  ✅ sprint-serial    2m30s ago    28K tokens         │
│     w351c20  ·  5/5 tasks                            │
│                                                      │
│  ❌ sprint-serial    5h ago       stopped            │
│     w7abc12  ·  2/5 tasks                            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 4.2 展开/折叠交互

- **折叠状态**：只显示 workflow 名称 + 状态 + 进度条
- **展开状态**：显示每个 task 的子任务详情
  - ✅ 已完成：可展开查看 prompt、输出、token 用量
  - ⏳ 运行中：实时更新 live output + progress bar
  - ⏹ 未运行：灰色显示 pending

### 4.3 面板折叠

右侧面板可折叠，只留一个窄条显示运行中的任务数量：

```
┌───┐
│ 🔔│  ← 3 个运行中
│ 2 │
└───┘
```

### 4.4 底部输入栏

```
┌────────────────────────────────────────────────────┐
│ [💡 模板 ▼]  [📎 文件]                              │
│                                                    │
│ ┌────────────────────────────────────────────────┐ │
│ │ 输入消息或启动 workflow…                        │ │
│ │                                                │ │
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ ────────────────────────────────────────────────   │
│ Env: [JEREH ▼]   Model: [sonnet ▼]   [🚀 发送]    │
└────────────────────────────────────────────────────┘
```

---

## 五、聊天窗口中的消息类型

### 5.1 消息类型映射

| 消息类型 | 触发来源 | SSE 事件 | 展示形式 |
|----------|---------|---------|---------|
| 用户消息 | 用户输入 | — | 普通聊天气泡 |
| AI 文本回复 | assistant text | `text` / `partial` | 普通聊天气泡 |
| Workflow 启动 | LLM 调用 Workflow 工具 | `task_started` (local_workflow) | 嵌入聊天窗口的卡片 |
| 阶段完成 | agent 完成 | `task_notification` + `text` | 普通聊天消息 |
| Workflow 完成 | 所有任务结束 | `task_notification` (workflow) | 嵌入聊天窗口的结果卡片 |

### 5.2 Workflow 卡片样式

```
┌─ Workflow Card (running) ──────────────────────────┐
│ 📋  sprint-serial                                   │
│                                                     │
│ Status:  ⏳ Running                                 │
│ [▶ 查看完整进度]  (点击展开右侧面板)                 │
└─────────────────────────────────────────────────────┘

┌─ Result Card (completed) ──────────────────────────┐
│ 📋  sprint-serial                                   │
│ Status:  ✅ Completed  ·  2m30s                     │
│ Total:  28,655 tokens · 6 tool uses                 │
│ ✅ task-1  task-2  task-3  task-4  task-5           │
│ [📥 下载结果]  [🔍 查看运行详情]                     │
└─────────────────────────────────────────────────────┘

┌─ Failed Card (failed/stopped) ─────────────────────┐
│ 📋  sprint-serial                                   │
│ Status:  ❌ Failed  ·  1m12s                        │
│ ✅ task-1  ❌ task-2 (3 attempts, exhausted)        │
│ [🔍 查看失败详情]  [🔁 重试从 task-2]               │
└─────────────────────────────────────────────────────┘
```

---

## 六、SDK 可观测通道

### 6.1 可用消息通道（已验证）

| 事件类型 | 触发时机 | 前端用途 | SSE 推送 |
|----------|---------|---------|---------|
| `task_started` | workflow/agent/bash 启动 | 创建任务节点 | ✅ |
| `task_progress` | 后台任务运行中 | 更新进度 + token | ✅ |
| `task_updated` | 任务状态变更 | 更新状态标签 | ✅ |
| `task_notification` | 任务完成/失败 | 关闭节点，展示结果 | ✅ |
| `text` (assistant) | LLM 文本输出 | 聊天消息 | ✅ |
| `stream_event` (partial) | 工具调用增量 | 实时输出 | ✅ |

### 6.2 不可达通道（SDK 限制）

| 通道 | 原因 | 替代方案 |
|------|------|---------|
| `session_state_changed` | SDK 过滤，不在 for await 中 | 用 task_started/notification |
| `getBackgroundTasks()` | SDK 有类型但无 API | 前端自行维护 taskStates Map |

### 6.3 task_type 分类

| task_type | 来源 | 前端展示 |
|-----------|------|---------|
| `local_workflow` | Workflow 工具 | 右侧面板根节点 |
| `local_agent` | Agent subagent | workflow 下的子节点 |
| `local_bash` | Bash/PowerShell 后台 | agent 下的终端输出 |

---

## 七、控制能力设计

### 7.1 控制手段

| 控制操作 | SDK 支持 | 实现方案 |
|----------|---------|---------|
| 整体中断 | `query.interrupt()` | abortController.abort() |
| 停止单个 agent | TaskStop 工具 | 写控制文件 + TaskStop |
| 暂停/恢复 | ❌ 不支持 | workflow 脚本内轮询控制文件 |
| 跳过任务 | ❌ 不支持 | workflow 脚本内读取控制文件 |

### 7.2 控制文件协议

```
.claude/workflow-control/{taskId}-{label}.json

{
  "action": "skip" | "pause" | "resume" | "stop" | "retry",
  "timestamp": "2026-07-08T10:23:00Z"
}
```

workflow 脚本在每个 `agent()` 调用前后检查控制文件：

```javascript
// 调用前检查
const ctrl = checkControl('task-3', 'dev')
if (ctrl === 'skip') { /* 跳过 */ }
if (ctrl === 'pause') { /* 轮询等待 resume/stop */ }

// 执行 agent
const result = await agent(prompt, { label: 'dev:task-3' })

// 调用前检查（test 阶段）
const testCtrl = checkControl('task-3', 'test')
```

### 7.3 前端控制按钮

| 按钮 | 位置 | 操作 |
|------|------|------|
| ⏹ 停止 | 右侧面板 workflow 级别 | 写 `{action:'stop'}` + interrupt |
| ⏸ 暂停 | 右侧面板 task 级别 | 写 `{action:'pause'}` |
| ▶ 恢复 | 右侧面板 paused task | 写 `{action:'resume'}` |
| ⏭ 跳过 | 右侧面板 pending/running | 写 `{action:'skip'}` |
| 🔁 重试 | 右侧面板 failed task | 写 `{action:'retry'}` |

---

## 八、后端 API 设计

### 8.1 现有端点

| Method | Path | 用途 | 状态 |
|--------|------|------|------|
| POST | `/api/query` | 启动（SSE 流） | ✅ 现有 |
| POST | `/api/query/interrupt` | 中断 session | ✅ 现有 |

### 8.2 新增端点

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/tasks` | 获取所有任务快照（运行中 + 历史） |
| GET | `/api/tasks/:taskId` | 单个任务详情（含子任务树） |
| POST | `/api/tasks/:taskId/control` | 控制子任务 `{action}` |
| GET | `/api/tasks/:taskId/output` | 获取 output_file 内容 |
| GET | `/api/env-groups` | 可用配置组列表 |
| GET | `/api/env-groups/:name` | 配置组详情（脱敏） |

### 8.3 SSE 事件分类

```typescript
// query.service.ts messageToEvent 扩展
private messageToEvent(message: any): QueryEventData {
  if (message.type === 'system') {
    switch (message.subtype) {
      case 'task_started':
        return { type: 'task_started', taskId: message.task_id,
          taskType: message.task_type, description: message.description,
          workflowName: message.workflow_name, ts: Date.now() };
      case 'task_progress':
        return { type: 'task_progress', taskId: message.task_id,
          summary: message.summary, usage: message.usage, ts: Date.now() };
      case 'task_notification':
        return { type: 'task_notification', taskId: message.task_id,
          status: message.status, summary: message.summary,
          output: readOutputFile(message.output_file),
          usage: message.usage, ts: Date.now() };
    }
  }
  if (message.type === 'stream_event') return { type: 'partial', content: JSON.stringify(message) };
  return { type: 'text', content: JSON.stringify(message) };
}
```

### 8.4 后端 TaskState 维护

```typescript
// query.service.ts 在 processStream 中同步更新
const taskStates = new Map<string, TaskState>();
for await (const message of sdkQuery) {
  if (message.subtype === 'task_started') taskStates.set(message.task_id, {...});
  if (message.subtype === 'task_notification') updateTaskState(message);
  subscriber.next(this.messageToEvent(message));
}
```

---

## 九、前端数据流

### 9.1 数据流

```
用户输入 → POST /api/query → SSE 流
                                    ↓
                    ┌───────────────┴───────────────┐
                    ↓                               ↓
            聊天消息队列                      TaskStore
         (ChatMessage[])                  (Map<taskId, TaskState>)
                    ↓                               ↓
            聊天窗口渲染                    右侧后台任务面板
         (气泡 + 卡片)                    (树形结构 + 实时更新)
```

### 9.2 SSE 事件到 UI 的映射

| SSE 事件 | 聊天窗口 | 后台任务面板 |
|----------|---------|-------------|
| `task_started` (workflow) | 插入 Workflow Card | 创建 workflow 根节点 |
| `task_started` (agent) | — | 创建 agent 子节点 |
| `task_started` (bash) | — | 创建 bash 子节点 |
| `task_progress` | — | 更新 progress + usage |
| `text` / `partial` | 追加 assistant 消息 | — |
| `task_notification` (agent) | 插入 "✅ 通过" 消息 | 标记 completed |
| `task_notification` (workflow) | 更新 → Result Card | 移入历史 |
| `done` | 关闭 SSE | — |
| `error` | 显示错误 | 标记 running → failed |

### 9.3 TaskStore

```typescript
interface TaskStore {
  activeTasks: Map<string, TaskState>;
  history: TaskState[];
  onSSEEvent(event: SSEEvent): void;
  stopTask(taskId: string): Promise<void>;
  pauseTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  skipTask(taskId: string): Promise<void>;
  getTaskTree(workflowId: string): TaskNode[];
  getActiveWorkflows(): TaskState[];
}

interface TaskState {
  id: string;
  type: 'local_workflow' | 'local_agent' | 'local_bash';
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  description: string;
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  output?: any;
  error?: string;
  children: string[];
  parentId?: string;
  sessionId: string;
  startedAt: number;
  completedAt?: number;
}
```

---

## 十、SSE 事件流协议

### 10.1 启动请求

```
POST /api/query
{
  "prompt": "Run sprint-serial with args: {...}",
  "options": {
    "env": { /* loadEnvGroupWithDefaults('jereh') */ },
    "forwardSubagentText": true,
    "agentProgressSummaries": true,
    "includePartialMessages": true
  }
}
```

### 10.2 事件流

```
data: {"type":"system","subtype":"init","sessionId":"s123","ts":...}
data: {"type":"task_started","taskId":"w7gi3nljk","taskType":"local_workflow","workflowName":"sprint-serial","ts":...}
data: {"type":"text","content":"好的，已启动 sprint-serial...","ts":...}
data: {"type":"task_started","taskId":"a351c20","taskType":"local_agent","description":"dev agent for task-1","ts":...}
data: {"type":"task_progress","taskId":"a351c20","summary":"Reading...","usage":{"total_tokens":5230},"ts":...}
data: {"type":"text","content":"task-1 dev agent 正在读取文件…","ts":...}
data: {"type":"task_notification","taskId":"a351c20","status":"completed","usage":{"total_tokens":12500},"ts":...}
data: {"type":"text","content":"✅ task-1 dev 完成！","ts":...}
...
data: {"type":"task_notification","taskId":"w7gi3nljk","status":"completed","output":{...},"ts":...}
data: {"type":"done","ts":...}
```

---

## 十一、Env 配置组集成

底部输入栏集成环境选择：

```
Env: [JEREH ▼]
  JEREH (JEREH Proxy)
  ANTHROPIC (直连)
  Custom...

配置预览:
  ANTHROPIC_BASE_URL: http://aiproxy.jereh.cn:4000
  ANTHROPIC_AUTH_TOKEN: sk-***-***
  API_TIMEOUT_MS: 3000000
```

后端端点：
- `GET /api/env-groups` → `{ groups: ['jereh', 'anthropic'] }`
- `GET /api/env-groups/:name` → 脱敏后的配置

---

## 十二、状态持久化

```
.claude/workflow-runs/
├── w7gi3nljk/
│   ├── meta.json          // name, args, env, startedAt
│   ├── events.ndjson      // 完整 SSE 事件流
│   ├── output.json        // workflow 最终结果
│   └── tasks/
│       ├── a351c20.output
│       └── bgouhkf54.output
```

右侧面板历史列表展示所有历史运行，点击可展开查看完整任务树和输出。

---

## 十三、实现路径

### Phase 1：基础可观察（MVP）

1. 扩展 `query.service.ts` — `messageToEvent()` 分类 task_* 事件
2. 新增 `/api/tasks` — 获取当前任务快照
3. 前端：聊天窗口 — 消息列表 + Workflow Card
4. 前端：后台任务面板 — SSE 事件构建树形结构

### Phase 2：任务级控制

1. 控制文件机制 — workflow 脚本读取 `.claude/workflow-control/*.json`
2. 修改 `sprint-serial.js` — 集成控制文件检查
3. 新增 `/api/tasks/:id/control` — 写控制文件 + TaskStop
4. 前端：右侧面板控制按钮

### Phase 3：完整体验

1. Env 配置组选择器（底部输入栏）
2. 历史查看（右侧面板历史列表）
3. 输出文件查看（展开已完成 task）
4. 模板系统（预设 workflow args）

---

## 十四、注意事项

1. **task_progress 推送频率未测量** — 前端不应依赖固定间隔
2. **task_updated 完整结构待解析** — 当前按 passthrough 处理
3. **多个并行 workflow 隔离未验证** — 需通过 sessionId + taskId 隔离
4. **output_file 是本地绝对路径** — 后端需安全验证，不能直接返回任意路径
5. **workflow 总是异步后台运行** — SSE 连接需保持直到完成
6. **SSE 断开 = workflow 中断** — 后端需在断开后保持 query 运行、缓存事件、支持重连
