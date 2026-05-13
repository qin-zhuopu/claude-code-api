# CronDelete 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-crondelete.spec.ts`
**测试用例数**: 6（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **input_schema 字段** | `id`（必填，string）— 来自 CronCreate 返回的 job ID |
| **tool_result 结构（成功）** | `tool_use_result`: `{id: string}` + `message.content`: `"Cancelled job {id}."` |
| **tool_result 结构（失败）** | `tool_use_result`: `"Error: No scheduled job with id 'xxx'"`（字符串，非对象）+ `message.content`: `"<tool_use_error>...</tool_use_error>"` |
| **stream_event 总数** | Case 1: 134 个（含 CronCreate+CronDelete+3 轮 LLM）；Case 2: 45 个 |
| **input_json_delta 推送次数** | **4 次**（空 + `{` + `"id": "xxx"` + `}`）— 比 CronCreate 少 |
| **tool_progress 推送次数** | **0 次** — CronDelete 是瞬时工具 |
| **tool_use_summary 推送次数** | **0 次** |
| **状态更新频率** | 极低 — 仅在 tool_result 注入后有 system(status) |
| **num_turns** | 3（先创建再删除）；2（仅删除/删除不存在） |
| **是否需要不断修改前端状态** | **不需要** — CronDelete 是瞬时工具，无持续进度 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK init 消息）

CronDelete 出现在 `system(init)` 消息的 `tools` 数组中。工具名称：`CronDelete`。

```json
{
  "name": "CronDelete",
  "description": "Cancel a cron job previously scheduled with CronCreate...",
  "input_schema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "The job ID returned by CronCreate."
      }
    },
    "required": ["id"]
  }
}
```

**与 CronCreate 对比**: CronDelete 的 input_schema 极其简单，只有一个 `id` 字段。

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**删除已有任务（Case 1, 成功）**:
```json
{
  "id": "49d0defe"
}
```

**删除不存在的任务（Case 2/3, 失败）**:
```json
{
  "id": "deadbeef"
}
```
```json
{
  "id": "00000000"
}
```

**关键发现**:
- CronDelete 的 input 仅包含 `id` 字段
- `id` 来自 CronCreate 的 tool_result 中返回的 job ID
- LLM 不会添加额外字段

---

## 二、tool_result 返回值格式

### 2.1 完整结构（来自 user 消息）

CronDelete 的 tool_result 存在**两种格式**：成功和失败。

#### 成功（任务存在并被取消）

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "id": "49d0defe"
  },
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_884acd5a9f3f4a749567c313",
        "content": "Cancelled job 49d0defe."
      }
    ]
  }
}
```

#### 失败（任务不存在）

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": "Error: No scheduled job with id 'deadbeef'",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_a5eae36a4fd14e668c757ac4",
        "content": "<tool_use_error>No scheduled job with id 'deadbeef'</tool_use_error>"
      }
    ]
  }
}
```

### 2.2 字段说明

#### tool_use_result（成功时 — 结构化对象）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 被删除的 job ID（8 位十六进制） |

#### tool_use_result（失败时 — 错误字符串）

| 格式 | 说明 |
|------|------|
| `"Error: No scheduled job with id 'xxx'"` | 纯字符串，非 JSON 对象 |

#### message.content[0].content（给 LLM 看的格式化文本）

| 场景 | 格式化文本 |
|------|-----------|
| 成功 | `"Cancelled job {id}."` |
| 失败 | `"<tool_use_error>No scheduled job with id '{id}'</tool_use_error>"` |

**关键区别 — 与 CronCreate 对比**:

| 维度 | CronCreate | CronDelete（成功） | CronDelete（失败） |
|------|-----------|-------------------|-------------------|
| `tool_use_result` 类型 | object `{id, humanSchedule, ...}` | object `{id}` | **string** `"Error: ..."` |
| `content` 格式 | 普通文本 | 普通文本 | `<tool_use_error>...</tool_use_error>` |
| 字段数量 | 4 个 | 1 个 | N/A |

**前端判断成功/失败的关键**：检查 `tool_use_result` 的类型 — `object` 为成功，`string` 为失败。或检查 `content` 是否包含 `<tool_use_error>` 标签。

