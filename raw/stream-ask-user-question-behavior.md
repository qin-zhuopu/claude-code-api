# AskUserQuestion 流式工具调用洞察文档

**日期**: 2026-05-13
**测试文件**: `test/integration/stream-ask-user-question.spec.ts`
**测试用例数**: 5（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 发现 | 说明 |
|------|------|
| **AskUserQuestion 是瞬时工具** | 无 `tool_progress` 事件，无状态持续更新 |
| **input_json_delta 通常 4 次** | 空字符串 → `{` → 大段 JSON → `}` |
| **tool_result 是纯文本字符串** | 格式：`User has answered your questions: "问题"="答案"` |
| **user.tool_use_result 包含完整结构** | 同时包含 questions + answers 的 JSON 对象 |
| **事件总数与问题复杂度正相关** | 单问题 35 个事件，双问题 130 个事件 |
| **两轮 API 调用** | 第 1 轮：tool_use → canUseTool → tool_result；第 2 轮：LLM 总结 |

---

## 一、完整事件时间线（实验数据）

### 1.1 Case-1: 单选单问题

```
[  0] system init                        ← 会话初始化
[  1] system status                      ← 状态更新
[  2] stream_event message_start         ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start   ← thinking block
[  4] stream_event content_block_stop    ← thinking 结束
[  5] stream_event content_block_start   ← tool_use block (AskUserQuestion)
[  6] stream_event content_block_delta   ← input_json_delta: ""
[  7] stream_event content_block_delta   ← input_json_delta: "{"
[  8] stream_event content_block_delta   ← input_json_delta: "\"questions\": [...]"
[  9] stream_event content_block_delta   ← input_json_delta: "}"
[ 10] assistant                          ← 完整 tool_use block {name: "AskUserQuestion", input: {...}}
[ 11] stream_event content_block_stop    ← tool_use block 结束
[ 12] stream_event message_delta         ← stop_reason
[ 13] stream_event message_stop          ← 第 1 轮 API 调用结束
     ─── canUseTool 回调触发（异步，在 assistant 和 content_block_stop 之间）───
[ 14] user                               ← SDK 注入 tool_result（含 answers）
[ 15] system status                      ← 状态更新
[ 16] stream_event message_start         ← 第 2 轮 API 调用开始
[ 17] stream_event content_block_start   ← thinking block
[18-33] stream_event text_delta × 16     ← 流式文本输出
[ 31] assistant                          ← 完整 text block
[ 32] stream_event content_block_stop
[ 33] stream_event message_delta
[ 34] stream_event message_stop          ← 第 2 轮 API 调用结束
[ 35] result                             ← 最终结果 {num_turns: 2, stop_reason: "end_turn"}
```

**总事件数**: 36（不含 canUseTool 回调）
**总耗时**: ~9.6 秒
**num_turns**: 2

### 1.2 Case-2: 双问题（单选 + 多选）

```
[  0] system init
[  1] system status
[  2] stream_event message_start
[  3] stream_event content_block_start       ← thinking
[  4-17] stream_event text_delta × 14        ← LLM 先输出一段文字说明
[ 18] assistant                              ← 完整 text block
[ 19] stream_event content_block_stop
[ 20] stream_event content_block_start       ← tool_use (AskUserQuestion)
[ 21] stream_event input_json_delta: ""
[ 22] stream_event input_json_delta: "{"
[ 23] stream_event input_json_delta: "\"questions\": [{...}, {...}]"
[ 24] stream_event input_json_delta: "}"
[ 25] assistant                              ← 完整 tool_use block
[ 26] stream_event content_block_stop
[ 27] stream_event message_delta
[ 28] stream_event message_stop
     ─── canUseTool 回调触发 ───
[ 29] user                                   ← tool_result（含双问题答案）
[ 30] system status
[ 31] stream_event message_start             ← 第 2 轮
[ 32] stream_event content_block_start
[33-125] stream_event text_delta × 93        ← 长文本回复
[126] assistant
[127] stream_event content_block_stop
[128] stream_event message_delta
[129] stream_event message_stop
[130] result                                 ← {num_turns: 2, duration_ms: 13797}
```

**总事件数**: 131
**总耗时**: ~14 秒
**关键差异**: LLM 在第 1 轮同时输出了 text block + tool_use block

---

