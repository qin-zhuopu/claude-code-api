# SDK 流式事件类型与前端渲染洞察文档

**日期**: 2026-05-13
**来源**: `sdk.d.ts` 类型分析 + `stream-event-types.spec.ts` 观察性测试
**主题**: SDK 流式事件类型全景、推送机制、Vue3 + Element Plus 渲染方案

---

## 核心发现摘要

| 发现 | 说明 |
|------|------|
| **SDK 消息类型共 27 种** | 但常见场景只出现 4-5 种 |
| **流式 = stream_event + assistant 配对** | 每个 API turn：先推若干 stream_event，再推完整 assistant |
| **content block 有 3 种 delta** | text_delta（文本）、thinking_delta（思考）、input_json_delta（工具参数） |
| **工具调用增加 user 消息** | 工具执行结果以 SDKUserMessage 回传，触发新一轮 API 调用 |
| **关闭流式后事件数暴降** | 88 → 5 个事件，只有 system/assistant/result |
| **tool_progress 只在工具执行期间出现** | 纯文本场景为 0 |

---

## 一、SDK 消息类型全景分类

### 1.1 按 SDK 消息 type 分组

SDK 的 `query()` async generator yield 的每条消息都是 `SDKMessage` 联合类型之一。按实际出现频率分为三档：

#### 🔴 高频（每次查询必有）

| type | TypeScript 类型 | 实验数据（case-1 文本） | 说明 |
|------|----------------|----------------------|------|
| `system` | `SDKSystemMessage` | 2 条（init + status） | 会话初始化和状态更新 |
| `stream_event` | `SDKPartialAssistantMessage` | 50-82 条 | **流式片段**，开启 includePartialMessages 时推送 |
| `assistant` | `SDKAssistantMessage` | 2 条 | **完整消息**，每个 content block 一条 |
| `result` | `SDKResultSuccess \| SDKResultError` | 1 条 | 最终结果（成功/失败） |

#### 🟡 中频（工具调用场景出现）

| type | TypeScript 类型 | 说明 |
|------|----------------|------|
| `user` | `SDKUserMessage` | 工具执行结果以 user 消息回传，触发新一轮 API 调用 |
| `tool_progress` | `SDKToolProgressMessage` | 工具执行期间定期推送（含 tool_name, elapsed_time_seconds） |
| `tool_use_summary` | `SDKToolUseSummaryMessage` | 工具使用摘要（长工具调用后的压缩描述） |

#### 🟢 低频（特殊场景）

| type | 说明 |
|------|------|
| `auth_status` | 认证状态变更 |
| `rate_limit_event` | 速率限制 |
| `notification` | 文本通知（key/priority/timeout） |
| `local_command_output` | 本地命令输出 |
| `memory_recall` | Agent memory 召回 |
| `prompt_suggestion` | 建议的下一个 prompt |
| 各种 `system` subtype | api_retry、compact_boundary、task_*、hook_*、plugin_install 等 |

### 1.2 system 消息的 subtype 分布

`system` 类型通过 `subtype` 字段区分具体含义。实验观测到的 subtype：

| subtype | 频率 | 说明 |
|---------|------|------|
| `init` | 每次必有 | 会话初始化（含 tools、model、skills、cwd 列表） |
| `status` | 常见 | 状态更新（loading 等） |

SDK 类型定义中还有 15+ 种 subtype（api_retry、compact_boundary、task_started 等），但在简单场景中不出现。

---

## 二、stream_event 内部结构深度分析

### 2.1 event.type 的完整生命周期

一个完整的 API turn 中，stream_event 内部的 event.type 遵循固定顺序：

```
message_start                    ← 消息开始
  content_block_start (thinking)  ← 思考块开始
  content_block_delta (thinking_delta) × N  ← 思考内容流式推送
  content_block_stop              ← 思考块结束
  content_block_start (text)      ← 文本块开始
  content_block_delta (text_delta) × N      ← 文本内容流式推送
  content_block_stop              ← 文本块结束
message_delta                     ← 消息级增量（stop_reason, usage）
message_stop                      ← 消息结束
```

