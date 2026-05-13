# NotebookEdit 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-notebookedit.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `notebook_path`(必填), `new_source`(必填), `cell_id?`, `cell_type?`("code"|"markdown"), `edit_mode?`("replace"|"insert"|"delete") |
| tool_result 结构（成功） | 结构化对象：`{new_source, cell_type, language, edit_mode, cell_id, error:""|"...", notebook_path, original_file, updated_file}` |
| tool_result 结构（失败） | **字符串**，以 `"Error: ..."` 开头 |
| stream_event 总数（case-1） | 194 个（含 3 轮 API 调用：Read → NotebookEdit → 文本回复） |
| input_json_delta 推送次数 | Read: 4 次；NotebookEdit: 6-8 次（视 new_source 长度而定） |
| tool_progress 推送次数 | **0 次**（瞬时工具） |
| 状态更新频率 | 无增量状态更新，tool_result 一次性返回完整结果 |
| num_turns | 3（Read + NotebookEdit + 文本回复） |
| read-before-edit | **需要**：LLM 先调用 Read 读取 notebook，再调用 NotebookEdit 编辑 |

---

## 一、tool_use 调用格式

### input_schema（来自 SDK sdk-tools.d.ts）

```typescript
export interface NotebookEditInput {
  /** Jupyter notebook 文件的绝对路径（必填） */
  notebook_path: string;
  /** 要编辑的单元格 ID。insert 模式下，新单元格插入到该 ID 之后 */
  cell_id?: string;
  /** 单元格的新源代码（必填） */
  new_source: string;
  /** 单元格类型：code 或 markdown。insert 模式下必填 */
  cell_type?: "code" | "markdown";
  /** 编辑模式：replace（默认）、insert、delete */
  edit_mode?: "replace" | "insert" | "delete";
}
```

### 实际 input 示例

#### replace 模式（case-1）

```json
{
  "notebook_path": "C:/Users/.../test-notebook.ipynb",
  "cell_id": "abc123",
  "new_source": "print('Hello Claude')",
  "cell_type": "code"
}
```

注意：`edit_mode` 未传递（默认 `"replace"`）。

#### insert 模式（case-2）

```json
{
  "notebook_path": "C:/Users/.../test-insert.ipynb",
  "cell_id": "first-cell",
  "new_source": "# Section 2\nThis is the second section.",
  "cell_type": "markdown",
  "edit_mode": "insert"
}
```

#### delete 模式（case-3）

```json
{
  "notebook_path": "C:/Users/.../test-delete.ipynb",
  "cell_id": "delete-cell",
  "new_source": "",
  "edit_mode": "delete"
}
```

注意：delete 模式下 `new_source` 为空字符串，`cell_type` 可选。

---

## 二、tool_result 返回值格式

### 成功 — 结构化对象（NotebookEditOutput）

```json
{
  "new_source": "print('Hello Claude')",
  "cell_type": "code",
  "language": "python",
  "edit_mode": "replace",
  "cell_id": "abc123",
  "error": "",
  "notebook_path": "C:\\Users\\...\\test-notebook.ipynb",
  "original_file": "{\n  \"cells\": [\n    ...完整 notebook JSON...\n  ]\n}",
  "updated_file": "{\n \"cells\": [\n  ...修改后的 notebook JSON...\n ]\n}"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `new_source` | `string` | 写入单元格的新源代码 |
| `cell_type` | `"code" \| "markdown"` | 单元格类型 |
| `language` | `string` | notebook 的编程语言（如 `"python"`） |
| `edit_mode` | `string` | 使用的编辑模式 |
| `cell_id` | `string` | 被编辑的单元格 ID |
| `error` | `string` | 错误信息，成功时为空字符串 `""` |
| `notebook_path` | `string` | notebook 文件路径（Windows 反斜杠） |
| `original_file` | `string` | 修改前的完整 notebook JSON 字符串 |
| `updated_file` | `string` | 修改后的完整 notebook JSON 字符串 |

### insert 模式的 tool_result

insert 模式下 `cell_id` 是**新生成的 ID**（由 SDK 自动分配），不是输入中的 `cell_id`：

```json
{
  "cell_id": "a3c06b49",       // ← 新生成的 ID
  "cell_type": "markdown",
  "edit_mode": "insert",
  "new_source": "# Section 2\nThis is the second section.",
  "language": "python",
  "error": "",
  "notebook_path": "...",
  "original_file": "...",
  "updated_file": "..."
}
```

### delete 模式的 tool_result

delete 模式下 `new_source` 为空字符串：

```json
{
  "cell_id": "delete-cell",
  "cell_type": "code",
  "edit_mode": "delete",
  "new_source": "",
  "language": "python",
  "error": "",
  "notebook_path": "...",
  "original_file": "...",
  "updated_file": "..."
}
```

### 失败 — 错误字符串

```json
{
  "type": "tool_use_result",
  "tool_use_result": "Error: Cell with ID \"NONEXISTENT_CELL_XYZ\" not found in notebook."
}
```

失败时 `tool_use_result` 是**字符串**（非对象），以 `"Error: "` 开头。这与 Edit 工具的失败模式一致。

`messageContentTypes` 中 `contentType` 为 `"string"`，内容被 `<tool_use_error>` 标签包裹：

```json
{
  "type": "tool_result",
  "tool_use_id": "call_xxx",
  "contentType": "string",
  "contentSnippet": "<tool_use_error>Cell with ID \"NONEXISTENT_CELL_XYZ\" not found in notebook.</tool_use_error>"
}
```

---

## 三、流式事件序列

### 完整时间线（case-1 replace 模式，194 个事件）

```
[  0] system (init)                    ← 会话初始化
[  1] system (status)                  ← 状态更新

