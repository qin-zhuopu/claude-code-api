# Bash 工具流式调用行为观察报告

**日期**: 2026-05-13
**测试文件**: `test/integration/stream-tool-bash.spec.ts`
**测试用例数**: 6（SDK 直接调用 4 + NestJS SSE 2）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `command`（必需）、`description`（可选）、`timeout`（可选）、`run_in_background`（可选）、`dangerouslyDisableSandbox`（可选） |
| tool_result 结构（SDK层） | `{ stdout: string, stderr: string, interrupted: boolean, isImage: false, noOutputExpected: false }`（成功时为对象）；错误时为字符串 `"Error: Exit code 1\n..."` |
| tool_result 结构（API层） | `content` 始终为 **纯文本 string**，`is_error` 区分成功/失败 |
| stream_event 总数 | 简单命令 ~32 个（含流式文本输出） |
| tool_progress 推送次数 | **0 次**（命令执行 <2s 时不推送 tool_progress） |
| input_json_delta 推送次数 | **4-5 次**：`""` → `"{"` → `"command": "..."` → `", \"description\": \"...\"` → `"}"` |
| 状态更新频率 | **低**：只有 2 个 system(status) 事件（每个 API turn 一个） |

---

## 一、tool_use 调用格式

### input_schema（来自 SDK 类型定义 `sdk-tools.d.ts`）

```typescript
interface BashInput {
  command: string;                    // 必需：要执行的命令
  timeout?: number;                   // 可选：超时毫秒数（最大 600000）
  description?: string;               // 可选：命令描述（5-10词简述）
  run_in_background?: boolean;        // 可选：是否后台运行
  dangerouslyDisableSandbox?: boolean; // 可选：是否禁用沙箱
}
```

### 实际 input 示例（来自 assistant 消息的 tool_use block）

**简单命令**：
```json
{
  "command": "echo hello-world",
  "description": "Execute echo command to output hello-world"
}
```

**循环命令**：
```json
{
  "command": "for i in $(seq 1 50); do echo \"Line $i: This is a test output line number $i\"; done"
}
```

**失败命令**：
```json
{
  "command": "cat /nonexistent_file_xyz.txt",
  "description": "Attempt to cat a file that does not exist"
}
```

**注意**：`description` 字段在 LLM 调用中**不一定出现**（Case-2 循环命令没有 description），但当 LLM 生成时通常会包含。

### input_json_delta 流式构建过程

Bash 工具的 input 通过 `input_json_delta` 分 4-5 次推送：

```
delta[0]: ""                                                    ← 空字符串
delta[1]: "{"                                                   ← JSON 开始
delta[2]: "\"command\": \"echo hello-world\""                   ← command 字段
delta[3]: ", \"description\": \"Execute echo...\""              ← description 字段（可选）
delta[4]: "}"                                                   ← JSON 结束
```

**拼接后完整 JSON**：
```json
{"command": "echo hello-world", "description": "Execute echo command to output hello-world"}
```

---

## 二、tool_result 返回值格式

### 2.1 双层结构

Bash 工具的返回值存在两层包装：

| 层级 | 位置 | 成功时格式 | 失败时格式 |
|------|------|-----------|-----------|
| SDK 层 | `user.tool_use_result` | `{ stdout, stderr, interrupted, ... }` 对象 | `"Error: Exit code 1\n..."` 字符串 |
| API 层 | `user.message.content[0].content` | 纯文本 `"hello-world"` + `is_error: false` | 纯文本 `"Exit code 1\n..."` + `is_error: true` |

