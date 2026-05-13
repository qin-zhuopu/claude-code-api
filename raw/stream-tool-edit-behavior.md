# Edit 工具流式调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-edit.spec.ts`
**测试用例数**: 5（SDK 直接调用 3 + NestJS SSE 2）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `file_path`（必需）、`old_string`（必需）、`new_string`（必需）、`replace_all`（可选，默认 false） |
| tool_result 结构（成功） | **结构化对象**：`{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }` |
| tool_result 结构（失败） | **字符串**：`"Error: String to replace not found in file.\nString: ..."` |
| stream_event 总数 | 简单编辑 ~141 个（含 3 轮 API 调用：Read + Edit + 文本回复） |
| tool_progress 推送次数 | **0 次**（Edit 是瞬时操作） |
| input_json_delta 推送次数 | **6 次**：`""` → `"{"` → `"file_path"` → `", \"old_string\": \"...\"` → `", \"new_string\": \"...\"` → `"}"` |
| num_turns | **3**（第 1 轮文本+Read、第 2 轮文本+Edit、第 3 轮文本回复） |
| 状态更新频率 | **低**：每轮 API 调用一个 system(status) 事件 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK 类型定义 `sdk-tools.d.ts`）

```typescript
interface FileEditInput {
  file_path: string;      // 必需：要修改的文件的绝对路径
  old_string: string;     // 必需：要替换的文本
  new_string: string;     // 必需：替换后的文本（必须与 old_string 不同）
  replace_all?: boolean;  // 可选：是否替换所有匹配（默认 false）
}
```

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**简单编辑（Case-1）**：
```json
{
  "replace_all": false,
  "file_path": "C:/Users/.../test-edit.txt",
  "old_string": "Hello World",
  "new_string": "Hello Claude"
}
```

**关键观察**：
- `replace_all` 字段即使为 false，LLM 也会显式传入（SDK 默认 false）
- `file_path` 使用正斜杠 `/` 格式（即使在 Windows 上）
- `old_string` 和 `new_string` 的值是精确匹配的原始文本

### 1.3 input_json_delta 流式构建过程

Edit 工具的 input 通过 `input_json_delta` 分 6 次推送：

```
delta[0]: ""                                                    ← 空字符串
delta[1]: "{"                                                   ← JSON 开始
delta[2]: "\"file_path\": \"C:/Users/.../test-edit.txt\""       ← file_path 字段
delta[3]: ", \"old_string\": \"Hello World\""                   ← old_string 字段
delta[4]: ", \"new_string\": \"Hello Claude\""                  ← new_string 字段
delta[5]: "}"                                                   ← JSON 结束
```

**与 Bash 对比**：Edit 多一个 delta（因为有更多字段），每个字段作为独立 delta 推送。

**拼接后完整 JSON**：
```json
{"file_path": "C:/Users/.../test-edit.txt", "old_string": "Hello World", "new_string": "Hello Claude"}
```

**注意**：`replace_all` 在 delta 中未出现，但在 assistant 完整消息中出现了。这说明 SDK 可能在最终 assistant 消息中补全了默认值。

---

## 二、tool_result 返回值格式

### 2.1 双格式结构（成功 vs 失败）

| 状态 | tool_use_result 类型 | 格式 |
|------|---------------------|------|
| 成功 | **object** | `{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }` |
| 失败 | **string** | `"Error: String to replace not found in file.\nString: NONEXISTENT_STRING_XYZ"` |

### 2.2 成功时完整结构（Case-1）

```json
{
  "filePath": "C:/Users/.../test-edit.txt",
  "oldString": "Hello World",
  "newString": "Hello Claude",
  "originalFile": "Hello World\nThis is a test file\nGoodbye World\n",
  "structuredPatch": [
    {
      "oldStart": 1,
      "oldLines": 3,
      "newStart": 1,
      "newLines": 3,
      "lines": [
        "-Hello World",
        "+Hello Claude",
        " This is a test file",
        " Goodbye World"
      ]
    }
  ],
  "userModified": false,
  "replaceAll": false
}
```

