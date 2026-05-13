# CronCreate 流式工具调用行为观察报告

**日期**: 2026-05-13
**测试文件**: `test/integration/stream-tool-croncreate.spec.ts`
**测试用例数**: 6（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **input_schema 字段** | `cron`(必填), `prompt`(必填), `recurring`(可选,默认true), `durable`(可选,默认false) |
| **tool_result 结构** | `tool_use_result`: `{id, humanSchedule, recurring, durable}` + `message.content`: 格式化文本字符串 |
| **stream_event 总数** | Case 1: 66 个；Case 2: 84 个；Case 3: 107 个 |
| **input_json_delta 推送次数** | 6-7 次（空 + `{` + 各字段 + `}`） |
| **tool_progress 推送次数** | **0 次** — CronCreate 是瞬时工具 |
| **tool_use_summary 推送次数** | **0 次** |
| **状态更新频率** | 极低 — 仅在 tool_result 注入后有 1 次 system(status) |
| **num_turns** | 2（工具调用场景），1（纯文本） |
| **是否需要不断修改前端状态** | **不需要** — CronCreate 是瞬时工具，无持续进度 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK init 消息）

CronCreate 出现在 `system(init)` 消息的 `tools` 数组中。工具名称：`CronCreate`。

```json
{
  "name": "CronCreate",
  "description": "Schedule a prompt to be enqueued at a future time...",
  "input_schema": {
    "type": "object",
    "properties": {
      "cron": {
        "type": "string",
        "description": "Standard 5-field cron expression..."
      },
      "prompt": {
        "type": "string",
        "description": "The prompt to enqueue at each fire time..."
      },
      "recurring": {
        "type": "boolean",
        "description": "true = fire on every cron match until deleted..."
      },
      "durable": {
        "type": "boolean",
        "description": "true = persist to .claude/scheduled_tasks.json..."
      }
    },
    "required": ["cron", "prompt"]
  }
}
```

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**周期任务（Case 1, recurring=true）**:
```json
{
  "cron": "*/5 * * * *",
  "prompt": "Check the build status",
  "recurring": true
}
```

**一次性任务（Case 2, recurring=false）**:
```json
{
  "cron": "0 16 * * *",
  "prompt": "Time to push the release branch",
  "recurring": false,
  "durable": false
}
```

**持久化任务（Case 3, durable=true）**:
```json
{
  "cron": "0 9 * * *",
  "prompt": "Run daily health check",
  "recurring": true,
  "durable": true
}
```

**关键发现**:
- LLM 不一定输出所有字段 — `durable` 仅在显式要求时出现
- `recurring` 字段由 LLM 根据上下文决定是否输出
- `cron` 和 `prompt` 是必填字段，始终出现

---

## 二、tool_result 返回值格式

### 2.1 完整结构（来自 user 消息）

SDK 将 CronCreate 的执行结果包装在 `user` 类型消息中：

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "id": "5c0f7d0e",
    "humanSchedule": "Every 5 minutes",
    "recurring": true,
    "durable": false
  },
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_09331ad65e344db39e7a67d5",
        "content": "Scheduled recurring job 5c0f7d0e (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
      }
    ]
  }
}
```

### 2.2 字段说明

#### tool_use_result（结构化数据）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 8 位十六进制 job ID（如 `"5c0f7d0e"`），用于 CronDelete 取消 |
| `humanSchedule` | string | 人类可读的调度描述（如 `"Every 5 minutes"`, `"Every day at 9:00 AM"`） |
| `recurring` | boolean | 是否为周期任务 |
| `durable` | boolean | 是否持久化到磁盘 |

#### message.content[0].content（给 LLM 看的格式化文本）

根据 recurring 和 durable 的组合，有 4 种格式化模板：

| 场景 | 格式化文本模板 |
|------|--------------|
| recurring=true, durable=false | `"Scheduled recurring job {id} ({humanSchedule}). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."` |
| recurring=false, durable=false | `"Scheduled one-shot task {id} ({humanSchedule}). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete."` |
| recurring=true, durable=true | `"Scheduled recurring job {id} ({humanSchedule}). Persisted to .claude/scheduled_tasks.json. Auto-expires after 7 days. Use CronDelete to cancel sooner."` |
| recurring=false, durable=true | _(未测试，推断)_ `"Scheduled one-shot task {id} ({humanSchedule}). Persisted to .claude/scheduled_tasks.json. It will fire once then auto-delete."` |

**关键区别**:
- `tool_use_result` 是结构化的 JSON 对象 → **前端可直接使用**
- `message.content[].content` 是自然语言字符串 → **给 LLM 看的**
- 前端应优先使用 `tool_use_result` 的结构化数据

---

## 三、流式事件序列

### 3.1 完整时间线（Case 1: 周期任务 recurring=true）

```
[  0] system init                           ← 会话初始化
[  1] system status                         ← 状态: requesting
[  2] stream_event message_start            ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start      ← text block
[  4-22] stream_event text_delta × 19       ← LLM 先输出说明文字 "I'll create..."
[ 23] assistant                             ← 完整 text block
[ 24] stream_event content_block_stop       ← text block 结束
[ 25] stream_event content_block_start      ← tool_use block (CronCreate)
                                           id: "call_09331ad65e344db39e7a67d5"