### 2.2 SDK 层 — user 消息完整结构（成功）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "call_0a8f5db9f8fd47648086cb10",
        "type": "tool_result",
        "content": "hello-world",
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-05-13T15:54:48.981Z",
  "tool_use_result": {
    "stdout": "hello-world",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

### 2.3 SDK 层 — user 消息完整结构（失败）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "call_f56b0b841558417fa7be3e5a",
        "type": "tool_result",
        "content": "Exit code 1\ncat: /nonexistent_file_xyz.txt: No such file or directory",
        "is_error": true
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "tool_use_result": "Error: Exit code 1\ncat: /nonexistent_file_xyz.txt: No such file or directory"
}
```

### 2.4 字段说明

| 字段 | 路径 | 类型 | 说明 |
|------|------|------|------|
| `stdout` | `tool_use_result.stdout` | string | 命令标准输出（仅在成功时存在） |
| `stderr` | `tool_use_result.stderr` | string | 命令标准错误（仅在成功时存在） |
| `interrupted` | `tool_use_result.interrupted` | boolean | 是否被中断（仅在成功时存在） |
| `isImage` | `tool_use_result.isImage` | boolean | stdout 是否包含图片数据 |
| `noOutputExpected` | `tool_use_result.noOutputExpected` | boolean | 命令是否预期无输出 |
| `is_error` | `message.content[].is_error` | boolean | API 层错误标志 |
| `content` | `message.content[].content` | string | API 层纯文本内容 |

### 2.5 BashOutput 完整类型（来自 sdk-tools.d.ts）

```typescript
interface BashOutput {
  stdout: string;
  stderr: string;
  rawOutputPath?: string;              // 大输出时的文件路径
  interrupted: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;           // 后台任务 ID
  backgroundedByUser?: boolean;        // 用户手动后台化
  assistantAutoBackgrounded?: boolean; // 自动后台化
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;   // 非错误退出码的语义解释
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;        // 超大输出的持久化路径
  persistedOutputSize?: number;
  staleReadFileStateHint?: string;
  ghRateLimitHint?: string;
}
```

---

## 三、流式事件序列

### 3.1 完整时间线（Case-1: 简单命令）

```
[  0] system init                        ← 会话初始化
[  1] system status                      ← 状态更新（requesting）
[  2] stream_event message_start         ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start   ← thinking block 开始
[  4] stream_event content_block_stop    ← thinking block 结束（本地无思考模型，0.9s 空等）
[  5] stream_event content_block_start   ← tool_use block 开始 [Bash]
[  6] stream_event input_json_delta: ""  ← JSON 片段 1
[  7] stream_event input_json_delta: "{" ← JSON 片段 2
[  8] stream_event input_json_delta: "\"command\": \"echo hello-world\""  ← JSON 片段 3
[  9] stream_event input_json_delta: ", \"description\": \"Execute echo...\""  ← JSON 片段 4
[ 10] stream_event input_json_delta: "}" ← JSON 片段 5
[ 11] assistant [tool_use: Bash]         ← 完整 tool_use block
[ 12] stream_event content_block_stop    ← tool_use block 结束
[ 13] stream_event message_delta         ← stop_reason: "tool_use"
[ 14] stream_event message_stop          ← 第 1 轮 API 调用结束
     ─── SDK 自动执行 Bash 命令（~13s）───