## 二、input_json_delta 流式构建详解

### 2.1 拼接模式

AskUserQuestion 的 input 通过 `input_json_delta` 分 4 次推送：

| 序号 | partial_json 内容 | 时间间隔 |
|------|-------------------|----------|
| 1 | `""` (空字符串) | 0ms (紧接着 content_block_start) |
| 2 | `"{"` | ~20-30ms |
| 3 | `"\"questions\": [{...}]"` | ~2.5-4s (LLM 构思内容) |
| 4 | `"}"` | ~100ms |

**拼接后完整 JSON（单选案例）**:
```json
{
  "questions": [{
    "question": "Which testing framework would you like to use?",
    "header": "Testing Framework",
    "options": [
      {"label": "Jest", "description": "Popular JavaScript testing framework with..."},
      {"label": "Vitest", "description": "Fast ESM testing framework built on Vite"},
      {"label": "Mocha", "description": "Flexible, JavaScript test framework for..."}
    ],
    "multiSelect": false
  }]
}
```

**拼接后完整 JSON（双问题案例）**:
```json
{
  "questions": [
    {
      "question": "Which testing framework would you like to use?",
      "header": "Testing Framework",
      "options": [
        {"label": "Jest", "description": "..."},
        {"label": "Vitest", "description": "..."}
      ],
      "multiSelect": false
    },
    {
      "question": "Which features would you like to enable for your project?",
      "header": "Features",
      "options": [
        {"label": "TypeScript", "description": "..."},
        {"label": "ESLint", "description": "..."},
        {"label": "Prettier", "description": "..."},
        {"label": "Husky", "description": "..."}
      ],
      "multiSelect": true
    }
  ]
}
```

### 2.2 前端解析策略

由于第 3 次 delta 包含完整的 `questions` 数组内容（通常几百到几千字符），前端可以：

1. **等待第 3 次 delta 后尝试 JSON.parse** — 此时 JSON 可能仍不完整（缺少 `}`）
2. **使用增量 JSON 解析器** — 在每次 delta 后尝试 parse，失败则继续拼接
3. **等待 content_block_stop 后使用 assistant 消息中的完整 input** — 最安全

**推荐策略**: 在 `content_block_delta(input_json_delta)` 时拼接 buffer 并尝试 parse；在 `assistant(tool_use)` 到达后用完整的 `input` 覆盖。

---

## 三、tool_result 输出格式详解

### 3.1 API 层面的 tool_result（发给 LLM 的）

SDK 将 canUseTool 返回的 `updatedInput`（含 answers）转换为格式化文本字符串：

```
User has answered your questions: "问题1"="答案1", "问题2"="答案2". You can now continue with the user's answers in mind.
```

**实际 HTTP 请求中的 tool_result**:
```json
{
  "type": "tool_result",
  "content": "User has answered your questions: \"Which testing framework would you like to use?\"=\"Jest\". You can now continue with the user's answers in mind.",
  "tool_use_id": "call_96861d33a06844c9a2e46d40",
  "cache_control": {"type": "ephemeral"}
}
```

**多选格式**:
```
User has answered your questions: "Which testing framework would you like to use?"="Jest", "Which features would you like to enable for your project?"="TypeScript, ESLint". You can now continue with the user's answers in mind.
```

### 3.2 SDK user 消息中的 tool_use_result（流式事件层）

SDK 的 `user` 类型消息包含两个层面的数据：

```json
{
  "type": "user",
  "parent_tool_use_id": null,
  "tool_use_result": {
    "questions": [...],           // 原始 questions
    "answers": {                  // 用户回答
      "问题文本": "选项label"
    }
  },
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "call_xxx",
      "content": "User has answered your questions: \"...\"=\"...\". You can now continue..."
    }]
  }
}
```

**关键区别**:
- `tool_use_result`: **结构化数据**（JSON 对象，包含 questions + answers）
- `message.content[].content`: **格式化文本**（给 LLM 看的自然语言）

---

## 四、状态更新频率分析

### 4.1 AskUserQuestion 是否触发大量状态更新？

**结论：否。AskUserQuestion 是瞬时工具，不产生 tool_progress 事件。**

实验数据对比：