**实验数据（case-1 纯文本）**：
```
message_start:         1
content_block_start:   2  (thinking + text)
content_block_delta:  43  (41 thinking_delta + 2 text_delta)
content_block_stop:    2
message_delta:         1
message_stop:          1
```

### 2.2 工具调用时的 content block 变化

工具调用时，content_block_start 的 type 变为 `tool_use`，并增加 `input_json_delta`：

**实验数据（case-2 Read 工具调用）**：
```
content_block_start: 4  (2 thinking + 1 tool_use + 1 text)
delta types:
  thinking_delta:    51
  input_json_delta:   1  ← 工具参数流式输入
  text_delta:        10
```

工具调用时的事件序列：
```
第 1 轮 API 调用:
  message_start → thinking → content_block_start(tool_use)
  → input_json_delta × N → content_block_stop → message_stop
  → assistant(tool_use) → user(tool_result)

第 2 轮 API 调用:
  message_start → thinking → text
  → content_block_delta(text_delta) × N → content_block_stop
  → message_stop → assistant(text) → result
```

### 2.3 delta.type 的三种类型

| delta.type | 含义 | 推送频率 | 渲染建议 |
|------------|------|----------|----------|
| `text_delta` | 文本增量，`delta.text` 含具体文本 | 每几 token 推一次 | **追加到文本缓冲区** |
| `thinking_delta` | 思考增量，`delta.thinking` 含思考内容 | 通常比 text_delta 多很多 | **折叠显示，或隐藏** |
| `input_json_delta` | 工具参数增量，`delta.partial_json` 是 JSON 片段 | 工具调用时出现 | **拼接后 JSON.parse** 获取工具参数 |

### 2.4 includePartialMessages 开/关对比

| 维度 | 开启 (true) | 关闭 (false) |
|------|-------------|--------------|
| **事件总数** | 88 个 | 5 个 |
| **stream_event** | 82 个 | 0 个 |
| **assistant** | 2 个 | 2 个 |
| **system** | 2 个 | 1 个 |
| **可做逐字渲染** | ✅ | ❌ |
| **延迟感** | 低（首 token 即可显示） | 高（等完整响应） |

---

## 三、工具调用场景的完整事件时间线

以 "Read ./package.json" 为例（case-2 实验数据）：

```
[  0] system (init)              ← 会话初始化
[  1] system (status)            ← 状态更新
[  2] stream_event message_start ← 第 1 轮 API 调用开始
[  3-39] stream_event (thinking + tool_use deltas)
[ 40] assistant (thinking block) ← 完整思考 block
[ 41-43] stream_event (input_json_delta)
[ 44] assistant (tool_use block) ← 完整工具调用 block {name: "Read", input: {file_path: "./package.json"}}
[ 45-46] stream_event (content_block_stop, message_stop)
[ 47] user (tool_result)         ← SDK 自动执行 Read 工具，结果作为 user 消息
[ 48] stream_event message_start ← 第 2 轮 API 调用开始
[ 49-79] stream_event (thinking + text deltas)
[ 80] assistant (text block)     ← 完整回复 block "项目名称是：claude-code-api"
[ 81-83] stream_event (stop)
[ 84] result (success)           ← 最终结果
[ 85] (string) done              ← NestJS SSE done 事件
```

**关键发现**：
- 工具调用场景有 2 轮 API 调用（num_turns: 2）
- `assistant` 消息数量翻倍（4 条 vs 2 条）
- 工具执行结果以 `user` 消息形式回传
- `input_json_delta` 只在工具参数构建时推送

---

## 四、Vue3 + Element Plus 渲染方案

### 4.1 核心数据模型

