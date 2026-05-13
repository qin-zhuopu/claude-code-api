# CronList 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-cronlist.spec.ts`
**测试用例数**: 6（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **input_schema 字段** | **空对象 `{}`** — CronList 无参数 |
| **tool_result 结构** | `tool_use_result`: `{jobs: [{id, cron, humanSchedule, prompt, recurring?, durable?}]}` — 任务列表数组 |
| **stream_event 总数** | Case 1: 231（含 CronCreate+CronList+3 轮 LLM）；Case 2: 134 |
| **input_json_delta 推送次数** | **3 次**（`""` → `"{"` → `"}"`）— 所有 case 固定 3 次 |
| **tool_progress 推送次数** | **0 次** — CronList 是瞬时工具 |
| **tool_use_summary 推送次数** | **0 次** |
| **状态更新频率** | 极低 — 仅在 tool_result 注入后有 1 次 system(status) |
| **num_turns** | 2（仅 CronList）；3（CronCreate+CronList）；4（2×CronCreate+CronList） |
| **是否需要不断修改前端状态** | **不需要** — CronList 是瞬时工具，无持续进度 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK init 消息）

CronList 出现在 `system(init)` 消息的 `tools` 数组中。工具名称：`CronList`。

```json
{
  "name": "CronList",
  "description": "List all cron jobs scheduled via CronCreate, both durable (.claude/scheduled_tasks.json) and session-only.",
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**关键特点**: CronList 的 `input_schema.properties` 是空对象，`required` 是空数组。这是所有 SDK 工具中**唯一一个无参数工具**（之一，与 `CronList` 类似的还有 `TaskList` 等）。

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**所有场景均一致**:
```json
{}
```

**关键发现**:
- CronList 的 input 始终是空对象 `{}`
- LLM 不会添加任何额外字段
- 这意味着 `input_json_delta` 的推送模式是固定的 3 次

---

## 二、tool_result 返回值格式

### 2.1 完整结构（来自 user 消息）

SDK 将 CronList 的执行结果包装在 `user` 类型消息中：

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "jobs": [
      {
        "id": "4324c4a1",
        "cron": "0 9 * * *",
        "humanSchedule": "Every day at 9:00 AM",
        "prompt": "Run daily health check",
        "recurring": true
      },
      {
        "id": "c2ba8345",
        "cron": "*/5 * * * *",
        "humanSchedule": "Every 5 minutes",
        "prompt": "Check the build status",
        "recurring": true,
        "durable": false
      }
    ]
  },
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_88e181b4b483443584582e61",
        "content": "4324c4a1 — Every day at 9:00 AM (recurring): Run daily health check\nc2ba8345 — Every 5 minutes (recurring) [session-only]: Check the build status"
      }
    ]
  }
}
```

### 2.2 字段说明

#### tool_use_result（结构化数据）

| 字段 | 类型 | 说明 |
|------|------|------|
| `jobs` | Array | 任务列表（可能为空数组） |

#### jobs[] 中的每个任务对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 8 位十六进制 job ID |
| `cron` | string | ✅ | 标准 5 字段 cron 表达式 |
| `humanSchedule` | string | ✅ | 人类可读的调度描述 |
| `prompt` | string | ✅ | 任务执行的 prompt 内容 |
| `recurring` | boolean | ❌ | 是否周期任务（one-shot 时可能省略） |
| `durable` | boolean | ❌ | 是否持久化（默认 session-only 时可能省略或为 false） |

**字段完整性说明**:
- 实验观察到 `recurring` 和 `durable` 字段**不一定总是出现**
- durable 任务（写入磁盘的）可能省略 `durable` 字段
- one-shot 任务（recurring=false）可能省略 `recurring` 字段
- 前端应使用 `??` 或 `||` 提供默认值

#### message.content[0].content（给 LLM 看的格式化文本）

格式为每行一个任务：
```
{id} — {humanSchedule} ({recurring|one-shot}){ [session-only]}: {prompt}
```