---

## 三、流式事件序列

### 3.1 完整时间线（Case 1: 先创建再删除）

```
[  0] system init                           ← 会话初始化
[  1] system status                         ← 状态: requesting
[  2] stream_event message_start            ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start      ← text block
[  4-17] stream_event text_delta × 14       ← LLM: "I'll create a recurring cron job..."
[ 18] assistant                             ← 完整 text block
[ 19] stream_event content_block_stop       ← text block 结束
[ 20] stream_event content_block_start      ← tool_use block (CronCreate)
                                           id: "call_fb75e6ba52c34d21b3e053e4"
[ 21] stream_event input_json_delta: ""     ← 空（第 1 次）
[ 22] stream_event input_json_delta: "{"    ← 开括号（第 2 次）
[ 23] stream_event input_json_delta: "\"cron\": \"*/5 * * * *\""
[ 24] stream_event input_json_delta: ", \"prompt\": \"Check the build status\""
[ 25] stream_event input_json_delta: ", \"recurring\": true"
[ 26] stream_event input_json_delta: "}"    ← 闭括号
[ 27] assistant                             ← 完整 tool_use {name: "CronCreate", input: {cron, prompt, recurring}}
[ 28] stream_event content_block_stop       ← CronCreate block 结束
[ 29] stream_event message_delta            ← stop_reason
[ 30] stream_event message_stop             ← 第 1 轮 API 调用结束
     ─── SDK 自动执行 CronCreate（瞬时）───
[ 31] user                                  ← CronCreate tool_result {id: "49d0defe", ...}
[ 32] system status                         ← 状态: requesting
[ 33] stream_event message_start            ← 第 2 轮 API 调用开始
[ 34] stream_event content_block_start      ← text block
[ 35-55] stream_event text_delta × 21       ← LLM: "The job ID is `49d0defe`. Now I'll delete it:"
[ 56] assistant                             ← 完整 text block
[ 57] stream_event content_block_stop       ← text block 结束
[ 58] stream_event content_block_start      ← tool_use block (CronDelete)
                                           id: "call_884acd5a9f3f4a749567c313"
[ 59] stream_event input_json_delta: ""     ← 空（第 1 次）
[ 60] stream_event input_json_delta: "{"    ← 开括号（第 2 次）
[ 61] stream_event input_json_delta: "\"id\": \"49d0defe\""
[ 62] stream_event input_json_delta: "}"    ← 闭括号（第 4 次）
[ 63] assistant                             ← 完整 tool_use {name: "CronDelete", input: {id}}
[ 64] stream_event content_block_stop       ← CronDelete block 结束
[ 65] stream_event message_delta            ← stop_reason
[ 66] stream_event message_stop             ← 第 2 轮 API 调用结束
     ─── SDK 自动执行 CronDelete（瞬时）───
[ 67] user                                  ← CronDelete tool_result {id: "49d0defe"} + "Cancelled job 49d0defe."
[ 68] system status                         ← 状态: requesting
[ 69] stream_event message_start            ← 第 3 轮 API 调用开始
[ 70-129] stream_event text_delta × 60      ← LLM 总结 "Job ID: 49d0defe - confirmed deleted..."
[130] stream_event content_block_stop       ← text block 结束
[131] stream_event message_delta            ← stop_reason
[132] stream_event message_stop             ← 第 3 轮 API 调用结束
[133] result                                ← {subtype: "success", num_turns: 3, duration_ms: 15072}
```

**总事件数**: 134
**总耗时**: 15072ms
**num_turns**: 3（第 1 轮 CronCreate → 第 2 轮 CronDelete → 第 3 轮总结）

### 3.2 仅删除场景时间线（Case 2: 删除不存在的 ID）