── 第 1 轮 API 调用：Read notebook ──
[  2] stream_event → message_start
[  3] stream_event → content_block_start
[ 4-32] stream_event → content_block_delta (text_delta × 29)   ← "I'll read the notebook..."
[ 33] assistant [text: "I'll read the notebook file..."]
[ 34] stream_event → content_block_stop
[ 35] stream_event → content_block_start [Read]              ← Read 工具开始
[ 36-39] stream_event → content_block_delta (input_json_delta × 4) ← Read input 构建
[ 40] assistant [tool_use: Read]                              ← Read 完整 input
[ 41] stream_event → content_block_stop
[ 42] stream_event → message_delta
[ 43] stream_event → message_stop

[ 44] user (tool_result)                ← Read 返回 notebook 内容
       tool_use_result: {type: "notebook", file: {filePath, cells: [...]}}

[ 45] system (status)                  ← 第 2 轮开始前状态更新

── 第 2 轮 API 调用：NotebookEdit ──
[ 46] stream_event → message_start
[ 47] stream_event → content_block_start
[ 48-76] stream_event → content_block_delta (text_delta × 29)  ← "Now I'll use NotebookEdit..."
[ 77] assistant [text: "Now I'll use the NotebookEdit tool..."]
[ 78] stream_event → content_block_stop
[ 79] stream_event → content_block_start [NotebookEdit]        ← NotebookEdit 工具开始
[ 80-86] stream_event → content_block_delta (input_json_delta × 7)  ← NotebookEdit input 构建
[ 87] assistant [tool_use: NotebookEdit]                       ← NotebookEdit 完整 input
[ 88] stream_event → content_block_stop
[ 89] stream_event → message_delta
[ 90] stream_event → message_stop

[ 91] user (tool_result)                ← NotebookEdit 返回结果
       tool_use_result: {new_source, cell_type, language, edit_mode, cell_id, error:"", notebook_path, original_file, updated_file}

[ 92] system (status)

── 第 3 轮 API 调用：文本回复 ──
[ 93] stream_event → message_start
[ 94] stream_event → content_block_start
[ 95-188] stream_event → content_block_delta (text_delta × 94) ← 最终回复
[189] assistant [text: "## Summary\nI successfully modified..."]
[190] stream_event → content_block_stop
[191] stream_event → message_delta
[192] stream_event → message_stop