```typescript
// 消息列表中的每一条
interface ChatMessage {
  id: string
  role: 'system' | 'assistant' | 'user' | 'tool_result'
  // assistant 消息的 content blocks
  blocks: ContentBlock[]
  status: 'streaming' | 'complete'
}

interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  // text/thinking
  text?: string
  // tool_use
  toolUseId?: string
  toolName?: string
  toolInput?: Record<string, any>
  toolResult?: any
  toolStatus?: 'calling' | 'running' | 'complete' | 'error'
}
```

### 4.2 事件处理状态机

SDK 的事件流需要用状态机管理。核心状态：

```typescript
interface StreamState {
  messages: ChatMessage[]
  currentBlock: ContentBlock | null
  currentMessageId: string | null
  currentTurnIndex: number     // 当前 API turn（用于区分多轮）
  isStreaming: boolean
  inputJsonBuffer: string      // input_json_delta 拼接缓冲
}
```

### 4.3 事件处理器映射

```typescript
function handleEvent(event: SDKMessage, state: StreamState) {
  switch (event.type) {
    case 'system':
      // init: 初始化会话信息
      // status: 显示状态条
      break

    case 'stream_event':
      handleStreamEvent(event.event, state)
      break

    case 'assistant':
      // 完整消息，可用于校验或最终更新
      finalizeAssistantMessage(event, state)
      break

    case 'user':
      // 工具执行结果 → 更新对应 tool_use block
      updateToolResult(event, state)
      break

    case 'result':
      // 最终结果 → 结束流式
      state.isStreaming = false
      break

    case 'tool_progress':
      // 工具执行进度 → 更新进度条
      updateToolProgress(event, state)
      break

    case 'tool_use_summary':
      // 工具使用摘要 → 显示折叠摘要
      break
  }
}

function handleStreamEvent(event: BetaRawMessageStreamEvent, state: StreamState) {
  switch (event.type) {
    case 'message_start':
      // 开始新的 assistant 消息
      state.currentMessageId = uuid()
      state.messages.push({
        id: state.currentMessageId,
        role: 'assistant',
        blocks: [],
        status: 'streaming',
      })
      state.currentTurnIndex++
      break

    case 'content_block_start':
      // 新 content block
      const block = event.content_block
      if (block.type === 'text') {
        state.currentBlock = { type: 'text', text: '' }
      } else if (block.type === 'thinking') {
        state.currentBlock = { type: 'thinking', text: '' }
      } else if (block.type === 'tool_use') {
        state.currentBlock = {
          type: 'tool_use',
          toolUseId: block.id,
          toolName: block.name,
          toolInput: {},
          toolStatus: 'calling',
        }
        state.inputJsonBuffer = ''
      }
      break

    case 'content_block_delta':
      const delta = event.delta
      if (delta.type === 'text_delta') {
        // ✅ 追加文本 — Vue3 响应式自动更新
        state.currentBlock!.text! += delta.text
      } else if (delta.type === 'thinking_delta') {
        state.currentBlock!.text! += delta.thinking
      } else if (delta.type === 'input_json_delta') {
        // ✅ 拼接工具参数 JSON 片段
        state.inputJsonBuffer += delta.partial_json
        try {
          state.currentBlock!.toolInput = JSON.parse(state.inputJsonBuffer)
        } catch {
          // JSON 不完整，继续拼接
        }
      }
      break

    case 'content_block_stop':
      // block 结束，追加到 messages
      if (state.currentMessageId && state.currentBlock) {
        const msg = state.messages.find(m => m.id === state.currentMessageId)
        if (msg) msg.blocks.push(state.currentBlock)
      }
      state.currentBlock = null
      break

    case 'message_delta':
      // stop_reason、usage 更新
      break

    case 'message_stop':
      // 消息结束
      break
  }
}
```

### 4.4 Vue3 组件设计

```
<ChatView>
  <MessageList>
    <SystemMessage v-for="sys in systemMessages" />
    <AssistantMessage v-for="msg in assistantMessages">
      <ThinkingBlock v-if="block.type === 'thinking'" :text="block.text" />
      <TextBlock v-if="block.type === 'text'" :text="block.text" />
      <ToolUseBlock v-if="block.type === 'tool_use'"
        :name="block.toolName"
        :input="block.toolInput"
        :status="block.toolStatus"
        :result="block.toolResult"
      />
    </AssistantMessage>
  </MessageList>
</ChatView>
```