### 2.3 失败时完整结构（Case-2）

SDK 层：
```json
{
  "tool_use_result": "Error: String to replace not found in file.\nString: NONEXISTENT_STRING_XYZ"
}
```

API 层（message.content）：
```json
{
  "type": "tool_result",
  "tool_use_id": "call_b1bafbda58f14340805cbfde",
  "content": "<tool_use_error>String to replace not found in file.\nString: NONEXISTENT_STRING_XYZ</tool_use_error>"
}
```

**关键发现**：
- 失败时 `tool_use_result` 是字符串（与 Bash 工具的失败格式一致）
- `is_error` 字段为 `undefined`（不是 `true`）
- `content` 被 `<tool_use_error>` XML 标签包裹

### 2.4 字段说明

| 字段 | 路径 | 类型 | 说明 |
|------|------|------|------|
| `filePath` | `tool_use_result.filePath` | string | 被编辑的文件路径 |
| `oldString` | `tool_use_result.oldString` | string | 被替换的原始字符串 |
| `newString` | `tool_use_result.newString` | string | 替换后的新字符串 |
| `originalFile` | `tool_use_result.originalFile` | string \| null | 编辑前的完整文件内容 |
| `structuredPatch` | `tool_use_result.structuredPatch` | array | unified diff 格式的变更描述 |
| `userModified` | `tool_use_result.userModified` | boolean | 用户是否修改了提议的变更 |
| `replaceAll` | `tool_use_result.replaceAll` | boolean | 是否执行了全部替换 |

### 2.5 structuredPatch 格式

```typescript
interface StructuredPatch {
  oldStart: number;    // 旧文件起始行号
  oldLines: number;    // 旧文件涉及的行数
  newStart: number;    // 新文件起始行号
  newLines: number;    // 新文件涉及的行数
  lines: string[];     // unified diff 格式的行
}
```

`lines` 数组中每行的前缀：
- `"-"` 开头：删除的行（旧内容）
- `"+"` 开头：新增的行（新内容）
- `" "` 开头：未变更的上下文行

### 2.6 FileEditOutput 完整类型（来自 sdk-tools.d.ts）

```typescript
interface FileEditOutput {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
  userModified: boolean;
  replaceAll?: boolean;
}
```

---

## 三、流式事件序列

### 3.1 完整时间线（Case-1: 简单编辑，先 Read 再 Edit）