**示例（多任务）**:
```
4324c4a1 — Every day at 9:00 AM (recurring): Run daily health check
99292824 — Every 5 minutes (recurring) [session-only]: Check build
b5d503df — Every day at 4:00 PM (one-shot) [session-only]: Release time
```

**格式化规则**:
- session-only 任务附加 `[session-only]` 标记
- recurring 任务标注 `(recurring)`，one-shot 标注 `(one-shot)`
- 每行以 `: ` 分隔描述和 prompt

**关键区别**:
- `tool_use_result` 是结构化的 JSON 数组 → **前端可直接使用**
- `message.content[].content` 是 `\n` 分隔的文本 → **给 LLM 看的**
- 前端应优先使用 `tool_use_result.jobs` 的结构化数据

---

## 三、流式事件序列

### 3.1 完整时间线（Case 1: 先 CronCreate 再 CronList）

```
[  0] system init                           ← 会话初始化
[  1] system status                         ← 状态: requesting
[  2] stream_event message_start            ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start      ← text block
[  4] stream_event content_block_stop       ← text block 结束（空文本）
[  5] stream_event content_block_start      ← tool_use block (CronCreate)
                                           id: "call_d5eb81dabd8f4fc7bd6d0865"
[  6] stream_event input_json_delta: ""     ← 空（第 1 次）
[  7] stream_event input_json_delta: "{"    ← 开括号（第 2 次）
[  8] stream_event input_json_delta: "\"cron\": \"*/5 * * * *\""
[  9] stream_event input_json_delta: ", \"prompt\": \"Check the build status\""
[ 10] stream_event input_json_delta: ", \"recurring\": true"
[ 11] stream_event input_json_delta: "}"    ← 闭括号（第 6 次）
[ 12] assistant                             ← 完整 tool_use {name: "CronCreate", input: {...}}
[ 13] stream_event content_block_stop       ← CronCreate block 结束
[ 14] stream_event message_delta            ← stop_reason
[ 15] stream_event message_stop             ← 第 1 轮 API 调用结束
     ─── SDK 自动执行 CronCreate（瞬时）───
[ 16] user                                  ← CronCreate tool_result {id: "c2ba8345", ...}
[ 17] system status                         ← 状态: requesting
[ 18] stream_event message_start            ← 第 2 轮 API 调用开始
[ 19-46] stream_event text_delta × 28       ← LLM: "I'll help you create... Now let me list..."
[ 47] stream_event content_block_start      ← tool_use block (CronList)
                                           id: "call_88e181b4b483443584582e61"
[ 48] stream_event input_json_delta: ""     ← 空（第 1 次）
[ 49] stream_event input_json_delta: "{"    ← 开括号（第 2 次）
[ 50] stream_event input_json_delta: "}"    ← 闭括号（第 3 次）
[ 51] assistant                             ← 完整 tool_use {name: "CronList", input: {}}
[ 52] stream_event content_block_stop       ← CronList block 结束
[ 53] stream_event message_delta            ← stop_reason
[ 54] stream_event message_stop             ← 第 2 轮 API 调用结束
     ─── SDK 自动执行 CronList（瞬时）───
[ 55] user                                  ← CronList tool_result {jobs: [...]}
[ 56] system status                         ← 状态: requesting
[ 57] stream_event message_start            ← 第 3 轮 API 调用开始
[ 58-227] stream_event text_delta × 170     ← LLM 总结
[228] assistant                             ← 完整 text block
[229] stream_event content_block_stop
[230] stream_event message_delta + message_stop
[231] result                                ← {subtype: "success", num_turns: 3, duration_ms: 15630}
```

**总事件数**: 231
**总耗时**: 15630ms
**num_turns**: 3

### 3.2 仅 CronList 场景时间线（Case 2: 直接列出）