### 4.5 各 Block 类型的 Element Plus 渲染建议

#### TextBlock — 文本块
```vue
<template>
  <div class="text-block" v-html="renderedMarkdown" />
</template>
```
- **无需特殊组件**：直接渲染 markdown（推荐 markdown-it 或 marked）
- **流式追加**：每次 text_delta 追加到 text 字符串，Vue 响应式自动更新
- **性能优化**：用 `computed` 做 markdown 渲染，加 `debounce` 避免每次 delta 都重渲染

#### ThinkingBlock — 思考块
```vue
<template>
  <el-collapse>
    <el-collapse-item title="🧠 思考过程">
      <pre class="thinking-text">{{ text }}</pre>
    </el-collapse-item>
  </el-collapse>
</template>
```
- **默认折叠**：思考过程通常很长（占 delta 的 90%+），默认隐藏
- **用 el-collapse**：展开可查看完整思考过程
- **渐进显示**：展开时才实时追加 thinking_delta

#### ToolUseBlock — 工具调用块
```vue
<template>
  <el-card class="tool-use-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">{{ toolName }}</el-tag>
        <el-tag v-if="status === 'running'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          执行中 {{ elapsedSeconds }}s
        </el-tag>
        <el-tag v-else-if="status === 'complete'" type="success">完成</el-tag>
      </div>
    </template>

    <!-- 工具参数（JSON 格式展示） -->
    <el-descriptions v-if="toolInput" :column="1" border size="small">
      <el-descriptions-item v-for="(value, key) in toolInput" :key="key" :label="key">
        {{ typeof value === 'string' ? value : JSON.stringify(value) }}
      </el-descriptions-item>
    </el-descriptions>

    <!-- 工具结果（根据类型渲染） -->
    <ToolResultRenderer v-if="toolResult" :toolName="toolName" :result="toolResult" />
  </el-card>
</template>
```

#### ToolResultRenderer — 工具结果渲染器
不同工具的返回值格式不同（参见 `sdk-tools.d.ts`）：

| 工具 | 返回值结构 | 渲染建议 |
|------|-----------|----------|
| **Read** | `{ type: 'text', file: { filePath, content, numLines, ... } }` | 代码高亮（hljs/prism） |
| **Read** (image) | `{ type: 'image', file: { base64, type } }` | `<el-image>` |
| **Bash** | `{ stdout, stderr, interrupted }` | 终端风格展示 stdout |
| **Glob** | `{ filenames: string[], numFiles, truncated }` | 文件列表 |
| **Grep** | `{ content?, filenames, numFiles }` | 搜索结果列表 |
| **Edit** | `{ filePath, structuredPatch }` | Diff 视图 |
| **Write** | `{ type: 'create' \| 'update', filePath }` | 简单标签 |
| **Agent** | `{ content: [{text}], totalToolUseCount, totalDurationMs, usage }` | 嵌套消息列表 |
| **WebFetch** | `{ result, bytes, code, durationMs }` | 文本展示 |
| **WebSearch** | `{ results: [{content: [{title, url}]}] }` | 搜索结果链接列表 |
| **AskUserQuestion** | `{ questions, answers }` | 问答表单（需要交互） |

### 4.6 状态更新频率分析

**核心问题：SDK 会推送很多次状态更新吗？**

实验数据：
- 纯文本场景（case-1）：**50 个 stream_event**（43 个 delta + 7 个控制事件）
- 工具调用场景（case-2）：**76 个 stream_event**（62 个 delta + 14 个控制事件）
- 关闭流式（case-3）：**0 个 stream_event**，只有 5 个总事件

**频率**：
- text_delta：每 1-3 个 token 推一次，约 50-100ms 间隔
- thinking_delta：更频繁，占 delta 总量的 90%+
- input_json_delta：工具参数通常 1-3 次推送完毕