[193] result (success, num_turns: 3)
```

### 各阶段事件数量统计

| 阶段 | 事件类型 | 数量 |
|------|---------|------|
| 初始化 | system (init + status) | 2 |
| 第 1 轮：Read | stream_event | ~42 |
| Read tool_result | user | 1 |
| 第 2 轮：NotebookEdit | stream_event | ~47 |
| NotebookEdit tool_result | user | 1 |
| 第 3 轮：文本回复 | stream_event | ~100 |
| 结果 | result | 1 |
| **总计** | | **~194** |

---

## 四、状态更新机制

### tool_progress 推送分析

**NotebookEdit 工具零 tool_progress 推送。**

与 Edit、CronCreate、CronDelete 等工具一致，NotebookEdit 是瞬时操作工具：
- 执行时间极短（毫秒级）
- 不涉及外部进程或长时间运行
- SDK 不推送 `tool_progress` 消息

### SDK 推送频率统计

| 消息类型 | 推送频率 | 说明 |
|---------|---------|------|
| `stream_event` (text_delta) | 每 ~25ms | 文本增量，与纯文本场景一致 |
| `stream_event` (input_json_delta) | 每次参数字段变更 | NotebookEdit 约 6-8 次 |
| `assistant` | 每个 content block 结束 | 完整消息，用于校验 |
| `user` | 工具执行完毕 | 一次性返回完整结果 |
| `tool_progress` | **0 次** | 瞬时工具无进度更新 |
| `system` (status) | API 轮次切换时 | 2-3 次 |

### 是否需要不断修改前端状态？

**不需要**。NotebookEdit 工具的特点：
1. **tool_result 一次性返回**：不像 Bash 工具有持续的 stdout 增量输出
2. **零 tool_progress**：不需要更新进度条或计时器
3. **input_json_delta 有限**：6-8 次，拼接到完整 JSON 后即完成

前端需要处理的状态更新仅限于：
- `input_json_delta` 拼接（6-8 次，开销极小）
- `assistant` 消息到达时更新 block 状态
- `user` 消息到达时更新 tool_result（一次性）

---

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
/** NotebookEdit 工具的 input 参数 */
interface NotebookEditInput {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

/** NotebookEdit 工具成功时的 tool_result */
interface NotebookEditSuccessResult {
  new_source: string;
  cell_type: 'code' | 'markdown';
  language: string;
  edit_mode: 'replace' | 'insert' | 'delete';
  cell_id: string;
  error: string;               // 成功时为 ""
  notebook_path: string;
  original_file: string;       // 修改前的完整 notebook JSON
  updated_file: string;        // 修改后的完整 notebook JSON
}

/** NotebookEdit 工具失败时的 tool_result */
type NotebookEditErrorResult = string;  // "Error: Cell with ID ... not found"

/** 工具调用的渲染状态 */
interface NotebookEditBlock {
  type: 'tool_use'
  toolName: 'NotebookEdit'
  toolUseId: string
  toolInput: NotebookEditInput | {}     // 流式拼接中可能不完整
  toolStatus: 'calling' | 'running' | 'complete' | 'error'
  toolResult?: NotebookEditSuccessResult | NotebookEditErrorResult
  inputJsonBuffer: string               // input_json_delta 拼接缓冲
}
```

### 组件模板

```vue
<template>
  <el-card class="notebook-edit-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">
          <el-icon v-if="status === 'calling' || status === 'running'" class="is-loading">
            <Loading />
          </el-icon>
          📓 NotebookEdit
        </el-tag>
        <el-tag v-if="editMode" type="info" size="small">{{ editModeLabel }}</el-tag>
        <el-tag v-if="status === 'complete'" type="success" size="small">完成</el-tag>
        <el-tag v-else-if="status === 'error'" type="danger" size="small">失败</el-tag>
      </div>
    </template>

    <!-- 工具参数展示 -->
    <el-descriptions v-if="hasInput" :column="1" border size="small">
      <el-descriptions-item label="Notebook">
        <el-text size="small" truncated>{{ toolInput.notebook_path }}</el-text>
      </el-descriptions-item>
      <el-descriptions-item v-if="toolInput.cell_id" label="Cell ID">
        <el-tag size="small">{{ toolInput.cell_id }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item v-if="toolInput.edit_mode" label="模式">
        <el-tag size="small" :type="editModeTagType">{{ editModeLabel }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item v-if="toolInput.cell_type" label="类型">
        <el-tag size="small">{{ toolInput.cell_type }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item v-if="toolInput.new_source" label="新内容">
        <div class="code-preview">
          <code>{{ toolInput.new_source }}</code>
        </div>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 工具结果（成功） -->
    <template v-if="isSuccessResult">
      <el-divider />
      <div class="result-section">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="Cell ID">
            <el-tag size="small">{{ toolResult.cell_id }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="Language">
            {{ toolResult.language }}
          </el-descriptions-item>
          <el-descriptions-item label="Mode">
            {{ toolResult.edit_mode }}
          </el-descriptions-item>
          <el-descriptions-item label="Type">
            {{ toolResult.cell_type }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- Diff 视图 -->
        <NotebookDiff
          v-if="toolResult.original_file && toolResult.updated_file"
          :original="toolResult.original_file"
          :updated="toolResult.updated_file"
        />
      </div>
    </template>

    <!-- 工具结果（失败） -->
    <template v-if="isErrorResult">
      <el-divider />
      <el-alert type="error" :closable="false" show-icon>
        <template #title>编辑失败</template>
        {{ toolResult }}
      </el-alert>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  toolInput: NotebookEditInput | {}
  toolResult?: NotebookEditSuccessResult | NotebookEditErrorResult
  status: 'calling' | 'running' | 'complete' | 'error'
}>()

const hasInput = computed(() => 'notebook_path' in props.toolInput)

const editMode = computed(() =>
  (props.toolInput as NotebookEditInput)?.edit_mode || 'replace'
)

const editModeLabel = computed(() => {
  const mode = editMode.value
  const labels: Record<string, string> = {
    replace: '替换',
    insert: '插入',
    delete: '删除',
  }
  return labels[mode] || mode
})

const editModeTagType = computed(() => {
  const mode = editMode.value
  const types: Record<string, string> = {
    replace: '',
    insert: 'success',
    delete: 'warning',
  }
  return types[mode] || 'info'
})

const statusTagType = computed(() => {
  switch (props.status) {
    case 'calling': case 'running': return 'warning'
    case 'complete': return 'success'
    case 'error': return 'danger'
    default: return 'info'
  }
})

const isSuccessResult = computed(() =>
  props.status === 'complete' &&
  typeof props.toolResult === 'object' &&
  props.toolResult !== null &&
  'notebook_path' in (props.toolResult as NotebookEditSuccessResult)
)

const isErrorResult = computed(() =>
  props.status === 'error' ||
  (typeof props.toolResult === 'string')
)
</script>
```