```
[  0] system init
[  1] system status
[  2] stream_event message_start            ← 第 1 轮开始
[  3] stream_event content_block_start      ← text block（空/短文本）
[  4] stream_event content_block_stop
[  5] stream_event content_block_start      ← tool_use (CronList)
[  6] stream_event input_json_delta: ""     ← 空
[  7] stream_event input_json_delta: "{"    ← 开括号
[  8] stream_event input_json_delta: "}"    ← 闭括号
[  9] assistant (CronList tool_use, input: {})
[ 10] stream_event content_block_stop
[ 11] stream_event message_delta
[ 12] stream_event message_stop
     ─── SDK 自动执行 CronList（瞬时）───
[ 13] user                                  ← tool_result {jobs: [...]}
[ 14] system status
[ 15] stream_event message_start            ← 第 2 轮开始
[ 16-128] stream_event text_delta × 113     ← LLM 总结
[129] assistant (text)
[130] stream_event content_block_stop
[131] stream_event message_delta
[132] stream_event message_stop
[133] result                                ← num_turns: 2
```

**总事件数**: 134
**num_turns**: 2

### 3.3 各阶段事件数量统计

| 阶段 | Case 1 (创建+列出) | Case 2 (仅列出) | Case 3 (2×创建+列出) | Case 4 (基线) |
|------|-------------------|----------------|---------------------|--------------|
| system (init+status) | 2+3 | 2+2 | 2+4 | 2 |
| stream_event 第1轮 | 10 | 10 | 10 | 9 |
| assistant 第1轮 | 2 (text+CronCreate) | 2 (text+CronList) | 2 (text+CronCreate) | 1 (text) |
| user (CronCreate result) | 1 | 0 | 2 | 0 |
| stream_event 第2轮 | 33 | 113 | 20 | 0 |
| assistant 第2轮 | 2 (text+CronList) | 1 (text) | 2 (text+CronCreate) | 0 |
| user (CronList result) | 1 | 1 (CronList) | 0 | 0 |
| stream_event 第3轮 | 170 | 0 | 28 | 0 |
| assistant 第3轮 | 1 (text) | 0 | 2 (text+CronList) | 0 |
| user (CronList result) | 0 | 0 | 1 | 0 |
| stream_event 第4轮 | 0 | 0 | 96 | 0 |
| assistant 第4轮 | 0 | 0 | 1 (text) | 0 |
| result | 1 | 1 | 1 | 1 |
| **总事件数** | **231** | **134** | **170** | **11** |
| **num_turns** | 3 | 2 | 4 | 1 |

### 3.4 CronList input_json_delta 推送详情

CronList 的 input 为空对象，因此 input_json_delta 推送次数**固定 3 次**：

| 序号 | 所有 Case 一致 |
|------|---------------|
| 1 | `""` (空) |
| 2 | `"{"` |
| 3 | `"}"` |
| **推送次数** | **3** |

**与 CronCreate/CronDelete 对比**:

| 工具 | input 字段数 | input_json_delta 推送次数 |
|------|-------------|-------------------------|
| **CronList** | **0（空对象）** | **3** |
| CronDelete | 1 (id) | 4 |
| CronCreate (recurring) | 3 (cron, prompt, recurring) | 6 |
| CronCreate (recurring+durable) | 4 | 7 |

**规律**: input_json_delta 推送次数 = 字段数 + 3（空 + 开括号 + 闭括号）。CronList 字段数为 0，所以是 3 次。

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**结论：CronList 不产生 tool_progress 事件。**

| Case | tool_progress 事件数 |
|------|---------------------|
| Case 1 (创建+列出) | 0 |
| Case 2 (仅列出) | 0 |
| Case 3 (2×创建+列出) | 0 |
| Case 4 (基线) | 0 |
| Case 5 (SSE) | 0 |
| Case 6 (无 partial) | 0 |

CronList 是 **瞬时工具** — SDK 收到 tool_use 后立即读取内存中的调度列表并返回，无需等待外部 I/O。与 CronCreate、CronDelete 相同，没有 tool_progress。

### 4.2 SDK 推送频率统计