**是否需要不断修改状态？**
- ✅ 是的，如果要做逐字流式输出
- 但 Vue3 的响应式系统天然适合这种场景：
  - `text` 字符串追加操作，Vue 自动 diff 更新 DOM
  - `thinking_delta` 如果默认折叠，不触发实际 DOM 更新
  - `input_json_delta` 通常是 1-3 次，开销极小

**优化建议**：
1. thinking block 默认折叠 → 不渲染文本，只计数
2. markdown 渲染用 debounce（每 100ms 重新渲染一次）
3. 长工具结果用虚拟滚动（el-table-v2）

---

## 五、SSE 传输层包装格式

NestJS 的 SSE 推送有额外包装层：

```
data: {"type":"text","content":"{\"type\":\"system\",\"subtype\":\"init\",...}","ts":1715600000000}
data: {"type":"partial","content":"{\"type\":\"stream_event\",\"event\":{...}}","ts":1715600000001}
data: {"type":"text","content":"{\"type\":\"assistant\",...}","ts":1715600000002}
data: {"type":"text","content":"{\"type\":\"result\",...}","ts":1715600000003}
data: {"type":"done"}
```

前端解析流程：
```typescript
// 1. 解析 SSE line
const raw = JSON.parse(line.slice(5))  // { type: 'text'|'partial', content: string|object, ts }

// 2. 解析 content（可能是字符串或对象）
let inner = raw.content
if (typeof inner === 'string') inner = JSON.parse(inner)

// 3. 根据 inner.type 路由到对应处理器
switch (inner.type) {
  case 'stream_event': handleStreamEvent(inner)
  case 'assistant': handleAssistantMessage(inner)
  case 'system': handleSystemMessage(inner)
  case 'result': handleResultMessage(inner)
  case 'user': handleUserMessage(inner)
}
```

---

## 六、完整 Vue3 Composable 示例

```typescript
// useClaudeStream.ts
import { ref, reactive, computed } from 'vue'

interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text?: string
  toolUseId?: string
  toolName?: string
  toolInput?: any
  toolStatus?: 'calling' | 'running' | 'complete'
  toolResult?: any
}

interface ChatMessage {
  id: string
  role: 'assistant' | 'user' | 'system'
  blocks: ContentBlock[]
  status: 'streaming' | 'complete'
}

export function useClaudeStream() {
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const error = ref<string | null>(null)

  // 流式状态
  let currentBlock: ContentBlock | null = null
  let currentMessageId: string | null = null
  let inputJsonBuffer = ''

  async function sendQuery(prompt: string) {
    isStreaming.value = true
    error.value = null
    currentBlock = null
    inputJsonBuffer = ''

    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        options: {
          includePartialMessages: true,
          // ... 其他选项
        },
      }),
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const match = line.match(/^data:\s*(.+)$/)
          if (!match) continue

          const raw = JSON.parse(match[1])
          if (raw.type === 'done') continue
          if (raw.type === 'error') { error.value = raw.error; continue }

          let inner = raw.content
          if (typeof inner === 'string') {
            try { inner = JSON.parse(inner) } catch { continue }
          }

          processSDKMessage(inner)
        }
      }
    } finally {
      isStreaming.value = false
    }
  }

  function processSDKMessage(msg: any) {
    switch (msg.type) {
      case 'stream_event':
        processStreamEvent(msg.event)
        break
      case 'assistant':
        // 完整消息到达，可用于校验
        if (currentMessageId) {
          const m = messages.value.find(m => m.id === currentMessageId)
          if (m) m.status = 'complete'
        }
        break
      case 'user':
        // 工具执行结果 → 查找对应的 tool_use block 并更新
        processToolResult(msg)
        break
      case 'result':
        isStreaming.value = false
        break
    }
  }

  function processStreamEvent(event: any) {
    if (!event) return

    switch (event.type) {
      case 'message_start':
        currentMessageId = `msg_${Date.now()}`
        messages.value.push({
          id: currentMessageId,
          role: 'assistant',
          blocks: [],
          status: 'streaming',
        })
        break

      case 'content_block_start':
        const block = event.content_block
        if (block.type === 'text') {
          currentBlock = { type: 'text', text: '' }
        } else if (block.type === 'thinking') {
          currentBlock = { type: 'thinking', text: '' }
        } else if (block.type === 'tool_use') {
          currentBlock = {
            type: 'tool_use',
            toolUseId: block.id,
            toolName: block.name,
            toolInput: {},
            toolStatus: 'calling',
          }
          inputJsonBuffer = ''
        }
        break

      case 'content_block_delta':
        if (!currentBlock) break
        const delta = event.delta
        if (delta.type === 'text_delta') {
          currentBlock.text! += delta.text
        } else if (delta.type === 'thinking_delta') {
          currentBlock.text! += delta.thinking
        } else if (delta.type === 'input_json_delta') {
          inputJsonBuffer += delta.partial_json
          try {
            currentBlock.toolInput = JSON.parse(inputJsonBuffer)
          } catch { /* incomplete JSON */ }
        }
        break

      case 'content_block_stop':
        if (currentMessageId && currentBlock) {
          const msg = messages.value.find(m => m.id === currentMessageId)
          if (msg) {
            // Vue3 reactive array push 触发更新
            msg.blocks = [...msg.blocks, { ...currentBlock }]
          }
        }
        currentBlock = null
        break
    }
  }

  function processToolResult(msg: any) {
    // 找到最后一个匹配的 tool_use block 并更新
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      for (const block of m.blocks) {
        if (block.type === 'tool_use' && block.toolStatus === 'calling') {
          block.toolStatus = 'complete'
          block.toolResult = msg.tool_use_result || msg.message?.content
          return
        }
      }
    }
  }

  return { messages, isStreaming, error, sendQuery }
}
```