### NotebookDiff 组件（对比 original_file 和 updated_file）

```vue
<template>
  <div class="notebook-diff">
    <el-collapse>
      <el-collapse-item>
        <template #title>
          📊 Notebook 变更对比
        </template>
        <!-- 将 notebook JSON 解析为 cells，逐 cell 对比 -->
        <div v-for="(diff, idx) in cellDiffs" :key="idx" class="cell-diff">
          <div class="cell-header">
            <el-tag size="small">{{ diff.cellType }}</el-tag>
            <el-tag size="small" type="info">cell: {{ diff.cellId }}</el-tag>
            <el-tag v-if="diff.isNew" size="small" type="success">新增</el-tag>
            <el-tag v-else-if="diff.isDeleted" size="small" type="danger">已删除</el-tag>
            <el-tag v-else-if="diff.isChanged" size="small" type="warning">已修改</el-tag>
            <el-tag v-else size="small" type="info">未变更</el-tag>
          </div>
          <div v-if="diff.isChanged" class="diff-content">
            <div class="diff-line removed">- {{ diff.oldSource }}</div>
            <div class="diff-line added">+ {{ diff.newSource }}</div>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>
```

### 关键交互处理

NotebookEdit 工具**无需用户交互**（与 AskUserQuestion 不同）。权限通过 `bypassPermissions` 或 `acceptEdits` 模式自动批准。

前端处理流程：
1. `content_block_start(tool_use, name="NotebookEdit")` → 创建 NotebookEditBlock，显示 loading
2. `input_json_delta × 6-8` → 拼接到 `inputJsonBuffer`，尝试 JSON.parse 更新 `toolInput`
3. `assistant(tool_use)` → 确认完整 input
4. `user(tool_result)` → 解析结果：
   - 如果是 **对象** 且 `error === ""` → 成功，渲染 Diff 视图
   - 如果是 **字符串** → 失败，渲染错误 Alert

---

## 六、实验数据

### 实验矩阵

| Case | 场景 | 总事件 | stream_event | assistant | user | result | num_turns | input_json_delta |
|------|------|--------|-------------|-----------|------|--------|-----------|------------------|
| 1 | replace 模式 | ~194 | ~188 | 5 | 2 | 1 | 3 | Read: 4, NB: 7 |
| 2 | insert 模式 | ~170 | ~164 | ~5 | 2 | 1 | 3 | Read: 4, NB: ~6 |
| 3 | delete 模式 | ~250 | ~244 | ~7 | 3 | 1 | 4 | Read: 4, NB: ~5（含失败重试） |
| 4 | cell_id 不存在 | ~210 | ~204 | ~6 | 2-3 | 1 | 3-4 | NB: ~5（失败） |
| 5 | 纯文本基线 | ~10 | ~5 | 2 | 0 | 1 | 1 | 0 |
| 6 | SSE 前端视角 | ~223 | ~212 | 5 | 2 | 1 | 3 | Read: 4, NB: 8 |