整个 CronList 工具调用过程中，SDK 推送的事件分布：

| 事件类型 | 推送次数（仅列出场景） | 增量/非增量 |
|---------|---------|------------|
| `system(init)` | 1 | 非增量 |
| `system(status)` | 2 | 非增量 |
| `stream_event(message_start)` | 2 | 非增量 |
| `stream_event(content_block_start)` | 3 | 非增量 |
| `stream_event(text_delta)` | 113 | **增量**（追加文本） |
| `stream_event(input_json_delta)` | 3 | **增量**（拼接 JSON） |
| `stream_event(content_block_stop)` | 3 | 非增量 |
| `stream_event(message_delta)` | 2 | 非增量 |
| `stream_event(message_stop)` | 2 | 非增量 |
| `assistant` | 3 | 非增量（完整消息） |
| `user` | 1 | 非增量（tool_result） |
| `result` | 1 | 非增量 |

### 4.3 是否需要不断修改前端状态？

**不需要持续轮询式更新。** CronList 是瞬时工具，前端需要处理的状态转换非常简单：

```
idle → building_input → executing → completed
                            ↑
                       瞬间完成（无中间状态）
```

| 时刻 | 事件 | 前端状态变化 |
|------|------|------------|
| `content_block_start(tool_use, name="CronList")` | 工具调用开始 | 显示 "CronList 调用中" |
| `input_json_delta × 3` | 参数构建 | 空对象 `{}` — 无实质内容可显示 |
| `assistant(tool_use)` | 完整参数到达 | 确认 input 为 `{}`，开始执行 |
| `user(tool_result)` | 任务列表返回 | **立即**更新为"已完成"，显示任务列表 |
| `text_delta × N` | 第 2 轮文本 | LLM 总结文本流式输出 |

**核心发现**: CronList 从 `assistant(tool_use)` 到 `user(tool_result)` 是**瞬间**的（<100ms），中间没有 tool_progress，前端无需轮询或等待。

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
interface CronListBlock {
  type: 'tool_use'
  toolName: 'CronList'
  toolUseId: string
  status: 'building' | 'executing' | 'completed' | 'error'
  input: {} // 空对象
  result?: {
    jobs: CronJob[]
  }
  toolResultText?: string  // 格式化的文本结果
}

interface CronJob {
  id: string              // 8 位十六进制 job ID
  cron: string            // 标准 5 字段 cron 表达式
  humanSchedule: string   // 人类可读调度描述
  prompt: string          // 任务执行 prompt
  recurring?: boolean     // 是否周期任务（可能省略）
  durable?: boolean       // 是否持久化（可能省略）
}

// 流式构建状态
interface CronListBuilder {
  jsonBuffer: string
  parsedInput: {} | null
  status: 'building' | 'executing' | 'completed'
}
```

### 5.2 状态机设计

```
content_block_start(tool_use, name="CronList")
  → status = 'building'
  → jsonBuffer = ''

input_json_delta × 3
  → jsonBuffer += partial_json
  → 不需要尝试 parse（已知是 {}）

assistant(tool_use)
  → 确认 input = {}
  → status = 'executing'

user(tool_result)
  → result = { jobs: tool_use_result.jobs }
  → toolResultText = message.content[].content
  → status = 'completed'