---

## 七、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| `tool_progress` 推送频率 | 未观测 | 只在工具执行期间出现，实验用 simple agent 无工具 |
| `agentProgressSummaries` 效果 | 未测试 | SDK 选项，可能产生 tool_use_summary |
| `forwardSubagentText` 效果 | 未测试 | 子 Agent 的文本/思考是否转发 |
| 多工具并行调用 | 未测试 | 一个 assistant 消息中多个 tool_use block |
| `thinking` 配置的影响 | 未测试 | adaptive vs enabled vs disabled 对 delta 的影响 |
| Agent 工具的嵌套事件流 | 未测试 | 子 Agent 内部事件的 parent_tool_use_id |
| 图片/PDF Read 的返回结构 | 未测试 | `type: 'image'` / `type: 'pdf'` 的实际数据 |

---

## 八、实验矩阵

| Case | 场景 | 总事件 | stream_event | assistant | user | result | num_turns |
|------|------|--------|-------------|-----------|------|--------|-----------|
| 1 | 纯文本 | 56 | 50 | 2 | 0 | 1 | 1 |
| 2 | Read 工具 | 86 | 76 | 4 | 1 | 1 | 2 |
| 3 | 关闭流式 | 5 | 0 | 2 | 0 | 1 | 1 |
| 4 | system subtype | (同 case-1) | - | - | - | - | - |
| 6 | tool_progress | (纯文本) | - | - | 0 | - | - |

---

## 九、实际应用建议

1. **必须开启 `includePartialMessages`**：否则无法做流式渲染
2. **thinking block 默认折叠**：thinking_delta 占 90%+ 的事件量，不折叠会严重影响性能
3. **input_json_delta 拼接后解析**：不要对每个 delta 都 try parse，只在拼接缓冲变化时尝试
4. **工具结果按工具类型分派渲染**：每种工具有特定的返回值格式，需要不同的 Vue 组件
5. **状态管理用 reactive 而非 ref**：content block 的嵌套更新需要深层响应式
6. **SSE 解析注意 content 可能是 string 或 object**：NestJS 层可能序列化也可能直接传对象