[ 26] stream_event input_json_delta: ""     ← 空（第 1 次）
[ 27] stream_event input_json_delta: "{"    ← 开括号（第 2 次）
[ 28] stream_event input_json_delta: "\"cron\": \"*/5 * * * *\""  ← cron 字段（第 3 次）
[ 29] stream_event input_json_delta: ", \"prompt\": \"Check the build status\""  ← prompt 字段（第 4 次）
[ 30] stream_event input_json_delta: ", \"recurring\": true"  ← recurring 字段（第 5 次）
[ 31] stream_event input_json_delta: "}"    ← 闭括号（第 6 次）
[ 32] assistant                             ← 完整 tool_use block {name: "CronCreate", input: {...}}
[ 33] stream_event content_block_stop       ← tool_use block 结束
[ 34] stream_event message_delta            ← stop_reason
[ 35] stream_event message_stop             ← 第 1 轮 API 调用结束
     ─── SDK 自动执行 CronCreate（瞬时）───
[ 36] user                                  ← tool_result {id: "5c0f7d0e", ...}
[ 37] system status                         ← 状态: requesting
[ 38] stream_event message_start            ← 第 2 轮 API 调用开始
[ 39] stream_event content_block_start      ← text block
[ 40-60] stream_event text_delta × 21       ← LLM 总结 "The job was created..."
[ 61] assistant                             ← 完整 text block
[ 62] stream_event content_block_stop       ← text block 结束
[ 63] stream_event message_delta            ← stop_reason
[ 64] stream_event message_stop             ← 第 2 轮 API 调用结束
[ 65] result                                ← {subtype: "success", num_turns: 2, duration_ms: 9857}
```

**总事件数**: 66
**总耗时**: 9857ms
**num_turns**: 2

### 3.2 各阶段事件数量统计

| 阶段 | Case 1 (recurring) | Case 2 (one-shot) | Case 3 (durable) | Case 4 (baseline) |
|------|-------------------|-------------------|------------------|-------------------|
| system (init+status) | 2 + 1 | 2 + 1 | 2 + 1 | 2 |
| stream_event 第1轮 | 22 | 16 | 16 | 9 |
| assistant 第1轮 | 2 (text+tool_use) | 2 (text+tool_use) | 2 (text+tool_use) | 1 (text) |
| user (tool_result) | 1 | 1 | 1 | 0 |
| system status | 1 | 1 | 1 | 0 |
| stream_event 第2轮 | 27 | 65 | 88 | 0 |
| assistant 第2轮 | 1 | 1 | 1 | 0 |
| result | 1 | 1 | 1 | 1 |
| **总事件数** | **66** | **84** | **107** | **11** |
| **num_turns** | 2 | 2 | 2 | 1 |

### 3.3 input_json_delta 推送详情

| 序号 | Case 1 (recurring, 3 字段) | Case 2 (one-shot, 4 字段) | Case 3 (durable, 4 字段) |
|------|---------------------------|--------------------------|-------------------------|
| 1 | `""` (空) | `""` (空) | `""` (空) |
| 2 | `"{"` | `"{"` | `"{"` |
| 3 | `"\"cron\": \"*/5 * * * *\""` | `"\"cron\": \"0 16 * * *\""` | `"\"cron\": \"0 9 * * *\""` |
| 4 | `", \"prompt\": \"Check the build status\""` | `", \"prompt\": \"Time to push the release branch\""` | `", \"prompt\": \"Run daily health check\""` |
| 5 | `", \"recurring\": true"` | `", \"recurring\": false"` | `", \"recurring\": true"` |
| 6 | `"}"` | `", \"durable\": false"` | `", \"durable\": true"` |
| 7 | — | `"}"` | `"}"` |
| **推送次数** | **6** | **7** | **7** |

**推送模式**: 每个字段单独一次推送，加上空和花括号。字段越多，推送次数越多。

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**结论：CronCreate 不产生 tool_progress 事件。**

| Case | tool_progress 事件数 |
|------|---------------------|
| Case 1 (recurring) | 0 |
| Case 2 (one-shot) | 0 |
| Case 3 (durable) | 0 |
| Case 4 (baseline) | 0 |

CronCreate 是 **瞬时工具** — SDK 收到 tool_use 后立即在内存中创建调度条目并返回 job ID，无需等待外部 I/O。因此没有 tool_progress。

### 4.2 SDK 推送频率统计

整个 CronCreate 工具调用过程中，SDK 推送的事件分布：

| 事件类型 | 推送次数 | 增量/非增量 |
|---------|---------|------------|
| `system(init)` | 1 | 非增量 |
| `system(status)` | 2 | 非增量（状态切换：requesting → requesting） |
| `stream_event(message_start)` | 2 | 非增量（每轮 API 调用 1 次） |
| `stream_event(content_block_start)` | 3-4 | 非增量 |
| `stream_event(text_delta)` | 20-90 | **增量**（追加文本） |
| `stream_event(input_json_delta)` | 6-7 | **增量**（拼接 JSON） |
| `stream_event(content_block_stop)` | 3-4 | 非增量 |
| `stream_event(message_delta)` | 2 | 非增量 |
| `stream_event(message_stop)` | 2 | 非增量 |
| `assistant` | 3-4 | 非增量（完整消息） |
| `user` | 1 | 非增量（tool_result） |
| `result` | 1 | 非增量 |

### 4.3 是否需要不断修改前端状态？

**不需要持续轮询式更新。** CronCreate 是瞬时工具，前端需要处理的状态转换非常简单：

```
idle → building_input → executing → completed
                                 ↑
                            瞬间完成（无中间状态）