```
[  0] system init                        ← 会话初始化
[  1] system status                      ← 状态更新（requesting）
── 第 1 轮 API 调用（文本 + Read 工具）──
[  2] stream_event message_start
[  3] stream_event content_block_start   ← text block 开始
[ 4-16] stream_event text_delta × 13     ← 流式文本 "I'll read the file first..."
[ 17] assistant [text]                   ← 完整 text block
[ 18] stream_event content_block_stop    ← text block 结束
[ 19] stream_event content_block_start   ← tool_use block 开始 [Read]
[ 20] stream_event input_json_delta: ""  ← JSON 片段 1
[ 21] stream_event input_json_delta: "{" ← JSON 片段 2
[ 22] stream_event input_json_delta: "\"file_path\": \"...\"" ← JSON 片段 3
[ 23] stream_event input_json_delta: "}" ← JSON 片段 4
[ 24] assistant [tool_use: Read]         ← 完整 Read tool_use block
[ 25] stream_event content_block_stop    ← tool_use block 结束
[ 26] stream_event message_delta         ← stop_reason: "tool_use"
[ 27] stream_event message_stop          ← 第 1 轮结束
     ─── SDK 自动执行 Read 工具（瞬时）───
[ 28] user tool_result                  ← Read 结果（文件内容）
[ 29] system status                     ← 状态更新
── 第 2 轮 API 调用（文本 + Edit 工具）──
[ 30] stream_event message_start
[ 31] stream_event content_block_start   ← text block 开始
[ 32-45] stream_event text_delta × 14    ← 流式文本 "Now I'll replace..."
[ 46] assistant [text]                  ← 完整 text block
[ 47] stream_event content_block_stop
[ 48] stream_event content_block_start   ← tool_use block 开始 [Edit]
[ 49] stream_event input_json_delta: ""  ← JSON 片段 1
[ 50] stream_event input_json_delta: "{" ← JSON 片段 2
[ 51] stream_event input_json_delta: "\"file_path\": \"...\"" ← JSON 片段 3
[ 52] stream_event input_json_delta: ", \"old_string\": \"Hello World\"" ← JSON 片段 4
[ 53] stream_event input_json_delta: ", \"new_string\": \"Hello Claude\"" ← JSON 片段 5
[ 54] stream_event input_json_delta: "}" ← JSON 片段 6
[ 55] assistant [tool_use: Edit]         ← 完整 Edit tool_use block
[ 56] stream_event content_block_stop
[ 57] stream_event message_delta
[ 58] stream_event message_stop          ← 第 2 轮结束
     ─── SDK 自动执行 Edit 工具（瞬时）───
[ 59] user tool_result                  ← Edit 结果（structuredPatch）
[ 60] system status                     ← 状态更新
── 第 3 轮 API 调用（最终文本回复）──
[ 61] stream_event message_start
[ 62] stream_event content_block_start
[ 63-135] stream_event text_delta × 73   ← 流式文本 "## What I Changed..."
[136] assistant [text]                   ← 完整最终回复
[137] stream_event content_block_stop
[138] stream_event message_delta
[139] stream_event message_stop          ← 第 3 轮结束
[140] result                             ← {num_turns: 3, stop_reason: "end_turn"}
```

**总事件数**: 141（含流式）
**总耗时**: ~16.4 秒
**num_turns**: 3（比 Bash 的 2 轮多 1 轮，因为需要先 Read）

### 3.2 各阶段事件数量统计

| 阶段 | 事件类型 | 数量 |
|------|----------|------|
| 初始化 | system(init) + system(status) | 2 |
| 第 1 轮 API（text + Read） | stream_event × 23 + assistant × 2 | 25 |
| Read 执行 | user × 1 + system(status) × 1 | 2 |
| 第 2 轮 API（text + Edit） | stream_event × 28 + assistant × 2 | 30 |
| Edit 执行 | user × 1 + system(status) × 1 | 2 |
| 第 3 轮 API（最终文本） | stream_event × 77 + assistant × 1 | 78 |
| 结果 | result × 1 | 1 |
| **总计** | | **141** |

### 3.3 对比：关闭流式（Case-6）

| 维度 | 开启流式（Case-1） | 关闭流式（Case-6） |
|------|-------------------|-------------------|
| **总事件数** | ~141 | 8 |
| **stream_event** | 109 | 0 |
| **assistant** | 3 | 3 |
| **user** | 2 | 2 |
| **system** | 4 | 1 |
| **result** | 1 | 1 |
| **done** | 0 | 1 |
| **可做逐字渲染** | ✅ | ❌ |

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**实验数据**：
- Case-1（简单编辑，<1s）：**0 次** tool_progress
- Case-2（失败编辑，<1s）：**0 次** tool_progress

**结论**：Edit 工具是瞬时操作（字符串替换），SDK **不推送** tool_progress 事件。与 Bash 的快速命令行为一致。

### 4.2 SDK 推送频率统计