```

### 5.3 组件模板

```vue
<!-- CronListBlock.vue -->
<template>
  <el-card class="cron-list-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag type="info">
          <el-icon><List /></el-icon>
          CronList
        </el-tag>
        <el-tag v-if="status === 'building'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          加载中...
        </el-tag>
        <el-tag v-else-if="status === 'executing'" type="primary">
          查询中...
        </el-tag>
        <el-tag v-else-if="status === 'completed'" type="success">
          ✅ {{ jobs.length }} 个任务
        </el-tag>
      </div>
    </template>

    <!-- 任务列表 -->
    <div v-if="jobs.length > 0">
      <el-table :data="jobs" border size="small" stripe>
        <el-table-column prop="id" label="Job ID" width="100">
          <template #default="{ row }">
            <code class="job-id">{{ row.id }}</code>
          </template>
        </el-table-column>
        <el-table-column label="调度" width="200">
          <template #default="{ row }">
            <code>{{ row.cron }}</code>
            <div class="human-schedule">{{ row.humanSchedule }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="prompt" label="Prompt" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag :type="row.recurring !== false ? 'primary' : 'warning'" size="small">
              {{ row.recurring !== false ? '周期' : '一次性' }}
            </el-tag>
            <el-tag v-if="row.durable" type="success" size="small" class="ml-1">
              持久化
            </el-tag>
            <el-tag v-else size="small" type="info" class="ml-1">
              内存
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button
              size="small"
              type="danger"
              link
              @click="$emit('delete', row.id)"
            >
              取消
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 无任务 -->
    <el-empty v-else-if="status === 'completed'" description="当前没有定时任务" />

    <!-- 加载中占位 -->
    <div v-else-if="status === 'building' || status === 'executing'" class="loading-placeholder">
      <el-skeleton :rows="3" animated />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { List, Loading } from '@element-plus/icons-vue'

interface CronJob {
  id: string
  cron: string
  humanSchedule: string
  prompt: string
  recurring?: boolean
  durable?: boolean
}

const props = defineProps<{
  status: 'building' | 'executing' | 'completed' | 'error'
  jobs: CronJob[]
}>()

defineEmits<{
  delete: [jobId: string]
}>()

const statusClass = computed(() => ({
  'is-building': props.status === 'building',
  'is-completed': props.status === 'completed',
}))
</script>

<style scoped>
.job-id {
  font-family: monospace;
  font-size: 0.85em;
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
}
.human-schedule {
  font-size: 0.8em;
  color: #909399;
  margin-top: 2px;
}
.ml-1 { margin-left: 4px; }
</style>
```

### 5.4 Composable

```typescript
// useCronListStream.ts
import { ref, computed } from 'vue'

interface CronJob {
  id: string
  cron: string
  humanSchedule: string
  prompt: string
  recurring?: boolean
  durable?: boolean
}

export function useCronListStream() {
  const status = ref<'idle' | 'building' | 'executing' | 'completed' | 'error'>('idle')
  const jsonBuffer = ref('')
  const jobs = ref<CronJob[]>([])
  const toolResultText = ref<string | null>(null)

  function handleStreamEvent(event: any) {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.name === 'CronList') {
          status.value = 'building'
          jsonBuffer.value = ''
          jobs.value = []
          toolResultText.value = null
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'input_json_delta') {
          jsonBuffer.value += event.delta.partial_json
          // CronList 的 input 永远是 {}，不需要 parse
        }
        break

      case 'content_block_stop':
        if (status.value === 'building') {
          status.value = 'executing'
        }
        break
    }
  }

  function handleAssistantMessage(msg: any) {
    for (const block of msg.content || []) {
      if (block.type === 'tool_use' && block.name === 'CronList') {
        status.value = 'executing'
      }
    }
  }

  function handleUserMessage(msg: any) {
    // CronList 的 tool_use_result 始终是 object
    if (msg.tool_use_result && typeof msg.tool_use_result === 'object') {
      const result = msg.tool_use_result as { jobs?: CronJob[] }
      if (Array.isArray(result.jobs)) {
        jobs.value = result.jobs
      }
      status.value = 'completed'
    }
    // 提取格式化文本
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          toolResultText.value = block.content
        }
      }
    }
  }

  const jobCount = computed(() => jobs.value.length)

  return {
    status,
    jobs,
    jobCount,
    toolResultText,
    handleStreamEvent,
    handleAssistantMessage,
    handleUserMessage,
  }
}
```

### 5.5 关键交互处理

CronList **不需要**用户交互（与 AskUserQuestion 不同）：
- ❌ 无需表单填写
- ❌ 无需 canUseTool 回调
- ❌ 无需参数输入
- ✅ SDK 自动执行并返回结果
- ✅ 前端只需渲染 jobs 列表

**前端操作**：
1. 显示任务列表表格（el-table）
2. 每行显示 Job ID、调度、prompt、类型
3. 每行提供"取消"按钮（触发 CronDelete）
4. 无任务时显示 el-empty

**字段容错处理**：
```typescript
// jobs 列表中每个 job 的字段可能不完整，前端需要提供默认值
function normalizeJob(job: any): CronJob {
  return {
    id: job.id,
    cron: job.cron,
    humanSchedule: job.humanSchedule,
    prompt: job.prompt,
    recurring: job.recurring ?? true,   // 默认视为周期任务
    durable: job.durable ?? false,      // 默认为内存存储
  }
}
```

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | stream_event | input_json_delta | text_delta | user | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------------|------------|------|--------------|-----------|------|
| 1 | 创建+列出 | 231 | 218 | 9 (6+3) | 191 | 2 | 0 | 3 | 15.6s |
| 2 | 仅列出 | 134 | 126 | 3 | 113 | 1 | 0 | 2 | 10.7s |
| 3 | 2×创建+列出 | 170 | 161 | 15 (6+6+3) | 144 | 3 | 0 | 4 | 15.3s |
| 4 | 纯文本基线 | 11 | 9 | 0 | 2 | 0 | 0 | 1 | 4.9s |
| 5 | SSE 前端视角 | 115 | 107 | 3 | 95 | 1 | 0 | 2 | 8.7s |
| 6 | 无 partial | 10 | 0 | 0 | 0 | 1 | 0 | 2 | ~195s |

### 6.2 原始事件样本（关键事件的 JSON）

#### content_block_start(tool_use) — CronList 调用开始

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "call_5f5bfd09365641e18814859a",
      "name": "CronList",
      "input_schema": { "type": "object", "properties": {} }
    }
  }
}
```