[ 15] user tool_result                   ← 命令结果作为 user 消息
[ 16] system status                      ← 状态更新
[ 17] stream_event message_start         ← 第 2 轮 API 调用开始
[ 18] stream_event content_block_start   ← thinking block
[19-26] stream_event text_delta × 8      ← 流式文本 "The output is: `hello-world`"
[ 27] assistant [text]                   ← 完整 text block
[ 28] stream_event content_block_stop
[ 29] stream_event message_delta
[ 30] stream_event message_stop          ← 第 2 轮 API 调用结束
[ 31] result                             ← 最终结果 {num_turns: 2, stop_reason: "end_turn"}
```

**总事件数**: 32（含流式）
**总耗时**: ~21.6 秒
**num_turns**: 2

### 3.2 各阶段事件数量统计

| 阶段 | 事件类型 | 数量 |
|------|----------|------|
| 初始化 | system(init) + system(status) | 2 |
| 第 1 轮 API（tool_use） | stream_event × 11 + assistant × 1 | 12 |
| 工具执行 | user × 1 + system(status) × 1 | 2 |
| 第 2 轮 API（文本） | stream_event × 12 + assistant × 1 | 13 |
| 结果 | result × 1 | 1 |
| **总计** | | **32** |

### 3.3 对比：关闭流式（Case-6）

| 维度 | 开启流式（Case-1） | 关闭流式（Case-6） |
|------|-------------------|-------------------|
| **总事件数** | 32 | 6 |
| **stream_event** | 25 | 0 |
| **assistant** | 2 | 2 |
| **user** | 1 | 1 |
| **system** | 3 | 1 |
| **result** | 1 | 1 |
| **done** | 0 | 1 |
| **可做逐字渲染** | ✅ | ❌ |

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**实验数据**：
- Case-1（简单 echo，<1s）：**0 次** tool_progress
- Case-2（50 行循环，<1s）：**0 次** tool_progress
- Case-3（失败命令，<1s）：**0 次** tool_progress

**结论**：Bash 命令在 **< 2 秒** 内完成时，SDK **不推送** tool_progress 事件。tool_progress 仅在命令执行时间较长（>2s）时才会出现。

### 4.2 SDK 推送频率统计

| 事件类型 | 推送次数 | 推送时机 |
|----------|---------|----------|
| `system(status)` | 2 次 | 每个 API turn 开始时 |
| `tool_progress` | 0 次（快速命令） | 仅长命令（>2s） |
| `tool_use_summary` | 0 次 | 仅复杂工具调用后 |
| `input_json_delta` | 4-5 次 | tool_use block 构建时 |
| `text_delta` | 8-20 次 | 文本输出阶段 |

### 4.3 是否需要不断修改前端状态？

**✅ 需要修改，但频率可控**：

1. **`input_json_delta` 阶段**（4-5 次）：拼接 JSON 字符串，每次 try-parse
2. **工具执行等待阶段**（0 次更新）：快速命令无中间状态
3. **`text_delta` 阶段**（8-20 次）：追加文本到输出缓冲区

**与 AskUserQuestion 对比**：
| 维度 | Bash | AskUserQuestion |
|------|------|-----------------|
| tool_progress | 0（快速命令） | 0 |
| input_json_delta | 4-5 次 | 4 次 |
| tool_result 复杂度 | 较高（stdout/stderr/interrupted） | 简单（文本字符串） |
| 需要交互 | ❌ | ✅（需要用户回答） |

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
// Bash 工具的 input（来自 tool_use block）
interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
}

// Bash 工具的 output（来自 tool_use_result）
interface BashToolOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage?: boolean;
  noOutputExpected?: boolean;
  backgroundTaskId?: string;
  returnCodeInterpretation?: string;
  persistedOutputPath?: string;
  persistedOutputSize?: number;
}

// Bash 工具执行状态
type BashToolStatus = 'calling' | 'running' | 'complete' | 'error';

// 渲染用的 Bash block 数据
interface BashToolBlock {
  type: 'tool_use';
  toolName: 'Bash';
  toolUseId: string;
  input: BashToolInput;
  output?: BashToolOutput | string; // 成功时为对象，失败时为字符串
  status: BashToolStatus;
  elapsedTime?: number;            // 来自 tool_progress
  isStopped?: boolean;             // 来自 interrupted
}
```

### 5.2 状态机设计

```
                input_json_delta 拼接
calling ──────────────────────────────→ waiting_execution
    │                                       │
    │ (content_block_stop)                  │ (user tool_result)
    ↓                                       ↓
running ──────────────────────────────→ complete / error
    │
    │ (tool_progress)
    ↓
running (更新 elapsedTime)
```

### 5.3 组件模板