| 维度 | 纯文本（case-4） | AskUserQuestion 单选（case-1） | AskUserQuestion 双问题（case-2） |
|------|-----------------|-------------------------------|-------------------------------|
| 总事件数 | ~20 | 36 | 131 |
| stream_event | ~15 | 29 | 124 |
| text_delta | ~3 | 16 | 107 |
| input_json_delta | 0 | 4 | 4 |
| tool_progress | 0 | 0 | 0 |
| system status | 1 | 2 | 2 |
| user 消息 | 0 | 1 | 1 |
| num_turns | 1 | 2 | 2 |

### 4.2 状态更新事件类型

AskUserQuestion 调用期间的唯一"状态"事件是：

1. **`system(status)`** — 在 tool_result 注入后触发（第 2 轮开始前）
2. **`assistant(tool_use)`** — 完整的 tool_use block 到达（在最后一个 input_json_delta 之后）

**没有**以下事件：
- ❌ `tool_progress` — AskUserQuestion 不是长时间运行的工具
- ❌ `tool_use_summary` — AskUserQuestion 不需要摘要压缩
- ❌ `system(api_retry)` — 如果成功就没有重试

### 4.3 前端是否需要"不断修改状态"？

**不需要持续轮询式更新。** 但需要处理以下瞬时事件：

| 时刻 | 事件 | 前端状态变化 |
|------|------|------------|
| content_block_start(tool_use) | 工具调用开始 | 显示"AskUserQuestion 调用中" |
| input_json_delta × 4 | 参数构建 | 渐进显示 questions 参数 |
| assistant(tool_use) | 完整参数到达 | 可以开始渲染表单 UI |
| user(tool_result) | 答案已提交 | 更新工具状态为"已完成" |
| text_delta × N | 第二轮文本 | 渐进显示总结文本 |

**核心发现**: AskUserQuestion 的交互流程是 **"一次性等待"** — 用户在 canUseTool 回调中提供答案，SDK 立即注入 tool_result，没有中间的"用户正在输入"状态。对前端来说，这是一个同步阻塞操作。

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 AskUserQuestion 的两种渲染模式

前端渲染 AskUserQuestion 需要考虑**两种场景**：

#### 场景 A: SDK 直接集成（有 canUseTool 回调）

此时前端自己处理 canUseTool 逻辑：
```
LLM → input_json_delta → 前端展示表单 → 用户填写 → canUseTool 返回答案
```

#### 场景 B: 通过 NestJS SSE（无 canUseTool）

此时需要额外机制传递用户答案：
```
LLM → input_json_delta → 前端展示表单 → 用户填写 → HTTP POST 提交答案
```

### 5.2 数据模型

```typescript
interface AskUserQuestionBlock {
  type: 'tool_use'
  toolName: 'AskUserQuestion'
  toolUseId: string
  status: 'building' | 'waiting_answer' | 'answered'
  input: {
    questions: Array<{
      question: string
      header: string
      options: Array<{
        label: string
        description: string
        preview?: string
      }>
      multiSelect: boolean
    }>
  }
  answers?: Record<string, string>  // 用户提交后
  toolResult?: string               // SDK 返回的格式化文本
}

// 流式构建状态
interface AskUserQuestionBuilder {
  jsonBuffer: string
  parsedInput: AskUserQuestionBlock['input'] | null
  status: 'building' | 'waiting_answer' | 'answered'
}
```

### 5.3 Vue3 组件设计

