# SDK 对象 id 体系与父子/关联关系知识图谱

> 调研人：Claude Code
> 日期：2026-07-25
> 数据来源：`test/integration/tool-foreground-background.spec.ts`（case-1~28）实测 + `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 类型定义
> 目的：从 `session_id` 出发，梳理 `@anthropic-ai/claude-agent-sdk` 一次 `query()` 生命周期内所有对象的 id 体系、父子层级与关联关系，供 CodePilot 等调用方建立本地对象树。

---

## 一、id 术语表

| id | 属于谁 | 格式示例 | 唯一性 | 来源/证据 |
|----|--------|---------|--------|----------|
| `session_id` | 整个会话（一次 query 生命周期） | UUID | 会话级唯一，贯穿所有消息 | 全 case 实测 |
| `uuid` | 每一条 wire 消息 | UUID | 消息级唯一（非对象标识） | 类型定义，全消息都带 |
| **block id**（`tool_use.id`） | LLM 的一次工具调用 | `call_1c1aa79a...` / `toolu_xxx` | 工具调用级唯一 | case-15/24 实测 |
| `tool_use_id` | task/result/progress 消息 | `call_1c1aa79a...` | **回指** block id | case-15/17 实测 |
| `task_id` | 一个后台任务 | `byvx0or21` | 任务级唯一 | case-17b 实测 |
| `backgroundTaskId` | tool_result 里的后台任务标识 | `byvx0or21` | **== task_id** | case-17b 实测 |
| `parent_tool_use_id` | assistant/tool_progress 消息 | `call_xxx` 或 `null` | 指向发起它的父 tool_use | case-24 实测 |
| `agent_id` | 一个 subagent 实例 | — | subagent 级 | 仅 hook input（未在事件流实测） |

---

## 二、层级树（从 session_id 展开）

```
session_id ── 一次 query() 的根，所有消息都带 session_id + 自己的 uuid
│
├── turn（对话轮次，无独立 id，用 result 消息分隔）
│   │
│   ├── assistant message  { uuid, parent_tool_use_id, subagent_type? }
│   │   └── message.content[]  内容块数组
│   │       ├── text block
│   │       └── tool_use block  ★ id = "call_xxx"  ← 【block id】
│   │           │                  name = Bash / Agent / Workflow / ...
│   │           │
│   │           ├──→ user message → tool_result { tool_use_id }
│   │           │        tool_use_id === 上面的 block id（工具调用回填）
│   │           │        后台时额外带 backgroundTaskId（== task_id）
│   │           │
│   │           └──→ [若进入后台] task 对象
│   │                 ├── task_started      { task_id, tool_use_id, task_type }
│   │                 │      tool_use_id === block id；task_id 为任务唯一身份
│   │                 ├── task_progress     { task_id, tool_use_id, subagent_type? }
│   │                 ├── task_notification { task_id, tool_use_id, output_file, status }
│   │                 └── task_updated      { task_id }  ⚠️ 仅 task_id，无 tool_use_id
│   │
│   └── tool_progress { tool_use_id, parent_tool_use_id, task_id? }
│
└── subagent（Agent 工具启动的子代理）
    │  外层 Agent 的 tool_use block.id = 子代理的"根 tool_use"
    └── 子代理内部 assistant message
         parent_tool_use_id === 外层 Agent block.id   ← case-24 实测钉死
         subagent_type = "general-purpose" / ...
         └── 内部再有自己的 tool_use blocks（可嵌套下去）
```

---

## 三、三条核心"身份链"（实测钉死）

```
① 工具调用链（case-15）
   tool_use.id ═══ tool_result.tool_use_id
   「谁的调用回填谁的结果」

② 后台任务链（case-17）
   tool_use.id ═══ task_started.tool_use_id ──→ task_id
   「哪个工具调用变成了哪个后台任务」

③ 任务标识链（case-17b）
   task_id ═══ backgroundTaskId ═══ {task_id}.output 文件名主干
   「后台任务的唯一身份，贯穿 tool_result / notification / 输出文件」

④ 嵌套链（case-24）
   外层 Agent block.id ═══ subagent 内部 assistant.parent_tool_use_id ═══ task_started.tool_use_id
   「主线程调用 → 子代理 → 子代理内部调用，三者同源」
```

---

## 四、各 task 消息是否带 tool_use_id（建 map 关键）

| 消息 | task_id | tool_use_id | 建 map 用哪个 key |
|------|---------|-------------|------------------|
| `task_started` | ✅ | ✅ | 建条目，记下两者 |
| `task_progress` | ✅ | ✅ | 任选 |
| `task_notification` | ✅ | ✅ | 任选 |
| `task_updated` | ✅ | ❌ **无** | **只能用 task_id** |

> ⚠️ **关键坑（case-21）**：`task_updated` 是唯一不带 `tool_use_id` 的 task 消息。若本地 map 用 `tool_use_id` 做主键，`task_updated` 的 status 更新（如 killed）就落不进去。**主键必须用 `task_id`**，四种消息才都能命中。

---

## 五、给 CodePilot 的落地建议

1. **维护本地 task map**：`Map<task_id, {toolUseId, type, status, outputFile, ...}>`。
   - `task_started` → 建条目，绑定 `tool_use_id`（即知道这个 task 属于哪次工具调用）
   - `task_progress` / `task_notification` → 更新（可用 task_id 或 tool_use_id）
   - `task_updated` → **只能用 task_id** 更新 status
2. **SDK 无"主动查任务列表"接口**：Query 对象上没有 `listTasks()`。`BackgroundTaskSummary[]` 只在 `StopHookInput` / `SubagentStopHookInput` 的 `background_tasks` 字段里以快照形式被动送达（sdk.d.ts:6433/6474）。要"随时拿列表"须自己累积上述 map（纯读事件流，无阻塞）。
3. **嵌套树用 parent_tool_use_id 还原**：subagent 内部消息的 `parent_tool_use_id` 指向发起它的 Agent block.id，逐层上溯即可重建调用树。
4. **输出文件路径**：显式后台 / 手动转后台的 `output_file` 在 tool_result / notification 直接给；自动后台化的 `notification.output_file` 为 null，须用 `{tmp}/claude/{sanitized-cwd}/{session_id}/tasks/{task_id}.output` 拼（case-19/17b）。

---

## 六、诚实标注（未完全坐实项）

- **①②③④ 身份链**：case-15/17/17b/24 均有实测对照，**已坐实**。
- **`agent_id`**：仅在 hook input（SubagentStart/Stop）类型定义里出现，普通事件流未直接观测到，**未实测**其与 tool_use_id 的关系。
- **`task_progress.tool_use_id == block.id`**：case-20 实测有值，但未专门对照是否等于 block.id（因共享 task_id 可合理推断一致，非直接证据）。
- **多层嵌套（subagent 内再起 subagent）**：case-24 只验证了一层嵌套，更深层级的 parent_tool_use_id 链未实测。

---

## 相关文件

```
raw/tool-foreground-background-behavior.md   ← 后台 tool use 生命周期完整实验（case-1~28）
test/integration/tool-foreground-background.spec.ts  ← 全部 case 源码
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts ← SDK 类型定义
  - line 2762: SDKAssistantMessage（parent_tool_use_id / subagent_type）
  - line 4177-4258: 四种 task 消息类型
  - line 131: BackgroundTaskSummary
  - line 6433/6474: StopHookInput / SubagentStopHookInput 的 background_tasks
```