| 事件类型 | 推送次数 | 推送时机 |
|----------|---------|----------|
| `system(status)` | 3 次 | 每个 API turn 开始时（第 1 轮 1 次，第 2 轮 1 次，第 3 轮 1 次） |
| `tool_progress` | 0 次 | Edit 是瞬时操作 |
| `tool_use_summary` | 0 次 | 未触发 |
| `input_json_delta` | Read 4 次 + Edit 6 次 = 10 次 | 两个工具 block 构建时 |
| `text_delta` | ~100 次 | 三轮文本输出阶段 |

### 4.3 是否需要不断修改前端状态？

**✅ 需要修改，但频率可控**：

1. **`input_json_delta` 阶段**（Edit 6 次）：拼接 JSON 字符串，每次 try-parse
2. **工具执行等待阶段**（0 次更新）：瞬时操作无中间状态
3. **`text_delta` 阶段**（~100 次）：追加文本到输出缓冲区

**与 Bash 对比**：
| 维度 | Edit | Bash |
|------|------|------|
| 需要先调用其他工具 | ✅ Read（read-before-edit） | ❌ |
| tool_progress | 0 | 0（快速命令） |
| input_json_delta | 6 次 | 4-5 次 |
| num_turns | **3**（Read + Edit + 回复） | **2**（Bash + 回复） |
| tool_result 复杂度 | 高（structuredPatch） | 中（stdout/stderr） |
| 执行延迟 | 瞬时 | 可变 |

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
// Edit 工具的 input（来自 tool_use block）
interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

// Edit 工具的 output（成功时，来自 tool_use_result）
interface EditToolOutput {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: StructuredPatch[];
  userModified: boolean;
  replaceAll?: boolean;
}

interface StructuredPatch {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];  // unified diff 格式："-" 删除、"+" 新增、" " 上下文
}

// Edit 工具执行状态
type EditToolStatus = 'calling' | 'executing' | 'complete' | 'error';

// 渲染用的 Edit block 数据
interface EditToolBlock {
  type: 'tool_use';
  toolName: 'Edit';
  toolUseId: string;
  input: EditToolInput;
  output?: EditToolOutput | string;  // 成功时为对象，失败时为错误字符串
  status: EditToolStatus;
}
```

### 5.2 状态机设计

```
               input_json_delta 拼接
calling ────────────────────────────→ executing
    │                                    │
    │ (content_block_stop)               │ (user tool_result: object)
    ↓                                    ↓
executing ────────────────────────→ complete
    │
    │ (user tool_result: string)
    ↓
  error
```

### 5.3 组件模板

```vue
<template>
  <el-card class="edit-tool-card" :class="statusClass">
    <template #header>
      <div class="edit-header">
        <div class="edit-title">
          <el-icon><Edit /></el-icon>
          <el-tag :type="statusTagType" size="small">Edit</el-tag>
          <span class="file-name">{{ fileName }}</span>
        </div>
        <div class="edit-status">
          <el-tag v-if="status === 'executing'" type="warning" size="small">
            <el-icon class="is-loading"><Loading /></el-icon>
            执行中
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

    <!-- 编辑参数（可折叠） -->
    <el-collapse v-model="showDetails">
      <el-collapse-item title="编辑详情" name="input">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="file_path">
            <code>{{ input?.file_path }}</code>
          </el-descriptions-item>
          <el-descriptions-item label="old_string">
            <pre class="code-snippet old">{{ input?.old_string }}</pre>
          </el-descriptions-item>
          <el-descriptions-item label="new_string">
            <pre class="code-snippet new">{{ input?.new_string }}</pre>
          </el-descriptions-item>
          <el-descriptions-item v-if="input?.replace_all" label="replace_all">
            <el-tag type="warning" size="small">true</el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-collapse-item>
    </el-collapse>

    <!-- Diff 视图 — 核心渲染 -->
    <div v-if="patchOutput" class="edit-diff">
      <div class="diff-header">
        <span class="diff-file">{{ patchOutput.filePath }}</span>
        <el-tag v-if="patchOutput.userModified" type="warning" size="small">用户已修改</el-tag>
        <el-tag v-if="patchOutput.replaceAll" type="info" size="small">全部替换</el-tag>
      </div>
      <div class="diff-content">
        <div
          v-for="(line, i) in allDiffLines"
          :key="i"
          class="diff-line"
          :class="line.type"
        >
          <span class="line-number">{{ line.lineNum }}</span>
          <span class="line-prefix">{{ line.prefix }}</span>
          <span class="line-content">{{ line.content }}</span>
        </div>
      </div>
    </div>

    <!-- 错误展示 -->
    <div v-else-if="typeof output === 'string'" class="edit-error">
      <el-alert type="error" :closable="false" show-icon>
        <template #title>编辑失败</template>
        {{ output }}
      </el-alert>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Edit, Loading, CircleCheck, CircleClose } from '@element-plus/icons-vue'