```vue
<!-- AskUserQuestionBlock.vue -->
<template>
  <el-card class="ask-user-question-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag type="info">AskUserQuestion</el-tag>
        <el-tag v-if="status === 'building'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          正在构建问题...
        </el-tag>
        <el-tag v-else-if="status === 'waiting_answer'" type="danger">
          等待用户回答
        </el-tag>
        <el-tag v-else type="success">已完成</el-tag>
      </div>
    </template>

    <!-- 问题列表 -->
    <div v-if="parsedInput" class="questions-container">
      <div v-for="(q, qi) in parsedInput.questions" :key="qi" class="question-item">
        <h4>{{ q.question }}</h4>
        <el-tag size="small" type="info">{{ q.header }}</el-tag>

        <el-checkbox-group v-if="q.multiSelect" v-model="selectedOptions[qi]">
          <el-checkbox
            v-for="(opt, oi) in q.options"
            :key="oi"
            :label="opt.label"
            :value="opt.label"
          >
            <el-tooltip :content="opt.description" placement="top">
              <span>{{ opt.label }}</span>
            </el-tooltip>
          </el-checkbox>
        </el-checkbox-group>

        <el-radio-group v-else v-model="selectedOptions[qi]">
          <el-radio
            v-for="(opt, oi) in q.options"
            :key="oi"
            :value="opt.label"
          >
            <el-tooltip :content="opt.description" placement="top">
              <span>{{ opt.label }}</span>
            </el-tooltip>
          </el-radio>
        </el-radio-group>
      </div>

      <!-- 提交按钮 -->
      <el-button
        v-if="status === 'waiting_answer'"
        type="primary"
        @click="submitAnswers"
        :disabled="!allAnswered"
      >
        提交回答
      </el-button>
    </div>

    <!-- 构建中占位 -->
    <div v-else-if="status === 'building'" class="building-placeholder">
      <el-skeleton :rows="3" animated />
    </div>

    <!-- 完成后显示答案摘要 -->
    <div v-if="toolResult" class="result-summary">
      <el-text type="success">{{ toolResult }}</el-text>
    </div>
  </el-card>
</template>
```

### 5.4 事件处理状态机

```typescript
// useAskUserQuestion.ts
import { ref, reactive, computed } from 'vue'

export function useAskUserQuestion() {
  const status = ref<'idle' | 'building' | 'waiting_answer' | 'answered'>('idle')
  const jsonBuffer = ref('')
  const parsedInput = ref<any>(null)
  const selectedOptions = reactive<Record<number, string | string[]>>({})
  const toolResult = ref<string | null>(null)

  function handleStreamEvent(event: any) {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.name === 'AskUserQuestion') {
          status.value = 'building'
          jsonBuffer.value = ''
          parsedInput.value = null
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'input_json_delta') {
          jsonBuffer.value += event.delta.partial_json
          // 尝试增量解析
          try {
            parsedInput.value = JSON.parse(jsonBuffer.value)
            status.value = 'waiting_answer'
          } catch {
            // JSON 不完整，继续拼接
          }
        }
        break

      case 'content_block_stop':
        if (status.value === 'building') {
          // 尝试最终解析
          try {
            parsedInput.value = JSON.parse(jsonBuffer.value)
            status.value = 'waiting_answer'
          } catch {
            console.error('AskUserQuestion input JSON parse failed')
          }
        }
        break
    }
  }

  function handleAssistantMessage(msg: any) {
    // assistant 消息包含完整的 tool_use block
    for (const block of msg.content || []) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
        parsedInput.value = block.input
        status.value = 'waiting_answer'
      }
    }
  }

  function handleUserMessage(msg: any) {
    // user 消息包含 tool_result
    if (msg.tool_use_result) {
      status.value = 'answered'
    }
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          toolResult.value = block.content
        }
      }
    }
  }

  const allAnswered = computed(() => {
    if (!parsedInput.value?.questions) return false
    return parsedInput.value.questions.every((q: any, i: number) => {
      const sel = selectedOptions[i]
      return Array.isArray(sel) ? sel.length > 0 : !!sel
    })
  })

  function getAnswers(): Record<string, string> {
    const answers: Record<string, string> = {}
    if (parsedInput.value?.questions) {
      for (let i = 0; i < parsedInput.value.questions.length; i++) {
        const q = parsedInput.value.questions[i]
        const sel = selectedOptions[i]
        answers[q.question] = Array.isArray(sel) ? sel.join(', ') : (sel as string)
      }
    }
    return answers
  }

  return {
    status,
    parsedInput,
    selectedOptions,
    toolResult,
    allAnswered,
    handleStreamEvent,
    handleAssistantMessage,
    handleUserMessage,
    getAnswers,
  }
}
```

### 5.5 SSE 场景下的答案提交流程

在 NestJS SSE 场景中，canUseTool 回调无法直接工作。需要额外的 API 端点：

```typescript
// 后端：新增 answer-question 端点
// POST /api/query/answer
// Body: { sessionId, toolUseId, answers }

// 方案 A: 使用 SDK 的 streamInput
const session = activeSessions.get(sessionId)
await session.streamInput({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `User has answered your questions: ${formatAnswers(answers)}`
    }]
  },
  parent_tool_use_id: null,
})

// 方案 B: 使用 canUseTool 的 Promise 机制
// 前端提交 → 后端 resolve pending canUseTool promise
```