```

| 时刻 | 事件 | 前端状态变化 |
|------|------|------------|
| `content_block_start(tool_use, name="CronCreate")` | 工具调用开始 | 显示 "CronCreate 调用中" |
| `input_json_delta × 6-7` | 参数构建 | 渐进显示 cron/prompt/recurring/durable |
| `assistant(tool_use)` | 完整参数到达 | 确认参数、开始执行 |
| `user(tool_result)` | job ID 返回 | **立即**更新为"已完成"，显示 job ID |
| `text_delta × N` | 第 2 轮文本 | LLM 总结文本流式输出 |

**核心发现**: CronCreate 从 `assistant(tool_use)` 到 `user(tool_result)` 是**瞬间**的（<100ms），中间没有 tool_progress，前端无需轮询或等待。

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
interface CronCreateBlock {
  type: 'tool_use'
  toolName: 'CronCreate'
  toolUseId: string
  status: 'building' | 'executing' | 'completed' | 'error'
  input: {
    cron: string
    prompt: string
    recurring?: boolean
    durable?: boolean
  }
  result?: {
    id: string           // 8 位十六进制 job ID
    humanSchedule: string // 人类可读调度描述
    recurring: boolean
    durable: boolean
  }
  toolResultText?: string  // 格式化的文本结果
}

// 流式构建状态
interface CronCreateBuilder {
  jsonBuffer: string
  parsedInput: CronCreateBlock['input'] | null
  status: 'building' | 'executing' | 'completed'
}
```

### 5.2 状态机设计

```
content_block_start(tool_use, name="CronCreate")
  → status = 'building'
  → jsonBuffer = ''

input_json_delta × N
  → jsonBuffer += partial_json
  → 尝试 JSON.parse(jsonBuffer) → parsedInput

assistant(tool_use)
  → parsedInput = toolInput (完整)
  → status = 'executing'

user(tool_result)
  → result = tool_use_result
  → toolResultText = message.content[].content
  → status = 'completed'
```

### 5.3 组件模板