#### assistant 消息 — CronList tool_use block

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Now let me list all scheduled tasks:" },
      {
        "type": "tool_use",
        "id": "call_5f5bfd09365641e18814859a",
        "name": "CronList",
        "input": {}
      }
    ]
  }
}
```

#### user 消息 — CronList tool_result（单任务）

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "jobs": [
      {
        "id": "4324c4a1",
        "cron": "0 9 * * *",
        "humanSchedule": "Every day at 9:00 AM",
        "prompt": "Run daily health check",
        "recurring": true
      }
    ]
  },
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "call_5f5bfd09365641e18814859a",
      "content": "4324c4a1 — Every day at 9:00 AM (recurring): Run daily health check"
    }]
  }
}
```

#### user 消息 — CronList tool_result（多任务）

```json
{
  "tool_use_result": {
    "jobs": [
      {
        "id": "4324c4a1",
        "cron": "0 9 * * *",
        "humanSchedule": "Every day at 9:00 AM",
        "prompt": "Run daily health check",
        "recurring": true
      },
      {
        "id": "c2ba8345",
        "cron": "*/5 * * * *",
        "humanSchedule": "Every 5 minutes",
        "prompt": "Check the build status",
        "recurring": true,
        "durable": false
      }
    ]
  },
  "message": {
    "content": [{
      "type": "tool_result",
      "content": "4324c4a1 — Every day at 9:00 AM (recurring): Run daily health check\nc2ba8345 — Every 5 minutes (recurring) [session-only]: Check the build status"
    }]
  }
}
```

---

## 七、与 CronCreate / CronDelete 的对比