### 关键事件样本

#### content_block_start(NotebookEdit)

```json
{
  "type": "content_block_start",
  "index": 2,
  "content_block": {
    "type": "tool_use",
    "id": "call_bf2be6307e314e55b1477162",
    "name": "NotebookEdit",
    "input": {}
  }
}
```

#### input_json_delta 序列（NotebookEdit replace）

```
[80] input_json_delta += ""           ← 空 JSON 开始
[81] input_json_delta += "{"          ← JSON 开括号
[82] input_json_delta += "\"notebook_path\": \"C:/...test-notebook.ipynb\""
[83] input_json_delta += ", \"cell_id\": \"abc123\""
[84] input_json_delta += ", \"new_source\": \"print('Hello Claude')\""
[85] input_json_delta += ", \"cell_type\": \"code\""
[86] input_json_delta += "}"          ← JSON 闭括号
```

完整拼接结果：
```json
{
  "notebook_path": "C:/Users/.../test-notebook.ipynb",
  "cell_id": "abc123",
  "new_source": "print('Hello Claude')",
  "cell_type": "code"
}
```

#### tool_result（成功 — NotebookEditOutput）

```json
{
  "new_source": "print('Hello Claude')",
  "cell_type": "code",
  "language": "python",
  "edit_mode": "replace",
  "cell_id": "abc123",
  "error": "",
  "notebook_path": "C:\\Users\\...\\test-notebook.ipynb",
  "original_file": "{\n  \"cells\": [...]\n}",
  "updated_file": "{\n \"cells\": [...]\n}"
}
```

#### tool_result（失败 — 错误字符串）

```
"Error: Cell with ID \"NONEXISTENT_CELL_XYZ\" not found in notebook."
```

---

## 七、Read 工具对 Notebook 的返回格式

NotebookEdit 调用前需要先 Read notebook。Read 工具对 `.ipynb` 文件返回**结构化 notebook 数据**：

```json
{
  "type": "notebook",
  "file": {
    "filePath": "C:/Users/.../test-notebook.ipynb",
    "cells": [
      {
        "cellType": "code",
        "source": "print(\"Hello World\")",
        "cell_id": "abc123",
        "language": "python"
      },
      {
        "cellType": "markdown",
        "source": "# Title\nDescription",
        "cell_id": "def456"
      }
    ]
  }
}
```

注意：
- `type` 为 `"notebook"`（不是 `"text"` 或 `"image"`）
- `cells` 是扁平数组，每个 cell 包含 `cellType`、`source`、`cell_id`
- `language` 仅在 `code` 类型 cell 中出现

---

## 八、与 Edit 工具的行为对比

| 维度 | Edit | NotebookEdit |
|------|------|-------------|
| 需要权限 | Yes (`acceptEdits` 等) | Yes（同 Edit 路径格式） |
| read-before-edit | 必须 | 必须（LLM 先 Read 再 NotebookEdit） |
| input 字段数 | 4 (`file_path`, `old_string`, `new_string`, `replace_all?`) | 5 (`notebook_path`, `cell_id?`, `new_source`, `cell_type?`, `edit_mode?`) |
| 成功 tool_result | `{filePath, structuredPatch, userModified, originalFile}` | `{new_source, cell_type, language, edit_mode, cell_id, error, notebook_path, original_file, updated_file}` |
| 失败 tool_result | 字符串 | 字符串 |
| tool_progress | 0 | 0 |
| input_json_delta 次数 | ~6 | ~6-8 |
| 操作粒度 | 文件内字符串替换 | 单元格级别 |
| diff 表示 | `structuredPatch`（unified diff 数组） | `original_file` + `updated_file`（完整 notebook JSON） |

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 非文件路径的 notebook_path | 未测试 | 相对路径是否自动补全 |
| 无 cell_id 的 insert 模式 | 未测试 | 文档说插入到开头 |
| 多单元格同时编辑 | 未测试 | LLM 可能连续调用多次 NotebookEdit |
| 大型 notebook 性能 | 未测试 | `original_file`/`updated_file` 可能非常大 |
| 非法 JSON 的 new_source | 未测试 | 多行代码的转义行为 |
| 权限拒绝场景 | 未测试 | `permissionMode: 'default'` 下的行为 |
| Notebook 不存在的错误 | 未测试 | 文件路径不存在时的错误格式 |
| notebook_path 路径分隔符 | 已观察 | input 中使用 `/`，tool_result 中使用 `\\`（Windows） |