```vue
<template>
  <el-card class="bash-tool-card" :class="statusClass">
    <template #header>
      <div class="bash-header">
        <div class="bash-title">
          <el-icon><Monitor /></el-icon>
          <el-tag :type="statusTagType" size="small">Bash</el-tag>
          <code class="command-preview">{{ input?.command }}</code>
        </div>
        <div class="bash-status">
          <el-tag v-if="status === 'running'" type="warning" size="small">
            <el-icon class="is-loading"><Loading /></el-icon>
            执行中 {{ elapsedTime }}s
          </el-tag>
          <el-tag v-else-if="status === 'complete'" type="success" size="small">
            <el-icon><CircleCheck /></el-icon> 完成
          </el-tag>
          <el-tag v-else-if="status === 'error'" type="danger" size="small">
            <el-icon><CircleClose /></el-icon> 失败
          </el-tag>
        </div>
      </div>
    </template>

    <!-- 工具参数（可折叠） -->
    <el-collapse v-model="showDetails">
      <el-collapse-item title="命令详情" name="input">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="command">
            <code>{{ input?.command }}</code>
          </el-descriptions-item>
          <el-descriptions-item v-if="input?.description" label="description">
            {{ input.description }}
          </el-descriptions-item>
          <el-descriptions-item v-if="input?.timeout" label="timeout">
            {{ input.timeout }}ms
          </el-descriptions-item>
        </el-descriptions>
      </el-collapse-item>
    </el-collapse>

    <!-- 工具结果 — 终端风格 -->
    <div v-if="output" class="bash-output">
      <!-- 成功：显示 stdout -->
      <template v-if="typeof output === 'object' && !isError">
        <div v-if="output.stdout" class="stdout-block">
          <div class="output-label">stdout:</div>
          <pre class="terminal-output"><code>{{ output.stdout }}</code></pre>
        </div>
        <div v-if="output.stderr" class="stderr-block">
          <div class="output-label">stderr:</div>
          <pre class="terminal-output stderr"><code>{{ output.stderr }}</code></pre>
        </div>
      </template>
      <!-- 失败：显示错误信息 -->
      <template v-else>
        <pre class="terminal-output error"><code>{{ typeof output === 'string' ? output : 'Unknown error' }}</code></pre>
      </template>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Monitor, Loading, CircleCheck, CircleClose } from '@element-plus/icons-vue'

const props = defineProps<{
  input?: BashToolInput
  output?: BashToolOutput | string
  status: BashToolStatus
  elapsedTime?: number
}>()

const showDetails = ref<string[]>([])
const isError = computed(() => props.status === 'error')
const statusClass = computed(() => `status-${props.status}`)
const statusTagType = computed(() => {
  switch (props.status) {
    case 'calling': return 'info'
    case 'running': return 'warning'
    case 'complete': return 'success'
    case 'error': return 'danger'
    default: return 'info'
  }
})
</script>

<style scoped>
.bash-tool-card { margin: 8px 0; border-radius: 8px; }
.bash-header { display: flex; justify-content: space-between; align-items: center; }
.command-preview {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  color: #606266;
  margin-left: 8px;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-output {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: 6px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.terminal-output.stderr { color: #f48771; }
.terminal-output.error { color: #f48771; border: 1px solid #f56c6c; }
.output-label { font-size: 12px; color: #909399; margin-bottom: 4px; }
.status-calling { border-left: 3px solid #409eff; }
.status-running { border-left: 3px solid #e6a23c; }
.status-complete { border-left: 3px solid #67c23a; }
.status-error { border-left: 3px solid #f56c6c; }
</style>
```

### 5.4 事件处理逻辑（在 useClaudeStream composable 中）

```typescript
// 在 processStreamEvent 中处理 Bash 相关的 input_json_delta
function processBashInput(delta: string, block: ContentBlock) {
  inputJsonBuffer += delta
  try {
    const parsed = JSON.parse(inputJsonBuffer)
    block.toolInput = parsed as BashToolInput
  } catch { /* JSON 不完整 */ }
}

// 在 processToolResult 中处理 Bash 结果
function processBashResult(msg: SDKUserMessage, block: ContentBlock) {
  const result = msg.tool_use_result

  if (typeof result === 'string') {
    // 失败：错误信息字符串
    block.toolResult = result
    block.toolStatus = 'error'
  } else if (typeof result === 'object' && result !== null) {
    // 成功：BashOutput 对象
    const bashOutput = result as BashToolOutput
    block.toolResult = bashOutput
    block.toolStatus = 'complete'
  }
}
```

### 5.5 关键交互处理

Bash 工具**不需要用户交互**（与 AskUserQuestion 不同），但需要权限确认。

| 交互场景 | 处理方式 |
|----------|----------|
| 权限确认 | `canUseTool` 回调或 `permissionMode: 'bypassPermissions'` |
| 长命令进度 | 监听 `tool_progress` 事件，更新 `elapsedTime` |
| 后台任务 | `run_in_background: true` 时，`backgroundTaskId` 返回任务 ID |
| 大输出截断 | `persistedOutputPath` 指向完整输出文件 |

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | stream_event | assistant | user | result | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------|------|--------|--------------|-----------|------|
| 1 | 简单命令（echo） | 32 | 25 | 2 | 1 | 1 | 0 | 2 | 21.6s |
| 2 | 长输出（50行循环） | 42 | 33 | 2 | 1 | 1 | 0 | 2 | 22.1s |
| 3 | 失败命令 | 36+ | 28+ | 2 | 1 | 1 | 0 | 2 | ~26.5s |
| 4 | 纯文本基线 | ~16 | ~12 | 1-2 | 0 | 1 | 0 | 1 | ~5s |
| 5 | SSE（echo） | 39 | 29 | 2 | 1 | 1 | 0 | 2 | 36.4s |
| 6 | SSE（关闭流式） | 6 | 0 | 2 | 1 | 1 | 0 | 2 | ~23.4s |