```
[  0] system init
[  1] system status
[  2] stream_event message_start
[  3] stream_event content_block_start      ← text block
[  4-9] stream_event text_delta × 6
[ 10] assistant (text)
[ 11] stream_event content_block_stop
[ 12] stream_event content_block_start      ← tool_use (CronDelete)
[ 13] stream_event input_json_delta: ""
[ 14] stream_event input_json_delta: "{"
[ 15] stream_event input_json_delta: "\"id\": \"deadbeef\""
[ 16] stream_event input_json_delta: "}"
[ 17] assistant (CronDelete tool_use)
[ 18] stream_event content_block_stop
[ 19] stream_event message_delta
[ 20] stream_event message_stop
     ─── SDK 执行 CronDelete（瞬时，但失败）───
[ 21] user                                  ← Error: "No scheduled job with id 'deadbeef'"
[ 22] system status
[ 23] stream_event message_start            ← 第 2 轮
[ 24-42] stream_event text_delta × 19       ← LLM 解释错误
[ 43] assistant (text)
[ 44] result                                ← num_turns: 2
```

**总事件数**: 45
**num_turns**: 2

### 3.3 各阶段事件数量统计

| 阶段 | Case 1 (创建+删除) | Case 2 (删除不存在) | Case 3 (删除 00000000) | Case 4 (基线) |
|------|-------------------|-------------------|----------------------|--------------|
| system (init+status) | 2+3 | 2+2 | 2+2 | 2 |
| stream_event 第1轮 | 22 | 11 | 11 | 9 |
| assistant 第1轮 | 2 (text+CronCreate) | 2 (text+CronDelete) | 2 (text+CronDelete) | 1 (text) |
| user (CronCreate result) | 1 | 0 | 0 | 0 |
| stream_event 第2轮 | 22 | 19 | 19 | 0 |
| assistant 第2轮 | 2 (text+CronDelete) | 1 (text) | 1 (text) | 0 |
| user (CronDelete result) | 1 | 1 (error) | 1 (error) | 0 |
| stream_event 第3轮 | 60 | 0 | 0 | 0 |
| assistant 第3轮 | 1 (text) | 0 | 0 | 0 |
| result | 1 | 1 | 1 | 1 |
| **总事件数** | **134** | **45** | **~45** | **11** |
| **num_turns** | 3 | 2 | 2 | 1 |

### 3.4 CronDelete input_json_delta 推送详情

CronDelete 的 input 只有 1 个字段，因此 input_json_delta 推送次数比 CronCreate 少：

| 序号 | Case 1 (成功, id="49d0defe") | Case 2 (失败, id="deadbeef") |
|------|------------------------------|------------------------------|
| 1 | `""` (空) | `""` (空) |
| 2 | `"{"` | `"{"` |
| 3 | `"\"id\": \"49d0defe\""` | `"\"id\": \"deadbeef\""` |
| 4 | `"}"` | `"}"` |
| **推送次数** | **4** | **4** |

**推送模式**: 固定 4 次 — 空 + 开括号 + id 字段 + 闭括号。比 CronCreate 的 6-7 次更少，因为 input 只有 1 个字段。

**与 CronCreate 对比**:

| 工具 | input 字段数 | input_json_delta 推送次数 |
|------|-------------|-------------------------|
| CronCreate (recurring) | 3 (cron, prompt, recurring) | 6 |
| CronCreate (recurring+durable) | 4 | 7 |
| **CronDelete** | **1 (id)** | **4** |

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**结论：CronDelete 不产生 tool_progress 事件。**

| Case | tool_progress 事件数 |
|------|---------------------|
| Case 1 (创建+删除) | 0 |
| Case 2 (删除不存在) | 0 |
| Case 3 (删除不存在) | 0 |
| Case 4 (基线) | 0 |

CronDelete 是 **瞬时工具** — SDK 收到 tool_use 后立即在内存中查找并删除调度条目，无需等待外部 I/O。与 CronCreate 相同，没有 tool_progress。

### 4.2 SDK 推送频率统计

整个 CronDelete 工具调用过程中，SDK 推送的事件分布：

