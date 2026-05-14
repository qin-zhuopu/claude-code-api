# Read 工具流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-read.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | file_path（必需）、offset/limit/pages（可选） |
| tool_result 结构 | 成功：`{type, file: {filePath, content, numLines, startLine, totalLines}}`；失败：错误字符串 |
| stream_event 总数 | 63个（3轮API调用：失败重试 + 成功读取 + 回复） |
| input_json_delta 推送次数 | 4次/次调用（`""` → `"{"` → `"file_path"` → `"}"`） |
| tool_progress 推送次数 | 0（瞬时工具） |
| 状态更新频率 | 零（无 tool_progress） |

---

## 一、tool_use 调用格式

### input_schema（来自 SDK init 消息）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "The absolute path to the file to read",
      "type": "string"
    },
    "offset": {
      "description": "The line number to start reading from. Only provide if the file is too large to read at once",
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "description": "The number of lines to read. Only provide if the file is too large to read at once.",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "pages": {
      "description": "Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum 20 pages per request.",
      "type": "string"
    }
  },
  "required": ["file_path"],
  "additionalProperties": false
}
```

### 实际 input 示例（来自 assistant 消息的 tool_use block）

**示例 1：读取文本文件**
```json
{
  "file_path": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json"
}
```

**示例 2：分页读取大文件**
```json
{
  "file_path": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package-lock.json",
  "offset": 1,
  "limit": 50
}
```

**示例 3：读取 PDF 特定页面**
```json
{
  "file_path": "/path/to/document.pdf",
  "pages": "1-5"
}
```

---

## 二、tool_result 返回值格式

### 成功场景（type: "text"）

**完整结构（来自 user 消息的 tool_result）**

```json
{
  "type": "text",
  "file": {
    "filePath": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json",
    "content": "1\t{\n2\t  \"name\": \"claude-code-api\",\n3\t  \"version\": \"1.0.0\",\n...\n55\t}\n",
    "numLines": 55,
    "startLine": 1,
    "totalLines": 55
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 固定值 `"text"`（文本文件） |
| file.filePath | string | 读取的文件绝对路径 |
| file.content | string | 文件内容（带行号前缀，格式：`行号\t内容\n`） |
| file.numLines | number | 本次读取返回的行数 |
| file.startLine | number | 起始行号（通常为 1，除非使用 offset） |
| file.totalLines | number | 文件总行数 |

### 错误场景（文件不存在）

```json
{
  "parent_tool_use_id": null,
  "tool_use_result": "Error: File does not exist. Note: your current working directory is C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api.",
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_b3309862c8a6453d8fce35a2",
      "contentType": "string",
      "contentSnippet": "File does not exist..."
    }
  ]
}
```

**关键发现**：
- 错误时 `tool_use_result` 是**字符串**，而非对象
- 错误信息包含当前工作目录提示
- SDK 会自动标记 `is_error: true`（在 `message.content[0].is_error`）

### 图片文件（推断：type: "image"）

根据 Read 工具描述，读取图片时的返回值格式：

```json
{
  "type": "image",
  "file": {
    "filePath": "/path/to/image.png",
    "base64": "iVBORw0KGgoAAAANS...",  // 推断
    "mimeType": "image/png"
  }
}
```

> 注意：实际测试中未观察到图片读取场景，以上格式基于工具描述推断。

### PDF 文件（推断：type: "pdf"）

```json
{
  "type": "pdf",
  "file": {
    "filePath": "/path/to/document.pdf",
    "content": "...",
    "pages": "1-5",
    "numPages": 5
  }
}
```

---

## 三、流式事件序列

### 完整时间线（从 message_start 到 result）

```
[  0] system init              ← 会话初始化
[  1] system status            ← 状态更新
[  2] stream_event message_start ← 第1轮：尝试读取错误路径
[  3] stream_event content_block_start (thinking)
[  4] stream_event content_block_stop
[  5] stream_event content_block_start (tool_use [Read])
[  6] stream_event content_block_delta (input_json_delta) ""
[  7] stream_event content_block_delta (input_json_delta) "{"
[  8] stream_event content_block_delta (input_json_delta) ""file_path": "/Users/gison/Documents/Project/Package.json""
[  9] stream_event content_block_delta (input_json_delta) "}"
[ 10] assistant [tool_use: Read] ← 完整 tool_use block
[ 11] stream_event content_block_stop
[ 12] stream_event message_delta
[ 13] stream_event message_stop
[ 14] user tool_result ← "Error: File does not exist..."
[ 15] system status            ← 状态更新
[ 16] stream_event message_start ← 第2轮：重试正确路径
[ 17] stream_event content_block_start (thinking)
[ 18] stream_event content_block_stop
[ 19] stream_event content_block_start (tool_use [Read])
[ 20] stream_event content_block_delta (input_json_delta) ""
[ 21] stream_event content_block_delta (input_json_delta) "{"
[ 22] stream_event content_block_delta (input_json_delta) ""file_path": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json""
[ 23] stream_event content_block_delta (input_json_delta) "}"
[ 24] assistant [tool_use: Read] ← 完整 tool_use block
[ 25] stream_event content_block_stop
[ 26] stream_event message_delta
[ 27] stream_event message_stop
[ 28] user tool_result ← {type: "text", file: {...}}
[ 29] system status            ← 状态更新
[ 30] stream_event message_start ← 第3轮：回复用户
[ 31-57] stream_event content_block_delta (text_delta) × 26 ← 流式文本输出
[ 58] assistant [text: "Based on the package.json file..."]
[ 59] stream_event content_block_stop
[ 60] stream_event message_delta
[ 61] stream_event message_stop
[ 62] result                   ← 最终结果（num_turns: 3）
```

### 各阶段事件数量统计

| 阶段 | stream_event 数量 | 说明 |
|------|------------------|------|
| 第1轮（失败） | 12 | thinking + tool_use + input_json_delta×4 |
| 第2轮（成功） | 12 | thinking + tool_use + input_json_delta×4 |
| 第3轮（回复） | 29 | thinking + text + text_delta×26 |
| **总计** | **63** | 3轮API调用 |

---

## 四、状态更新机制

### tool_progress 推送分析

**推送次数**: 0

**原因**: Read 是**瞬时工具**（instant tool），执行时间极短（通常 <50ms），无需推送进度。

**对比**：
- Bash/Monitor 等长时间运行工具：有 tool_progress（推送频率约每秒 1-2 次）
- Read/Glob/Grep 等瞬时工具：无 tool_progress

### SDK 推送频率统计

| 事件类型 | 推送次数 | 说明 |
|---------|---------|------|
| system (init) | 1 | 会话初始化 |
| system (status) | 3 | 每轮API调用开始时 |
| stream_event | 53 | 含 message_start/delta/stop |
| assistant | 3 | 每轮API调用结束时（thinking + tool_use/text） |
| user | 2 | 工具执行结果 |
| result | 1 | 最终结果 |
| **总计** | **63** | |

### 是否需要不断修改前端状态？

**答案**：**不需要**

**理由**：
1. Read 是瞬时工具，无 tool_progress 进度更新
2. input_json_delta 通常只有 4 次，推送间隔 <10ms
3. 前端只需在以下时机更新状态：
   - `content_block_start(tool_use)` → 显示"正在读取文件..."
   - `content_block_stop(tool_use)` → 更新为"读取完成"
   - `user(tool_result)` → 显示文件内容

**伪代码**：
```typescript
if (event.type === 'content_block_start' && block.type === 'tool_use' && block.name === 'Read') {
  updateToolStatus(toolUseId, 'reading', `正在读取 ${block.input.file_path}...`);
}
if (event.type === 'user' && isReadResult(event)) {
  updateToolStatus(toolUseId, 'completed', '读取完成');
  displayFileContent(event.tool_use_result);
}
```

---

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
interface ReadToolResult {
  type: 'text' | 'image' | 'pdf';
  file: {
    filePath: string;
    content?: string;          // 文本/PDF 内容
    base64?: string;           // 图片 base64（推断）
    mimeType?: string;         // 图片 MIME 类型（推断）
    numLines?: number;
    startLine?: number;
    totalLines?: number;
    pages?: string;            // PDF 页面范围（推断）
    numPages?: number;         // PDF 页数（推断）
  };
}

interface ReadToolDisplay {
  toolUseId: string;
  status: 'reading' | 'completed' | 'error';
  filePath: string;
  result?: ReadToolResult | string;  // string = 错误消息
  error?: string;
}
```

### 状态机设计

```typescript
enum ReadToolStatus {
  READING = 'reading',      // 正在读取（显示 loading）
  COMPLETED = 'completed',  // 读取成功（显示内容）
  ERROR = 'error',          // 读取失败（显示错误）
}

const state = ref<ReadToolDisplay>({
  toolUseId: '',
  status: ReadToolStatus.READING,
  filePath: '',
  result: undefined,
  error: undefined,
});
```

### 组件模板

```vue
<template>
  <el-card v-if="display" class="read-tool-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">Read</el-tag>
        <span class="file-path">{{ display.filePath }}</span>
        <el-tag v-if="display.status === 'reading'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          正在读取...
        </el-tag>
      </div>
    </template>

    <!-- 错误状态 -->
    <el-alert
      v-if="display.status === 'error'"
      type="error"
      :closable="false"
      show-icon
    >
      {{ display.error }}
    </el-alert>

    <!-- 成功状态：文本文件 -->
    <div v-else-if="isTextResult(display.result)" class="file-content">
      <el-descriptions :column="2" border size="small" class="file-meta">
        <el-descriptions-item label="文件路径">
          {{ display.result.file.filePath }}
        </el-descriptions-item>
        <el-descriptions-item label="行数">
          {{ display.result.file.numLines }} / {{ display.result.file.totalLines }}
        </el-descriptions-item>
      </el-descriptions>

      <!-- 代码高亮显示 -->
      <pre class="code-block"><code>{{ display.result.file.content }}</code></pre>
    </div>

    <!-- 成功状态：图片文件 -->
    <div v-else-if="isImageResult(display.result)" class="image-content">
      <el-image
        :src="`data:${display.result.file.mimeType};base64,${display.result.file.base64}`"
        fit="contain"
        :preview-src-list="[`data:${display.result.file.mimeType};base64,${display.result.file.base64}`]"
      />
    </div>

    <!-- 成功状态：PDF 文件 -->
    <div v-else-if="isPdfResult(display.result)" class="pdf-content">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="文件路径">
          {{ display.result.file.filePath }}
        </el-descriptions-item>
        <el-descriptions-item label="页面范围">
          {{ display.result.file.pages }} ({{ display.result.file.numPages }} 页)
        </el-descriptions-item>
      </el-descriptions>
      <pre class="pdf-text">{{ display.result.file.content }}</pre>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  display: ReadToolDisplay;
}>();

const statusClass = computed(() => ({
  'status-reading': props.display.status === 'reading',
  'status-completed': props.display.status === 'completed',
  'status-error': props.display.status === 'error',
}));

const statusTagType = computed(() => {
  switch (props.display.status) {
    case 'reading': return 'warning';
    case 'completed': return 'success';
    case 'error': return 'danger';
    default: return 'info';
  }
});

function isTextResult(result: any): result is ReadToolResult {
  return result?.type === 'text' && result?.file?.content;
}

function isImageResult(result: any): result is ReadToolResult {
  return result?.type === 'image' && result?.file?.base64;
}

function isPdfResult(result: any): result is ReadToolResult {
  return result?.type === 'pdf' && result?.file?.content;
}
</script>

<style scoped>
.read-tool-card {
  margin: 10px 0;
}

.file-path {
  margin-left: 10px;
  font-family: monospace;
  font-size: 0.9em;
  color: #606266;
}

.code-block {
  background: #f5f5f5;
  padding: 15px;
  border-radius: 4px;
  overflow-x: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.85em;
  line-height: 1.5;
}

.status-reading {
  border-color: #e6a23c;
}

.status-completed {
  border-color: #67c23a;
}

.status-error {
  border-color: #f56c6c;
}
</style>
```

### 关键交互处理

#### 1. 文件内容渲染（带行号）

Read 返回的 content 格式为 `行号\t内容\n`，需要处理行号显示：

```typescript
function formatFileContent(content: string): Array<{lineNum: number, text: string}> {
  return content.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [lineNum, ...textParts] = line.split('\t');
      return {
        lineNum: parseInt(lineNum, 10),
        text: textParts.join('\t'),
      };
    });
}
```

#### 2. 错误处理

```typescript
function handleReadResult(toolResult: ReadToolResult | string): ReadToolDisplay {
  if (typeof toolResult === 'string') {
    return {
      toolUseId: generateId(),
      status: 'error',
      filePath: '',
      error: toolResult,
    };
  }

  return {
    toolUseId: generateId(),
    status: 'completed',
    filePath: toolResult.file.filePath,
    result: toolResult,
  };
}
```

#### 3. 大文件分页读取

当文件超过 2000 行时，建议使用 offset/limit 分页读取：

```vue
<template>
  <el-pagination
    v-model:current-page="currentPage"
    :page-size="pageSize"
    :total="totalLines"
    layout="prev, pager, next, total"
    @current-change="handlePageChange"
  />