| 维度 | CronList | CronCreate | CronDelete（成功） | CronDelete（失败） |
|------|---------|-----------|-------------------|-------------------|
| **input 字段数** | **0（空对象）** | 2-4 | 1 (id) | 1 (id) |
| **input_json_delta 次数** | **3** | 6-7 | 4 | 4 |
| **tool_use_result 类型** | object `{jobs: [...]}` | object `{id, humanSchedule, ...}` | object `{id}` | **string** |
| **tool_use_result 字段** | `{jobs: [{id,cron,humanSchedule,prompt,recurring?,durable?}]}` | `{id, humanSchedule, recurring, durable}` | `{id}` | N/A |
| **content 文本格式** | `{id} — {schedule} ({type}): {prompt}` | 详细调度描述+持久化+过期说明 | `"Cancelled job {id}."` | `<tool_use_error>...` |
| **tool_progress** | ❌ 0 次 | ❌ 0 次 | ❌ 0 次 | ❌ 0 次 |
| **需要权限** | ❌ No | ❌ No | ❌ No | ❌ No |
| **执行类型** | 瞬时（内存读取） | 瞬时（内存写入） | 瞬时（内存删除） | 瞬时（内存查找） |
| **前端渲染** | **任务列表表格** | 参数表 + 结果卡片 | Job ID + 成功/失败提示 | 错误提示 |

---

## 八、前端核心注意事项

### 8.1 空参数工具的 input_json_delta 处理

CronList 的 input 为空对象，前端在收到 `input_json_delta` 时：
- 第 1 次 `""` — 空字符串
- 第 2 次 `"{"` — 开括号
- 第 3 次 `"}"` — 闭括号

前端可以**跳过**对空参数工具的 JSON 拼接和解析，直接确认 input 为 `{}`。

### 8.2 jobs 列表字段容错

CronList 返回的 jobs 列表中，每个 job 的字段可能不完整。前端**必须**对缺失字段提供默认值：

```typescript
// 字段可能缺失的情况
const job = {
  id: "xxx",           // ✅ 始终存在
  cron: "*/5 * * * *", // ✅ 始终存在
  humanSchedule: "...", // ✅ 始终存在
  prompt: "...",        // ✅ 始终存在
  recurring: undefined, // ❌ one-shot 任务可能省略
  durable: undefined,   // ❌ durable 任务可能省略
}
```

### 8.3 与 CronCreate/CronDelete 的联动

前端可以构建完整的 Cron 管理界面：

1. **CronCreate** → 返回 job ID → 自动添加到列表
2. **CronList** → 返回所有 jobs → 渲染表格
3. **CronDelete** → 通过 job ID 取消 → 自动刷新列表

建议在 CronList 的表格中，每行提供 CronDelete 操作按钮。

### 8.4 SSE 与无 partial 对比

| 维度 | SSE（有 partial） | 无 partial |
|------|------------------|-----------|
| 总事件数 | 115 | **10** |
| stream_event | 107 | **0** |
| 可做流式渲染 | ✅ | ❌ |
| 仍然有 user 消息 | ✅ | ✅ |
| tool_use_result 相同 | ✅ | ✅ |

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 真正空列表（0 个任务）的 tool_result | 未测试 | 推断为 `{jobs: []}` |
| 超过 50 个任务的列表 | 未测试 | SDK 限制每会话 50 个 |
| 跨会话的 durable 任务是否列出 | 未完全验证 | Case 2/3 列出了之前创建的 durable 任务 |
| `CLAUDE_CODE_DISABLE_CRON=1` 时调用 | 未测试 | 应返回错误 |
| jobs 列表的排序规则 | 未验证 | 可能按创建时间排序 |
| durable 任务的 `.claude/scheduled_tasks.json` 对列表的影响 | 未验证 | 需要检查文件系统 |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `test/integration/stream-tool-cronlist.spec.ts` | 本实验测试文件（6 cases） |
| `raw/stream-tool-croncreate-behavior.md` | CronCreate 流式工具调用对比 |
| `raw/stream-tool-crondelete-behavior.md` | CronDelete 流式工具调用对比 |
| `wiki/claude-code/croncreate-tool.md` | CronCreate 工具详解（含 CronList/CronDelete 关系） |
| `raw/stream-event-types-behavior.md` | SDK 流式事件类型全景 |