| 事件类型 | 推送次数 | 增量/非增量 |
|---------|---------|------------|
| `system(init)` | 1 | 非增量 |
| `system(status)` | 2-3 | 非增量 |
| `stream_event(message_start)` | 2-3 | 非增量 |
| `stream_event(content_block_start)` | 3-4 | 非增量 |
| `stream_event(text_delta)` | 20-60 | **增量** |
| `stream_event(input_json_delta)` | 4 | **增量** |
| `stream_event(content_block_stop)` | 3-4 | 非增量 |
| `stream_event(message_delta)` | 2-3 | 非增量 |
| `stream_event(message_stop)` | 2-3 | 非增量 |
| `assistant` | 3-4 | 非增量 |
| `user` | 1-2 | 非增量 |
| `result` | 1 | 非增量 |

### 4.3 是否需要不断修改前端状态？

**不需要持续轮询式更新。** CronDelete 是瞬时工具，前端需要处理的状态转换非常简单：

```
idle → building_input → executing → completed/error
                               ↑
                          瞬间完成（无中间状态）
```

| 时刻 | 事件 | 前端状态变化 |
|------|------|------------|
| `content_block_start(tool_use, name="CronDelete")` | 工具调用开始 | 显示 "CronDelete 调用中" |
| `input_json_delta × 4` | 参数构建 | 渐进显示 id |
| `assistant(tool_use)` | 完整参数到达 | 确认 id、开始执行 |
| `user(tool_result)` | 结果返回 | **立即**更新为"已取消"或"错误" |
| `text_delta × N` | 后续文本 | LLM 总结文本流式输出 |

**核心发现**: CronDelete 从 `assistant(tool_use)` 到 `user(tool_result)` 是**瞬间**的（<200ms），中间没有 tool_progress，前端无需轮询或等待。

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
interface CronDeleteBlock {
  type: 'tool_use'
  toolName: 'CronDelete'
  toolUseId: string
  status: 'building' | 'executing' | 'completed' | 'error'
  input: {
    id: string    // 要删除的 job ID
  }
  result?: {
    success: boolean
    id?: string           // 被删除的 job ID（成功时）
    errorMessage?: string // 错误消息（失败时）
  }
  toolResultText?: string
}

// 流式构建状态
interface CronDeleteBuilder {
  jsonBuffer: string
  parsedInput: { id: string } | null
  status: 'building' | 'executing' | 'completed' | 'error'
}
```

### 5.2 状态机设计

```
content_block_start(tool_use, name="CronDelete")
  → status = 'building'
  → jsonBuffer = ''

input_json_delta × 4
  → jsonBuffer += partial_json
  → 尝试 JSON.parse(jsonBuffer) → parsedInput

assistant(tool_use)
  → parsedInput = toolInput (完整)
  → status = 'executing'

user(tool_result)
  → 检查 tool_use_result 类型:
    - object → success, result = {success: true, id: tool_use_result.id}
    - string → error, result = {success: false, errorMessage: tool_use_result}
  → status = 'completed' | 'error'
```

### 5.3 组件模板

```vue
<!-- CronDeleteBlock.vue -->
<template>
  <el-card class="cron-delete-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="isError ? 'danger' : 'info'">
          <el-icon><Delete /></el-icon>
          CronDelete
        </el-tag>
        <el-tag v-if="status === 'building'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          构建参数...
        </el-tag>
        <el-tag v-else-if="status === 'executing'" type="primary">
          取消中...
        </el-tag>
        <el-tag v-else-if="status === 'completed'" type="success">
          ✅ 已取消
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger">
          ❌ 失败
        </el-tag>
      </div>
    </template>

    <!-- 要删除的 Job ID -->
    <el-descriptions v-if="parsedInput" :column="1" border size="small">
      <el-descriptions-item label="Job ID">
        <code>{{ parsedInput.id }}</code>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 构建中占位 -->
    <div v-else-if="status === 'building'" class="building-placeholder">
      <el-skeleton :rows="1" animated />
    </div>

    <!-- 结果 -->
    <div v-if="result" class="result-section">
      <el-divider content-position="left">执行结果</el-divider>
      <el-alert
        :title="result.success ? `任务 ${result.id} 已成功取消` : '取消失败'"
        :type="result.success ? 'success' : 'error'"
        :description="result.errorMessage"
        show-icon
        :closable="false"
      />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Delete, Loading } from '@element-plus/icons-vue'