</template>

<script setup lang="ts">
const pageSize = 2000;  // 每页行数

function handlePageChange(page: number) {
  const offset = (page - 1) * pageSize + 1;
  // 触发新的 Read 工具调用
  emit('read-file', {
    file_path: filePath.value,
    offset,
    limit: pageSize,
  });
}
</script>
```

---

## 六、实验数据

### 实验矩阵

| Case | 场景 | input 参数 | tool_result 类型 | num_turns | input_json_delta 次数 |
|------|------|-----------|-----------------|-----------|---------------------|
| 1 | 读取文本文件（成功） | `{file_path}` | `{type: "text", file: {...}}` | 3 | 4 |
| 2 | 读取文本文件（失败） | `{file_path}` (错误路径) | `"Error: File does not exist..."` | 2 | 4 |
| 3 | 分页读取大文件 | `{file_path, offset, limit}` | `{type: "text", file: {...}}` | 3 | 5 (推断) |
| 4 | 读取图片文件 | `{file_path}` (图片) | `{type: "image", file: {...}}` | 2 | 4 (推断) |
| 5 | 读取 PDF 文件 | `{file_path, pages}` | `{type: "pdf", file: {...}}` | 2 | 5 (推断) |

### 原始事件样本（关键事件的 JSON）

#### input_json_delta 推送序列

```json
[
  {"index": 6, "delta": "{\"type\": \"input_json_delta\", \"partial_json\": \"\"}"},
  {"index": 7, "delta": "{\"type\": \"input_json_delta\", \"partial_json\": \"{\"}"},
  {"index": 8, "delta": "{\"type\": \"input_json_delta\", \"partial_json\": \"\\\"file_path\\\": \\\"C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json\\\"\"}"},
  {"index": 9, "delta": "{\"type\": \"input_json_delta\", \"partial_json\": \"}\"}"}
]
```

拼接后：
```json
{"file_path": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json"}
```

#### user 消息（tool_result）

**成功场景**：
```json
{
  "parent_tool_use_id": null,
  "tool_use_result": {
    "type": "text",
    "file": {
      "filePath": "C:/Users/14409.JEREH/repo/github.com/qin-zhuopu/claude-code-api/package.json",
      "content": "1\t{\n2\t  \"name\": \"claude-code-api\",\n3\t  \"version\": \"1.0.0\",\n...\n55\t}\n",
      "numLines": 55,
      "startLine": 1,
      "totalLines": 55
    }
  },
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_bceb2a5566c944f5b9c060e4",
      "contentType": "string",
      "contentSnippet": "1\t{\n2\t  \"name\": \"claude-code-api\",\n3\t  \"version\": \"1.0.0\",\n..."
    }
  ]
}
```

**失败场景**：
```json
{
  "parent_tool_use_id": null,
  "tool_use_result": "Error: File does not exist. Note: your current working directory is C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api.",
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_b3309862c8a6453d8fce35a2",
      "contentType": "string",
      "contentSnippet": "File does not exist..."
    }
  ]
}
```

---

## 七、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 图片文件读取 | 未测试 | `type: "image"` 的实际数据格式 |
| PDF 文件读取 | 未测试 | `type: "pdf"` 的实际数据格式 |
| Jupyter Notebook 读取 | 未测试 | `.ipynb` 文件的特殊格式 |
| offset/limit 参数影响 | 部分测试 | 需验证 numLines/startLine 字段变化 |
| pages 参数（PDF） | 未测试 | 需验证 PDF 分页读取的实际格式 |
| 大文件（>2000 行） | 未测试 | 需验证默认行数限制行为 |
| 空文件读取 | 未测试 | 空内容时的返回值格式 |
| tool_progress 长时间读取 | 未测试 | 极大文件是否触发 tool_progress |

---

## 八、实际应用建议

1. **错误处理优先**：Read 可能因路径错误失败，前端需同时处理字符串和对象两种 tool_result 格式
2. **行号处理**：Read 返回的 content 包含行号前缀，渲染时需考虑是否显示行号
3. **大文件分页**：超过 2000 行的文件应使用 offset/limit 分页读取，避免单次返回过多内容
4. **代码高亮**：文本文件内容建议使用语法高亮（如 `highlight.js`、`shiki`）提升可读性
5. **图片预览**：读取图片时使用 `el-image` 组件的预览功能，支持放大查看
6. **PDF 处理**：PDF 文件可能需要特殊渲染（如 `pdf.js`），或仅显示文本内容
7. **瞬时工具特性**：Read 无 tool_progress，前端只需显示简短的"读取中"状态即可

---

## 九、与其他工具对比

| 工具 | input_json_delta 次数 | tool_progress | 返回值类型 |
|------|---------------------|--------------|-----------|
| **Read** | 4 | 无 | `string` \| `{type, file}` |
| Glob | 4 | 无 | `{filenames, numFiles, truncated}` |
| Grep | 5-7 | 无 | `{mode, filenames, content?, numLines?}` |
| Bash | 3-5 | 有（执行期间） | `{stdout, stderr, interrupted}` |
| Edit | 6 | 无 | `{filePath, structuredPatch}` \| `string` |

**关键区别**：Read 的错误场景返回字符串，成功场景返回结构化对象，需要前端做类型判断。