const props = defineProps<{
  input?: EditToolInput
  output?: EditToolOutput | string
  status: EditToolStatus
}>()

const showDetails = ref<string[]>([])

const fileName = computed(() => {
  if (!props.input?.file_path) return ''
  const parts = props.input.file_path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1]
})

const patchOutput = computed(() => {
  if (typeof props.output === 'object' && props.output?.structuredPatch) {
    return props.output
  }
  return null
})

const allDiffLines = computed(() => {
  if (!patchOutput.value) return []
  const lines: { type: string; prefix: string; content: string; lineNum: number }[] = []
  for (const patch of patchOutput.value.structuredPatch) {
    let oldLine = patch.oldStart
    let newLine = patch.newStart
    for (const line of patch.lines) {
      const prefix = line[0]
      const content = line.slice(1)
      if (prefix === '-') {
        lines.push({ type: 'removed', prefix: '-', content, lineNum: oldLine++ })
      } else if (prefix === '+') {
        lines.push({ type: 'added', prefix: '+', content, lineNum: newLine++ })
      } else {
        lines.push({ type: 'context', prefix: ' ', content, lineNum: oldLine++ })
        newLine++
      }
    }
  }
  return lines
})

const statusClass = computed(() => `status-${props.status}`)
const statusTagType = computed(() => {
  switch (props.status) {
    case 'calling': return 'info'
    case 'executing': return 'warning'
    case 'complete': return 'success'
    case 'error': return 'danger'
    default: return 'info'
  }
})
</script>