const props = defineProps<{
  status: 'building' | 'executing' | 'completed' | 'error'
  parsedInput?: { id: string }
  result?: {
    success: boolean
    id?: string
    errorMessage?: string
  }
}>()

const isError = computed(() => props.status === 'error')

const statusClass = computed(() => ({
  'is-building': props.status === 'building',
  'is-completed': props.status === 'completed',
  'is-error': props.status === 'error',
}))
</script>
```

### 5.4 Composable

```typescript
// useCronDeleteStream.ts
import { ref } from 'vue'

export function useCronDeleteStream() {
  const status = ref<'idle' | 'building' | 'executing' | 'completed' | 'error'>('idle')
  const jsonBuffer = ref('')
  const parsedInput = ref<{ id: string } | null>(null)
  const result = ref<{
    success: boolean
    id?: string
    errorMessage?: string
  } | null>(null)

  function handleStreamEvent(event: any) {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.name === 'CronDelete') {
          status.value = 'building'
          jsonBuffer.value = ''
          parsedInput.value = null
          result.value = null
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'input_json_delta') {
          jsonBuffer.value += event.delta.partial_json
          try {
            parsedInput.value = JSON.parse(jsonBuffer.value)
          } catch {
            // JSON 不完整
          }
        }
        break

      case 'content_block_stop':
        if (status.value === 'building') {
          try {
            parsedInput.value = JSON.parse(jsonBuffer.value)
            status.value = 'executing'
          } catch {
            // JSON 解析失败
          }
        }
        break
    }
  }

  function handleAssistantMessage(msg: any) {
    for (const block of msg.content || []) {
      if (block.type === 'tool_use' && block.name === 'CronDelete') {
        parsedInput.value = block.input
        status.value = 'executing'
      }
    }
  }

  function handleUserMessage(msg: any) {
    // 判断成功/失败
    const toolUseResult = msg.tool_use_result
    if (typeof toolUseResult === 'object' && toolUseResult !== null) {
      // 成功: tool_use_result 是 {id: "..."}
      result.value = {
        success: true,
        id: toolUseResult.id,
      }
      status.value = 'completed'
    } else if (typeof toolUseResult === 'string') {
      // 失败: tool_use_result 是 "Error: ..."
      result.value = {
        success: false,
        errorMessage: toolUseResult,
      }
      status.value = 'error'
    }
  }

  return {
    status,
    parsedInput,
    result,
    handleStreamEvent,
    handleAssistantMessage,
    handleUserMessage,
  }
}
```

### 5.5 关键交互处理

CronDelete **不需要**用户交互：
- ❌ 无需表单填写
- ❌ 无需 canUseTool 回调
- ❌ 无需权限确认
- ✅ SDK 自动执行并返回结果
- ✅ 前端只需渲染 input + result

**前端关键判断逻辑**：
```typescript
// 判断 CronDelete 结果的成功/失败
function isDeleteSuccess(toolUseResult: any): boolean {
  return typeof toolUseResult === 'object' && toolUseResult !== null
}
```

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | stream_event | input_json_delta | text_delta | user | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------------|------------|------|--------------|-----------|------|
| 1 | 创建+删除 | 134 | 126 | 10 (6+4) | 95 | 2 | 0 | 3 | 15.1s |
| 2 | 删除不存在 | 45 | 40 | 4 | 25 | 1 | 0 | 2 | 8.2s |
| 3 | 删除 00000000 | ~45 | ~40 | 4 | ~25 | 1 | 0 | 2 | 9.7s |
| 4 | 纯文本基线 | 11 | 9 | 0 | 2 | 0 | 0 | 1 | 3.6s |
| 5 | SSE 前端视角 | 227 | 215 | 10 (6+4) | ~150 | 2 | 0 | 3 | 17.1s |
| 6 | 无 partial | 7 | 0 | 0 | 0 | 1 | 0 | 2 | ~5s |

### 6.2 原始事件样本（关键事件的 JSON）

#### content_block_start(tool_use) — CronDelete 调用开始

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "call_884acd5a9f3f4a749567c313",
      "name": "CronDelete",
      "input_schema": { ... }
    }
  }
}
```