**注意**: 当前 NestJS SSE 实现中 `canUseTool` 未配置，AskUserQuestion 会因无回调而可能超时。需要补充这个机制。

---

## 六、实验矩阵

| Case | 场景 | 总事件 | stream_event | input_json_delta | text_delta | user | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------------|------------|------|--------------|-----------|------|
| 1 | 单选单问题 (SDK) | 36 | 29 | 4 | 16 | 1 | 0 | 2 | 9.6s |
| 2 | 双问题+多选 (SDK) | 131 | 124 | 4 | 107 | 1 | 0 | 2 | 14s |
| 3 | SSE 前端视角 | ~50 | ~40 | 4 | ~20 | 1 | 0 | 2 | ~15s |
| 4 | 纯文本基线 (SDK) | ~20 | ~15 | 0 | ~3 | 0 | 0 | 1 | ~4s |
| 5 | SSE 数据格式 | ~50 | ~40 | 4 | ~20 | 1 | 0 | 2 | ~15s |

---

## 七、与普通工具调用的事件流对比

| 维度 | Read/Bash 等普通工具 | AskUserQuestion |
|------|---------------------|-----------------|
| tool_progress | ✅ 有（显示执行进度） | ❌ 无（瞬时完成） |
| tool_use_summary | 可能出现 | ❌ 无 |
| canUseTool 语义 | 权限确认（allow/deny） | 问题回答（allow + updatedInput 含 answers） |
| tool_result 内容 | 工具执行结果（文件内容/命令输出） | 格式化文本 `"问题"="答案"` |
| user.tool_use_result | 无（或工具原始输出） | `{questions: [...], answers: {...}}` |
| 用户交互方式 | 一次性 allow/deny | 需要表单 UI，用户填写后提交 |
| 事件增量 | 工具执行期间有状态更新 | 交互期间无状态更新（等待用户） |

---

## 八、实际应用建议

### 8.1 前端渲染优先级

1. **content_block_start(tool_use, name="AskUserQuestion")** → 显示表单占位
2. **input_json_delta** → 增量构建表单，每次尝试 JSON.parse
3. **assistant(tool_use)** → 用完整 input 覆盖（最终确认）
4. **等待用户填写** → 前端表单交互
5. **user(tool_result)** → 更新为已完成状态

### 8.2 SSE 场景下的关键缺失

当前 NestJS SSE 服务端 **没有** canUseTool 回调配置，这意味着：
- AskUserQuestion 的 LLM 调用后，SDK 会等待 canUseTool 回调
- 如果没有回调，会话可能挂起
- **需要新增 API 端点**让前端提交答案并 resolve pending 的 canUseTool Promise

### 8.3 性能优化

1. **AskUserQuestion 的 input_json_delta 只有 4 次** — 不需要频繁 JSON.parse，在第 3 次后尝试一次即可
2. **不需要虚拟滚动** — questions 最多 4 个，每个最多 4 个选项
3. **tool_result 到达后可以折叠表单** — 避免长对话中表单占据大量空间

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| preview 字段的实际效果 | 未测试 | 需配合 toolConfig.previewFormat |
| annotations 字段的填入 | 未测试 | 用户是否会在前端填写 notes |
| AskUserQuestion 超时行为 | 未测试 | 如果 canUseTool 长时间不返回会怎样 |
| 多个 tool_use 包含 AskUserQuestion | 未测试 | 是否可能并行调用多个 AskUserQuestion |
| deny AskUserQuestion 的行为 | 未测试 | canUseTool 返回 deny 后的 LLM 行为 |
| 验证错误的 tool_result 格式 | 部分 | 已知 InputValidationError 格式，需更多案例 |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `test/integration/stream-ask-user-question.spec.ts` | 本实验测试文件（5 cases） |
| `test/integration/tool-ask-user-question.spec.ts` | AskUserQuestion 工具行为测试（16 cases） |
| `raw/tool-ask-user-question-behavior.md` | AskUserQuestion 工具行为洞察 |
| `raw/stream-event-types-behavior.md` | SDK 流式事件类型全景 |
| `raw/tool-user-interaction-behavior.md` | SDK 工具-用户交互机制全景 |