```vue
<!-- CronCreateBlock.vue -->
<template>
  <el-card class="cron-create-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag type="info">
          <el-icon><Timer /></el-icon>
          CronCreate
        </el-tag>
        <el-tag v-if="status === 'building'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          构建参数...
        </el-tag>
        <el-tag v-else-if="status === 'executing'" type="primary">
          创建中...
        </el-tag>
        <el-tag v-else-if="status === 'completed'" type="success">
          ✅ 已创建
        </el-tag>
      </div>
    </template>

    <!-- 输入参数 -->
    <el-descriptions v-if="parsedInput" :column="1" border size="small">
      <el-descriptions-item label="Cron 表达式">
        <code>{{ parsedInput.cron }}</code>
        <el-tag v-if="parsedInput.cron" size="small" type="info" class="ml-2">
          {{ humanReadableCron(parsedInput.cron) }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="执行提示">
        {{ parsedInput.prompt }}
      </el-descriptions-item>
      <el-descriptions-item label="类型">
        <el-tag :type="parsedInput.recurring ? 'primary' : 'warning'" size="small">
          {{ parsedInput.recurring ? '周期任务' : '一次性任务' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item v-if="parsedInput.durable" label="持久化">
        <el-tag type="success" size="small">是（写入磁盘）</el-tag>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 构建中占位 -->
    <div v-else-if="status === 'building'" class="building-placeholder">
      <el-skeleton :rows="2" animated />
    </div>

    <!-- 创建结果 -->
    <div v-if="result" class="result-section">
      <el-divider content-position="left">创建结果</el-divider>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="Job ID">
          <code class="job-id">{{ result.id }}</code>
          <el-button
            size="small"
            type="danger"
            link
            @click="copyToClipboard(result.id)"
          >
            复制
          </el-button>
        </el-descriptions-item>
        <el-descriptions-item label="调度">
          {{ result.humanSchedule }}
        </el-descriptions-item>
        <el-descriptions-item label="持久化">
          {{ result.durable ? '是（磁盘）' : '否（内存）' }}
        </el-descriptions-item>
        <el-descriptions-item label="自动过期">
          7 天
        </el-descriptions-item>
      </el-descriptions>

      <!-- 操作按钮 -->
      <div class="actions mt-2">
        <el-button size="small" type="danger" @click="$emit('delete', result.id)">
          取消任务 (CronDelete)
        </el-button>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Timer, Loading } from '@element-plus/icons-vue'

const props = defineProps<{
  status: 'building' | 'executing' | 'completed' | 'error'
  parsedInput?: {
    cron: string
    prompt: string
    recurring?: boolean
    durable?: boolean
  }
  result?: {
    id: string
    humanSchedule: string
    recurring: boolean
    durable: boolean
  }
}>()

defineEmits<{
  delete: [jobId: string]
}>()

const statusClass = computed(() => ({
  'is-building': props.status === 'building',
  'is-completed': props.status === 'completed',
}))

function humanReadableCron(cron: string): string {
  // 简单的 cron 表达式翻译
  const map: Record<string, string> = {
    '*/5 * * * *': '每 5 分钟',
    '0 * * * *': '每小时整点',
    '0 9 * * *': '每天上午 9 点',
    '0 9 * * 1-5': '工作日上午 9 点',
  }
  return map[cron] || cron
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}
</script>
```

### 5.4 Composable

```typescript
// useCronCreateStream.ts
import { ref, reactive } from 'vue'

export function useCronCreateStream() {
  const status = ref<'idle' | 'building' | 'executing' | 'completed'>('idle')
  const jsonBuffer = ref('')
  const parsedInput = ref<any>(null)
  const result = ref<{
    id: string
    humanSchedule: string
    recurring: boolean
    durable: boolean
  } | null>(null)
  const toolResultText = ref<string | null>(null)

  function handleStreamEvent(event: any) {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.name === 'CronCreate') {
          status.value = 'building'
          jsonBuffer.value = ''
          parsedInput.value = null
          result.value = null
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'input_json_delta') {
          jsonBuffer.value += event.delta.partial_json
          // 尝试增量解析
          try {
            parsedInput.value = JSON.parse(jsonBuffer.value)
          } catch {
            // JSON 不完整，继续拼接
          }
        }
        break

      case 'content_block_stop':
        // 尝试最终解析
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
      if (block.type === 'tool_use' && block.name === 'CronCreate') {
        parsedInput.value = block.input
        status.value = 'executing'
      }
    }
  }

  function handleUserMessage(msg: any) {
    // 提取结构化 tool_use_result
    if (msg.tool_use_result && typeof msg.tool_use_result === 'object') {
      result.value = msg.tool_use_result
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

  return {
    status,
    parsedInput,
    result,
    toolResultText,
    handleStreamEvent,
    handleAssistantMessage,
    handleUserMessage,
  }
}
```

### 5.5 关键交互处理

CronCreate **不需要**用户交互（与 AskUserQuestion 不同）：
- ❌ 无需表单填写
- ❌ 无需 canUseTool 回调
- ✅ SDK 自动执行并返回结果
- ✅ 前端只需渲染 input + result