### 6.2 原始事件样本

#### Case-1 关键事件 JSON

**content_block_start（tool_use）**：
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "call_0a8f5db9f8fd47648086cb10",
      "name": "Bash",
      "input_schema": { ... }
    }
  }
}
```

**assistant 完整 tool_use block**：
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "" },
      {
        "type": "tool_use",
        "id": "call_0a8f5db9f8fd47648086cb10",
        "name": "Bash",
        "input": {
          "command": "echo hello-world",
          "description": "Execute echo command to output hello-world"
        }
      }
    ]
  }
}
```

**user 消息（tool_result 成功）**：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_0a8f5db9f8fd47648086cb10",
        "content": "hello-world",
        "is_error": false
      }
    ]
  },
  "tool_use_result": {
    "stdout": "hello-world",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

**user 消息（tool_result 失败）**：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_f56b0b841558417fa7be3e5a",
        "content": "Exit code 1\ncat: /nonexistent_file_xyz.txt: No such file or directory",
        "is_error": true
      }
    ]
  },
  "tool_use_result": "Error: Exit code 1\ncat: /nonexistent_file_xyz.txt: No such file or directory"
}
```

#### SSE 包装格式（Case-5）

```json
// system(init) — type: text
{"type": "text", "content": "{...}", "ts": 1778687577548}

// stream_event — type: partial
{"type": "partial", "content": "{\"type\":\"stream_event\",\"event\":{...}}", "ts": 1778687577555}

// assistant — type: text
{"type": "text", "content": "{\"type\":\"assistant\",\"message\":{...}}", "ts": 1778687577635}

// user — type: text
{"type": "text", "content": "{\"type\":\"user\",...}", "ts": 1778687584281}

// result — type: text
{"type": "text", "content": "{\"type\":\"result\",...}", "ts": 1778687587837}

// done — type: done
{"type": "done"}
```

---

## 七、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| `tool_progress` 的推送频率 | 未触发 | 需要执行 >2s 的命令（如 `sleep 5`）来观察 |
| `run_in_background` 模式 | 未测试 | 后台任务应产生 `backgroundTaskId` 和持续的输出 |
| 大输出截断 | 未测试 | 超过 30000 字符时的 `persistedOutputPath` |
| 沙箱模式 | 未测试 | `dangerouslyDisableSandbox` 的影响 |
| `structuredContent` | 未测试 | SDK 类型中存在但未观测到 |
| `ghRateLimitHint` | 未测试 | GitHub API 速率限制提示 |
| 并行 Bash 调用 | 未测试 | 多个 tool_use block 并行执行 |
| `staleReadFileStateHint` | 未测试 | 命令执行期间文件被修改时的提示 |

---

## 八、与已有工具对比

| 维度 | Bash | AskUserQuestion | Read | Glob |
|------|------|-----------------|------|------|
| 需要权限 | ✅ Yes | ❌ No | ❌ No | ❌ No |
| tool_result 结构 | 复杂（stdout/stderr/interrupted） | 简单（文本） | 文件内容 | 文件列表 |
| 失败时 tool_use_result | **字符串** | N/A | N/A | N/A |
| tool_progress | 可能（>2s） | 无 | 无 | 无 |
| 用户交互 | ❌ | ✅ | ❌ | ❌ |
| input_json_delta 推送次数 | 4-5 | 4 | 2-3 | 2-3 |
| 执行延迟 | 可变（命令执行时间） | 瞬时 | 瞬时 | 瞬时 |

---

## 九、实际应用建议

1. **前端渲染 Bash 输出时区分成功/失败**：检查 `is_error` 字段，成功用终端风格显示 `stdout`，失败用红色高亮显示错误信息
2. **监听 `tool_use_result` 的类型**：`typeof === 'string'` 为失败，`typeof === 'object'` 为成功
3. **长命令时显示进度**：虽然简单命令不推送 `tool_progress`，但前端应准备好处理 `elapsed_time_seconds` 更新
4. **大输出场景**：检查 `persistedOutputPath`，提供"查看完整输出"的链接
5. **终端风格渲染**：使用等宽字体 + 深色背景，支持 ANSI 颜色码（如果 stdout 包含）