<style scoped>
.edit-tool-card { margin: 8px 0; border-radius: 8px; }
.edit-header { display: flex; justify-content: space-between; align-items: center; }
.file-name {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  color: #606266;
  margin-left: 8px;
}
.code-snippet {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.code-snippet.old { background: #fef0f0; border: 1px solid #fbc4c4; }
.code-snippet.new { background: #f0f9eb; border: 1px solid #c2e7b0; }
.edit-diff { margin-top: 8px; }
.diff-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px;
  background: #f5f7fa;
  border-radius: 6px 6px 0 0;
  font-family: 'Cascadia Code', monospace;
  font-size: 13px;
}
.diff-content {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  background: #fafafa;
  border: 1px solid #e4e7ed;
  border-radius: 0 0 6px 6px;
  max-height: 400px;
  overflow: auto;
}
.diff-line {
  display: flex;
  padding: 0 8px;
  line-height: 1.6;
  min-height: 22px;
}
.diff-line.removed { background: #fef0f0; color: #f56c6c; }
.diff-line.added { background: #f0f9eb; color: #67c23a; }
.diff-line.context { color: #909399; }
.line-number {
  width: 40px;
  text-align: right;
  padding-right: 8px;
  color: #c0c4cc;
  user-select: none;
  flex-shrink: 0;
}
.line-prefix { width: 16px; flex-shrink: 0; }
.line-content { flex: 1; white-space: pre-wrap; word-break: break-all; }
.status-calling { border-left: 3px solid #409eff; }
.status-executing { border-left: 3px solid #e6a23c; }
.status-complete { border-left: 3px solid #67c23a; }
.status-error { border-left: 3px solid #f56c6c; }
</style>
```

### 5.4 事件处理逻辑（在 useClaudeStream composable 中）

```typescript
// 在 processToolResult 中处理 Edit 结果
function processEditResult(msg: SDKUserMessage, block: ContentBlock) {
  const result = msg.tool_use_result

  if (typeof result === 'string') {
    // 失败：错误信息字符串（如 "Error: String to replace not found in file.\nString: ..."）
    block.toolResult = result
    block.toolStatus = 'error'
  } else if (typeof result === 'object' && result !== null) {
    // 检查是否有 structuredPatch（Edit 成功标志）
    if ('structuredPatch' in result) {
      // 成功：EditToolOutput 对象
      block.toolResult = result as EditToolOutput
      block.toolStatus = 'complete'
    } else if ('type' in result && result.type === 'text') {
      // 可能是 Read 的结果（包含 file 内容），不处理
    }
  }
}
```

### 5.5 关键交互处理

Edit 工具**不需要用户交互**（与 AskUserQuestion 不同），但有以下特殊行为：

| 交互场景 | 处理方式 |
|----------|----------|
| 权限确认 | `bypassPermissions` 或 `canUseTool` 回调 |
| read-before-edit | 前端应识别 Read 工具调用，知道它是 Edit 的前置步骤 |
| Diff 渲染 | `structuredPatch` 可直接渲染为 unified diff 视图 |
| 失败提示 | 检测 `typeof tool_use_result === 'string'` 判断失败 |
| `replace_all` | UI 上显示"全部替换"标签 |

### 5.6 Read-before-edit 的事件序列处理

Edit 的 read-before-edit 要求导致事件流中有 **3 轮 API 调用**：

```
第 1 轮: text + Read → user(Read result)
第 2 轮: text + Edit → user(Edit result)
第 3 轮: text(最终回复) → result
```

前端需要：
1. 识别 Read 是 Edit 的前置步骤（同一文件的 Read → Edit 序列）
2. 将 Read 的结果缓存，在后续 Edit 中作为 `originalFile` 的参考
3. 在 UI 上可以选择将 Read + Edit 合并为一个"文件编辑"操作显示

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | stream_event | assistant | user | result | tool_progress | num_turns | 耗时 |
|------|------|--------|-------------|-----------|------|--------|--------------|-----------|------|
| 1 | 简单编辑（Read+Edit） | 141 | 109 | 3 | 2 | 1 | 0 | 3 | 16.4s |
| 2 | Edit 失败（不匹配） | 257 | 231 | 3 | 2 | 1 | 0 | 3 | 19.3s |
| 5 | SSE（Read+Edit） | 120 | 109 | 3 | 2 | 1 | 0 | 3 | 16.1s |
| 6 | SSE（关闭流式） | 8 | 0 | 3 | 2 | 1 | 0 | 3 | ~16s |

### 6.2 原始事件样本

#### content_block_start（Edit tool_use）

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 2,
    "content_block": {
      "type": "tool_use",
      "id": "call_761e68d95ce6480a9e9998b4",
      "name": "Edit",
      "input_schema": { ... }
    }
  }
}
```

#### assistant 完整 Edit tool_use block

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Now I'll replace \"Hello World\" with \"Hello Claude\":\n\n" },
      {
        "type": "tool_use",
        "id": "call_761e68d95ce6480a9e9998b4",
        "name": "Edit",
        "input": {
          "replace_all": false,
          "file_path": "C:/Users/.../test-edit.txt",
          "old_string": "Hello World",
          "new_string": "Hello Claude"
        }
      }
    ]
  }
}
```

#### user 消息（Edit 成功 tool_result）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_761e68d95ce6480a9e9998b4",
        "content": "The file .../test-edit.txt has been updated successfully. (file state is current in your context — no need to Read it back)"
      }
    ]
  },
  "tool_use_result": {
    "filePath": "C:/Users/.../test-edit.txt",
    "oldString": "Hello World",
    "newString": "Hello Claude",
    "originalFile": "Hello World\nThis is a test file\nGoodbye World\n",
    "structuredPatch": [
      {
        "oldStart": 1,
        "oldLines": 3,
        "newStart": 1,
        "newLines": 3,
        "lines": [
          "-Hello World",
          "+Hello Claude",
          " This is a test file",
          " Goodbye World"
        ]
      }
    ],
    "userModified": false,
    "replaceAll": false
  }
}
```

#### user 消息（Edit 失败 tool_result）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_b1bafbda58f14340805cbfde",
        "content": "<tool_use_error>String to replace not found in file.\nString: NONEXISTENT_STRING_XYZ</tool_use_error>"
      }
    ]
  },
  "tool_use_result": "Error: String to replace not found in file.\nString: NONEXISTENT_STRING_XYZ"
}
```

---

## 七、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| `replace_all: true` 模式 | 未测试 | 需要文件中有多个匹配项 |
| 多文件并行编辑 | 未测试 | 多个 Edit tool_use block 并行 |
| 大文件编辑的 `originalFile` | 未测试 | 可能截断或为 null |
| `userModified: true` 场景 | 未测试 | 需要 hook 修改 Edit input |
| Edit 不先 Read 的情况 | 未测试 | SDK 是否拒绝执行 |
| 行尾/编码差异 | 未测试 | CRLF vs LF、BOM 等 |
| `structuredPatch` 多个 hunks | 未测试 | 大范围修改可能产生多个 patch 块 |

---

## 八、与已有工具对比

| 维度 | Edit | Bash | Read | CronCreate |
|------|------|------|------|------------|
| 需要权限 | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| read-before-use | ✅ 必须 | ❌ | ❌ | ❌ |
| tool_result 结构 | 复杂（structuredPatch） | 复杂（stdout/stderr） | 简单（文件内容） | 简单（id/schedule） |
| 失败时 tool_use_result | **字符串** | **字符串** | N/A | **字符串** |
| 成功时 tool_use_result | 对象（含 diff） | 对象（含 output） | 对象（含 file） | 对象（含 id） |
| tool_progress | 0 | 可能（>2s） | 0 | 0 |
| 用户交互 | ❌ | ❌ | ❌ | ❌ |
| num_turns | **3** | **2** | **2** | **2** |
| input_json_delta 推送次数 | 6 | 4-5 | 3-4 | 3-4 |
| 执行延迟 | 瞬时 | 可变 | 瞬时 | 瞬时 |
| 前端渲染 | Diff 视图 | 终端风格 | 代码高亮 | 卡片 |

**Edit 的特殊性**：
1. **num_turns = 3**（比其他工具多 1 轮，因为需要先 Read）
2. **structuredPatch** 提供了可直接渲染为 diff 视图的数据
3. **read-before-edit** 要求使事件流更复杂
4. 成功时 `content` 是纯文本提示，真正的结构化数据在 `tool_use_result` 中

---

## 九、实际应用建议

1. **利用 `structuredPatch` 渲染 Diff 视图**：不要自己计算 diff，直接使用 SDK 提供的 unified diff 格式
2. **区分成功/失败的 `typeof` 检测**：`typeof tool_use_result === 'string'` 为失败，`typeof === 'object'` 为成功
3. **关联 Read + Edit 序列**：前端应识别对同一文件的 Read → Edit 操作链，在 UI 上合并展示
4. **`originalFile` 可用于"撤销"功能**：保存编辑前的完整文件内容
5. **注意 `replaceAll` 标志**：影响 Diff 视图中变更的展示方式
6. **处理 `<tool_use_error>` XML 标签**：失败时 content 可能被 XML 标签包裹，前端展示时应去除标签