**前端操作**：
1. 显示工具参数（cron 表达式、提示内容、任务类型）
2. 显示创建结果（job ID、调度描述）
3. 提供"取消任务"按钮（调用 CronDelete）

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | stream_event | input_json_delta | text_delta | user | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------------|------------|------|--------------|-----------|------|
| 1 | 周期任务 (recurring=true) | 66 | 60 | 6 | 40 | 1 | 0 | 2 | 9.9s |
| 2 | 一次性任务 (recurring=false) | 84 | 78 | 7 | 62 | 1 | 0 | 2 | 10.7s |
| 3 | 持久化任务 (durable=true) | 107 | 101 | 7 | 85 | 1 | 0 | 2 | 10.4s |
| 4 | 纯文本基线 | 11 | 9 | 0 | 2 | 0 | 0 | 1 | 3.6s |
| 5 | SSE 前端视角 | ~80 | ~74 | 6-7 | ~60 | 1 | 0 | 2 | ~14s |

### 6.2 原始事件样本（关键事件的 JSON）

#### content_block_start(tool_use) — CronCreate 调用开始

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "call_09331ad65e344db39e7a67d5",
      "name": "CronCreate",
      "input_schema": { ... }
    }
  }
}
```

#### user 消息 — tool_result（CronCreate 执行结果）

**recurring=true, durable=false**:
```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "id": "5c0f7d0e",
    "humanSchedule": "Every 5 minutes",
    "recurring": true,
    "durable": false
  },
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "call_09331ad65e344db39e7a67d5",
      "content": "Scheduled recurring job 5c0f7d0e (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
    }]
  }
}
```

**recurring=false, durable=false**:
```json
{
  "tool_use_result": {
    "id": "938184e5",
    "humanSchedule": "Every day at 4:00 PM",
    "recurring": false,
    "durable": false
  },
  "message": {
    "content": [{
      "type": "tool_result",
      "content": "Scheduled one-shot task 938184e5 (Every day at 4:00 PM). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete."
    }]
  }
}
```

**recurring=true, durable=true**:
```json
{
  "tool_use_result": {
    "id": "4324c4a1",
    "humanSchedule": "Every day at 9:00 AM",
    "recurring": true,
    "durable": true
  },
  "message": {
    "content": [{
      "type": "tool_result",
      "content": "Scheduled recurring job 4324c4a1 (Every day at 9:00 AM). Persisted to .claude/scheduled_tasks.json. Auto-expires after 7 days. Use CronDelete to cancel sooner."
    }]
  }
}
```

---

## 七、与其他工具的对比

| 维度 | CronCreate | Bash | AskUserQuestion | Read |
|------|-----------|------|-----------------|------|
| **执行类型** | 瞬时（内存操作） | 长时间（进程执行） | 瞬时（用户交互） | 瞬时（文件读取） |
| **tool_progress** | ❌ 0 次 | ✅ 有（显示执行进度） | ❌ 0 次 | ❌ 0 次 |
| **tool_use_summary** | ❌ 0 次 | 可能出现 | ❌ 0 次 | 可能出现 |
| **需要权限** | ❌ No | ✅ Yes | ❌ No | ❌ No |
| **需要 canUseTool** | ❌ 不需要 | 需要授权 | ✅ 需要返回 answers | 不需要 |
| **tool_result 结构** | `{id, humanSchedule, recurring, durable}` | `{stdout, stderr, interrupted}` | `{questions, answers}` | `{type, content, ...}` |
| **input_json_delta 次数** | 6-7 次 | 3-5 次 | 4 次 | 1-2 次 |
| **用户交互** | 无 | 无 | 需要表单 UI | 无 |
| **前端渲染** | 参数表 + 结果卡片 | 终端输出 | 表单 + 答案 | 代码高亮 |

---

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| `recurring=false + durable=true` 的 tool_result 格式 | 未测试 | 推断为持久化一次性任务 |
| 无效 cron 表达式的错误返回 | 未测试 | 工具应返回错误 |
| 超过 50 个任务的限制 | 未测试 | SDK 限制每会话 50 个 |
| `CLAUDE_CODE_DISABLE_CRON=1` 时调用 CronCreate | 未测试 | 应返回错误 |
| CronDelete 使用返回的 job ID | 未测试 | 需要单独测试 CronDelete |
| 多个 CronCreate 并行调用 | 未测试 | 一个 assistant 消息中多个 tool_use |
| durable=true 时 `.claude/scheduled_tasks.json` 的实际写入 | 未验证 | 需要检查文件系统 |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `test/integration/stream-tool-croncreate.spec.ts` | 本实验测试文件（6 cases） |
| `wiki/claude-code/croncreate-tool.md` | CronCreate 工具详解（官方文档整理） |
| `raw/stream-event-types-behavior.md` | SDK 流式事件类型全景 |
| `raw/stream-ask-user-question-behavior.md` | AskUserQuestion 流式工具调用对比 |
| `raw/stream-tool-bash-behavior.md` | Bash 流式工具调用对比 |