#### user 消息 — tool_result（CronDelete 成功）

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "id": "49d0defe"
  },
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "call_884acd5a9f3f4a749567c313",
      "content": "Cancelled job 49d0defe."
    }]
  }
}
```

#### user 消息 — tool_result（CronDelete 失败）

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": "Error: No scheduled job with id 'deadbeef'",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "call_a5eae36a4fd14e668c757ac4",
      "content": "<tool_use_error>No scheduled job with id 'deadbeef'</tool_use_error>"
    }]
  }
}
```

#### result 消息

```json
{
  "subtype": "success",
  "num_turns": 3,
  "duration_ms": 15072,
  "stop_reason": "end_turn",
  "total_cost_usd": 0.28612
}
```

---

## 七、与 CronCreate 的对比

| 维度 | CronCreate | CronDelete（成功） | CronDelete（失败） |
|------|-----------|-------------------|-------------------|
| **input 字段数** | 2-4 (cron, prompt, recurring?, durable?) | 1 (id) | 1 (id) |
| **input_json_delta 次数** | 6-7 | **4** | **4** |
| **tool_use_result 类型** | object | object | **string** |
| **tool_use_result 字段** | {id, humanSchedule, recurring, durable} | {id} | N/A |
| **content 文本** | 详细（调度描述、持久化说明、过期说明） | 简短（"Cancelled job {id}."） | `<tool_use_error>...</tool_use_error>` |
| **tool_progress** | ❌ 0 次 | ❌ 0 次 | ❌ 0 次 |
| **需要权限** | ❌ No | ❌ No | ❌ No |
| **执行类型** | 瞬时 | 瞬时 | 瞬时 |
| **前端渲染** | 参数表 + 结果卡片 | Job ID + 成功/失败提示 | 错误提示 |

---

## 八、前端核心注意事项

### 8.1 tool_use_result 类型判断

CronDelete 的 `tool_use_result` 有两种类型，前端**必须**先判断类型再处理：

```typescript
function handleCronDeleteResult(toolUseResult: any) {
  if (typeof toolUseResult === 'object' && toolUseResult !== null) {
    // 成功: {id: "49d0defe"}
    return { success: true, id: toolUseResult.id }
  } else if (typeof toolUseResult === 'string') {
    // 失败: "Error: No scheduled job with id 'xxx'"
    return { success: false, errorMessage: toolUseResult }
  }
}
```

### 8.2 与 CronCreate 的联合使用

前端在显示 CronCreate 的结果时，应提供"取消任务"按钮，该按钮触发 CronDelete：

```vue
<!-- 在 CronCreateBlock 的结果部分 -->
<el-button
  size="small"
  type="danger"
  @click="$emit('delete', result.id)"
>
  取消任务 (CronDelete)
</el-button>
```

### 8.3 input_json_delta 拼接

CronDelete 的 input 很短（仅 `{id: "xxx"}`），4 次 input_json_delta 即可完成：

```
"" → "{" → "\"id\": \"49d0defe\"" → "}"
```

前端可以在第 3 次 delta 时就显示部分 job ID，但实际意义不大，因为总共不到 200ms。

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 删除正在执行的 job 的行为 | 未测试 | 可能无法取消正在执行的 prompt |
| 删除其他会话创建的 durable job | 未测试 | 可能返回 "not found" |
| 无效 id 格式（如空字符串） | 未测试 | 应返回错误 |
| 同一个 ID 删除两次 | 未测试 | 第二次应返回 "not found" |
| 多个 CronDelete 并行调用 | 未测试 | 一个 assistant 消息中多个 tool_use |
| `CLAUDE_CODE_DISABLE_CRON=1` 时调用 | 未测试 | 应返回错误 |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `test/integration/stream-tool-crondelete.spec.ts` | 本实验测试文件（6 cases） |
| `raw/stream-tool-croncreate-behavior.md` | CronCreate 流式工具调用对比 |
| `wiki/claude-code/croncreate-tool.md` | CronCreate 工具详解（含 CronDelete/CronList 关系） |
| `raw/stream-event-types-behavior.md` | SDK 流式事件类型全景 |
| `raw/stream-tool-bash-behavior.md` | Bash 流式工具调用对比 |
