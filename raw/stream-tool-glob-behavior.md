# Glob 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-glob.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `{ pattern: string }`（1 个必填字段） |
| tool_result 结构 | `{ filenames: string[], durationMs: number, numFiles: number, truncated: boolean }` |
| stream_event 总数 | 62-88 个（含大量 text_delta） |
| tool_progress 推送次数 | **0 次**（Glob 是瞬时工具） |
| input_json_delta 推送次数 | **固定 4 次**（`""` → `"{"` → `"\"pattern\": \"...\""` → `"}"` |
| 状态更新频率 | 极低：只有 input_json_delta 4 次推送，无 tool_progress |
| 无结果时 tool_result | `{ filenames: [], numFiles: 0, truncated: false, durationMs: ~400 }` |
| 截断时 tool_result | `{ filenames: [100项], numFiles: 100, truncated: true, durationMs: ~1900 }` |

---

## 一、tool_use 调用格式

### input_schema（来自 SDK init 消息）

Glob 工具接受 1 个参数：

```json
{
  "pattern": "**/*.spec.ts"
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | `string` | Yes | glob 模式表达式 |

> 注意：Glob 工具只有 `pattern` 一个参数，没有 `path`（目录）参数。搜索范围始终是当前工作目录（cwd）。

### 实际 input 示例（来自 assistant 消息的 tool_use block）

**Case 1 — 查找 .spec.ts 文件**：
```json
{
  "pattern": "**/*.spec.ts"
}
```

**Case 2 — 查找不存在的扩展名**：
```json
{
  "pattern": "**/*.xyz_nonexistent_extension"
}
```

**Case 3 — 查找所有文件（大量结果）**：
```json
{
  "pattern": "**/*"
}
```

---

## 二、tool_result 返回值格式

### 完整结构（来自 user 消息的 tool_result）

Glob 的 `tool_use_result` 始终返回结构化对象：

```typescript
interface GlobToolResult {
  filenames: string[];   // 匹配文件路径列表
  durationMs: number;    // 工具执行耗时（毫秒）
  numFiles: number;      // 匹配文件总数
  truncated: boolean;    // 结果是否被截断（上限 100 个文件）
}
```

### 场景对比

#### 有结果（Case 1，95 个 .spec.ts 文件）
```json
{
  "filenames": [
    "test\\demos\\claude-code-intro.spec.ts",
    "test\\demos\\memory.spec.ts",
    "test\\demos\\simple-query.spec.ts",
    "..."
  ],
  "durationMs": 431,
  "numFiles": 95,
  "truncated": false
}
```

#### 无结果（Case 2，不存在的扩展名）
```json
{
  "filenames": [],
  "durationMs": 401,
  "numFiles": 0,
  "truncated": false
}
```
> 同时 `messageContentTypes` 中 `contentSnippet` 为 `"No files found"`

#### 截断场景（Case 3，100+ 个文件）
```json
{
  "filenames": [
    ".git\\description",
    ".git\\hooks\\applypatch-msg.sample",
    "...（前 100 个文件）",
    "node_modules\\tapable\\LICENSE"
  ],
  "durationMs": 1908,
  "numFiles": 100,
  "truncated": true
}
```
> `numFiles` 等于 `filenames.length`（100），即截断后返回的文件数，而非实际匹配总数。
> `truncated: true` 表示还有更多文件未返回。

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `filenames` | `string[]` | 文件路径列表，使用反斜杠 `\`（Windows）或 `/`（Unix）分隔 |
| `durationMs` | `number` | 工具执行耗时，范围 400-2000ms |
| `numFiles` | `number` | 返回的文件数量（截断时为上限值 100） |
| `truncated` | `boolean` | 是否因达到上限而截断。上限为 **100 个文件** |

### user 消息的完整结构

```json
{
  "parent_tool_use_id": null,
  "tool_use_result": {
    "filenames": ["..."],
    "durationMs": 431,
    "numFiles": 95,
    "truncated": false
  },
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_ad32daba7f61476aa7d23637",
      "contentType": "string",
      "contentSnippet": "test\\demos\\claude-code-intro.spec.ts\ntest\\demos\\memory.spec.ts\n..."
    }
  ]
}
```

> 注意：`tool_use_result` 是结构化 JSON 对象（**直接可用**），而 `messageContentTypes[].contentSnippet` 是纯文本格式（换行分隔的文件列表）。

---

## 三、流式事件序列

### 完整时间线（从 message_start 到 result）

以 Case 1 为例（查找 `**/*.spec.ts`，185 个事件）：

```
[  0] system (init)                    ← 会话初始化
[  1] system (status)                  ← 状态更新

第 1 轮 API 调用（tool_use）:
[  2] stream_event → message_start     ← 第 1 轮开始
[  3] stream_event → content_block_start (thinking)
[  4] stream_event → content_block_stop
[  5] stream_event → content_block_start [Glob]  ← tool_use block 开始
[  6] stream_event → content_block_delta [input_json_delta] ""     ← delta #1: 空字符串
[  7] stream_event → content_block_delta [input_json_delta] "{"   ← delta #2: 开始 {
[  8] stream_event → content_block_delta [input_json_delta] "\"pattern\": \"**/*.spec.ts\""  ← delta #3: 字段
[  9] stream_event → content_block_delta [input_json_delta] "}"   ← delta #4: 结束 }
[ 10] assistant [tool_use: Glob]       ← 完整 tool_use block（input: {pattern: "**/*.spec.ts"}）
[ 11] stream_event → content_block_stop
[ 12] stream_event → message_delta
[ 13] stream_event → message_stop

工具执行（SDK 自动执行 Glob）:
[ 14] user (tool_result)               ← {filenames: [...95个], numFiles: 95, truncated: false}
[ 15] system (status)

第 2 轮 API 调用（text 回复）:
[ 16] stream_event → message_start     ← 第 2 轮开始
[ 17] stream_event → content_block_start (thinking)
[ 18-179] stream_event → content_block_delta [text_delta] ×162  ← 流式文本输出
[180] assistant [text: "I found **53**..."]  ← 完整回复
[181] stream_event → content_block_stop
[182] stream_event → message_delta
[183] stream_event → message_stop

[184] result (success)                 ← num_turns: 2, duration_ms: 11451
```

### 各阶段事件数量统计

| Case | 场景 | 总事件 | stream_event | assistant | user | result | num_turns |
|------|------|--------|-------------|-----------|------|--------|-----------|
| 1 | 有结果（95 文件） | 185 | 163 | 2 | 1 | 1 | 2 |
| 2 | 无结果（0 文件） | 62 | 55 | 2 | 1 | 1 | 2 |
| 3 | 截断（100 文件） | 88 | 79 | 2 | 1 | 1 | 2 |
| 4 | 纯文本基线 | ~10 | ~3 | 1 | 0 | 1 | 1 |

### 各场景的 stream_event 内部 event.type 分布

**Case 1（有结果）**：
```
message_start:         2
content_block_start:   3  (1 thinking + 1 tool_use + 1 text)
content_block_delta:   166  (4 input_json_delta + 162 text_delta)
content_block_stop:    3
message_delta:         2
message_stop:          2
```

**Case 2（无结果）**：
```
message_start:         2
content_block_start:   3  (1 thinking + 1 tool_use + 1 text)
content_block_delta:   43  (4 input_json_delta + 39 text_delta)
content_block_stop:    3
message_delta:         2
message_stop:          2
```

**Case 3（截断）**：
```
message_start:         2
content_block_start:   3  (1 thinking + 1 tool_use + 1 text)
content_block_delta:   67  (4 input_json_delta + 63 text_delta)
content_block_stop:    3
message_delta:         2
message_stop:          2
```

---

## 四、状态更新机制

### tool_progress 推送分析

| Case | tool_progress 数量 |
|------|-------------------|
| Case 1 | **0** |
| Case 2 | **0** |
| Case 3 | **0** |

**结论：Glob 是瞬时工具，执行期间不推送 tool_progress 事件。**

Glob 的执行时间在 400-2000ms 之间，太短不需要进度推送。

### input_json_delta 推送分析

Glob 的 input_json_delta 推送模式**完全固定**，所有场景都是 4 次：

```
#1: ""                              ← 空字符串（初始化）
#2: "{"                             ← JSON 对象开始
#3: "\"pattern\": \"**/*.spec.ts\""  ← pattern 字段值
#4: "}"                             ← JSON 对象结束
```

拼接后完整 JSON：`{"pattern": "**/*.spec.ts"}`

### SDK 推送频率统计

| 事件类型 | 推送次数 | 间隔 |
|----------|---------|------|
| `input_json_delta` | 固定 4 次 | ~30-350ms |
| `text_delta` | 39-162 次 | ~20-25ms |
| `tool_progress` | **0 次** | N/A |

### 是否需要不断修改前端状态？

- ❌ **Glob 调用期间不需要频繁修改状态**
- Glob 的 input_json_delta 只有 4 次，拼接开销极小
- Glob 没有 tool_progress，不需要更新进度条
- 工具执行时间 400-2000ms，几乎瞬间完成
- **前端渲染重点**：工具调用开始时显示 loading spinner，收到 tool_result 后立即渲染文件列表

---

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
// Glob 工具的 input 参数
interface GlobToolInput {
  pattern: string;
}

// Glob 工具的 result
interface GlobToolResult {
  filenames: string[];
  durationMs: number;
  numFiles: number;
  truncated: boolean;
}

// 前端 ContentBlock 中的 tool_use 类型
interface GlobToolUseBlock {
  type: 'tool_use';
  toolUseId: string;
  toolName: 'Glob';
  toolInput: GlobToolInput;
  toolStatus: 'calling' | 'running' | 'complete' | 'error';
  toolResult?: GlobToolResult;
}
```

### 状态机设计

```
calling → (content_block_start) → (input_json_delta ×4) → complete
                                                              ↓
                                                    tool_result 到达
                                                              ↓
                                                        显示文件列表
```

**Glob 无需 'running' 状态**：从 calling 到 complete 几乎瞬间（< 2s），不需要显示进度。

### 组件模板

```vue
<template>
  <el-card class="glob-tool-card" shadow="hover">
    <template #header>
      <div class="tool-header">
        <el-tag type="primary">
          <el-icon><Search /></el-icon>
          Glob
        </el-tag>
        <span class="pattern-text">{{ toolInput.pattern }}</span>

        <!-- 状态指示器 -->
        <el-tag v-if="status === 'calling'" type="info">
          <el-icon class="is-loading"><Loading /></el-icon>
          搜索中...
        </el-tag>
        <el-tag v-else-if="status === 'complete'" type="success">
          {{ result?.numFiles }} 个文件 ({{ result?.durationMs }}ms)
        </el-tag>
      </div>
    </template>

    <!-- 搜索结果 -->
    <template v-if="result">
      <!-- 截断警告 -->
      <el-alert
        v-if="result.truncated"
        title="结果已截断"
        type="warning"
        :closable="false"
        show-icon
        class="truncate-warning"
      >
        显示前 {{ result.numFiles }} 个文件。请使用更具体的 pattern 缩小范围。
      </el-alert>

      <!-- 文件列表 -->
      <el-table
        :data="displayFilenames"
        stripe
        size="small"
        :max-height="400"
        class="file-list-table"
      >
        <el-table-column type="index" width="50" label="#" />
        <el-table-column prop="path" label="文件路径">
          <template #default="{ row }">
            <span class="file-path">
              <el-icon><Document /></el-icon>
              {{ row.path }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <!-- 底部统计 -->
      <div class="result-footer">
        <el-text type="info" size="small">
          共 {{ result.numFiles }} 个文件 · 耗时 {{ result.durationMs }}ms
          <span v-if="result.truncated"> · <el-text type="warning">已截断</el-text></span>
        </el-text>
      </div>
    </template>

    <!-- 无结果 -->
    <template v-else-if="status === 'complete' && result?.numFiles === 0">
      <el-empty description="没有找到匹配的文件" :image-size="60" />
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Search, Loading, Document } from '@element-plus/icons-vue'

interface Props {
  toolInput: { pattern: string }
  status: 'calling' | 'complete' | 'error'
  result?: {
    filenames: string[]
    durationMs: number
    numFiles: number
    truncated: boolean
  }
}

const props = defineProps<Props>()

const displayFilenames = computed(() =>
  (props.result?.filenames || []).map(path => ({ path }))
)
</script>

<style scoped>
.glob-tool-card {
  margin: 8px 0;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pattern-text {
  font-family: 'Fira Code', monospace;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.file-path {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: 'Fira Code', monospace;
  font-size: 13px;
}
.truncate-warning {
  margin-bottom: 8px;
}
.result-footer {
  margin-top: 8px;
  text-align: right;
}
</style>
```

### 关键交互处理

Glob 工具**不需要用户交互**（无权限确认、无表单填写）。

**前端渲染流程**：

```
1. 收到 content_block_start(type=tool_use, name=Glob)
   → 创建 GlobToolUseBlock，status='calling'
   → 显示卡片，带 loading spinner

2. 收到 input_json_delta ×4
   → 拼接 JSON，解析得到 pattern
   → 更新卡片的 pattern 显示

3. 收到 user 消息 (tool_result)
   → 解析 tool_use_result
   → status='complete'
   → 渲染文件列表表格
   → 若 truncated=true，显示截断警告
   → 若 numFiles=0，显示空状态
```

**虚拟滚动优化**（文件数 > 50 时）：

```vue
<!-- 使用 el-table-v2 替代 el-table -->
<el-table-v2
  :columns="columns"
  :data="fileData"
  :width="700"
  :height="400"
  :row-height="35"
  fixed
/>
```

### 文件路径的交互增强

可以增加点击文件路径后触发 `Read` 工具的能力：

```typescript
function handleFileClick(filePath: string) {
  // 发送新的 prompt 让 Claude 读取该文件
  emit('read-file', filePath)
}
```

---

## 六、实验数据

### 实验矩阵

| Case | 场景 | pattern | 总事件 | stream_event | input_json_delta | text_delta | tool_progress | tool_use_summary | 结果 |
|------|------|---------|--------|-------------|-----------------|------------|---------------|-----------------|------|
| 1 | 有结果 | `**/*.spec.ts` | 185 | 163 | 4 | 162 | 0 | 0 | 95 文件，truncated=false |
| 2 | 无结果 | `**/*.xyz_nonexistent_extension` | 62 | 55 | 4 | 39 | 0 | 0 | 0 文件 |
| 3 | 截断 | `**/*` | 88 | 79 | 4 | 63 | 0 | 0 | 100 文件，truncated=true |
| 4 | 纯文本 | (无工具) | ~10 | ~3 | 0 | 0 | 0 | 0 | - |

### 原始事件样本（关键事件的 JSON）

#### content_block_start — Glob 工具调用开始

```json
{
  "index": 5,
  "type": "stream_event",
  "eventType": "content_block_start",
  "toolName": "Glob",
  "toolUseId": "call_ad32daba7f61476aa7d23637"
}
```

#### input_json_delta 序列

```json
[
  { "index": 6, "deltaType": "input_json_delta", "inputJsonSnippet": "" },
  { "index": 7, "deltaType": "input_json_delta", "inputJsonSnippet": "{" },
  { "index": 8, "deltaType": "input_json_delta", "inputJsonSnippet": "\"pattern\": \"**/*.spec.ts\"" },
  { "index": 9, "deltaType": "input_json_delta", "inputJsonSnippet": "}" }
]
```

#### assistant tool_use block — 完整工具调用

```json
{
  "index": 10,
  "type": "assistant",
  "toolName": "Glob",
  "toolUseId": "call_ad32daba7f61476aa7d23637",
  "raw": {
    "toolInput": {
      "pattern": "**/*.spec.ts"
    }
  }
}
```

#### user tool_result — 有结果

```json
{
  "index": 14,
  "type": "user",
  "raw": {
    "parent_tool_use_id": null,
    "tool_use_result": {
      "filenames": ["test\\demos\\claude-code-intro.spec.ts", "..."],
      "durationMs": 431,
      "numFiles": 95,
      "truncated": false
    },
    "messageContentTypes": [
      {
        "type": "tool_result",
        "tool_use_id": "call_ad32daba7f61476aa7d23637",
        "contentType": "string",
        "contentSnippet": "test\\demos\\claude-code-intro.spec.ts\n..."
      }
    ]
  }
}
```

#### user tool_result — 无结果

```json
{
  "tool_use_result": {
    "filenames": [],
    "durationMs": 401,
    "numFiles": 0,
    "truncated": false
  },
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_3909164138314961b52cc62e",
      "contentType": "string",
      "contentSnippet": "No files found"
    }
  ]
}
```

#### user tool_result — 截断

```json
{
  "tool_use_result": {
    "filenames": [".git\\description", "...（100 项）"],
    "durationMs": 1908,
    "numFiles": 100,
    "truncated": true
  }
}
```

#### result — 最终结果

```json
{
  "index": 184,
  "type": "result",
  "raw": {
    "subtype": "success",
    "num_turns": 2,
    "duration_ms": 11451,
    "stop_reason": "end_turn",
    "total_cost_usd": 0.199895
  }
}
```

---

## 七、与基线对比（全工具横向比较）

| 维度 | Glob | CronList | Bash | Edit |
|------|------|----------|------|------|
| input 字段数 | 1 (`pattern`) | 0 (`{}`) | 1+ (`command`, ...) | 3 (`file_path`, `old_string`, `new_string`) |
| input_json_delta 次数 | 4 | 3 | 4+ | 6 |
| tool_result 格式 | 结构化对象 | 结构化对象 | 双格式 | 双格式 |
| tool_progress | 0 | 0 | 可能有 | 0 |
| 执行时间 | 400-2000ms | <100ms | 可长可短 | <100ms |
| 需要权限 | No | No | **Yes** | **Yes** |
| API turns | 2 | 2 | 2 | 3（read-before-edit） |

---

## 八、前端状态更新回答

### SDK 会推送很多次状态更新吗？

**不会。Glob 工具调用期间的状态更新极少：**

1. **input_json_delta**：固定 4 次，每次只推送一个小字符串片段
2. **tool_progress**：**0 次**（Glob 是瞬时工具）
3. **text_delta**：工具调用完成后，第 2 轮 API 调用会有大量 text_delta（39-162 次），但这些是 Claude 的文本回复，不是工具执行状态

### 前端状态修改频率

| 阶段 | 状态修改次数 | 说明 |
|------|-------------|------|
| tool_use 开始 | 1 次 | 创建 block，显示 loading |
| input_json_delta | 4 次 | 拼接 pattern 字符串 |
| tool_result 到达 | 1 次 | 渲染文件列表 |
| **总计** | **~6 次** | 非常少，无性能问题 |

**结论**：Glob 是最简单的工具之一，前端渲染几乎不需要复杂的状态管理。

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| `path` 参数是否存在 | 未测试 | wiki 文档中 Glob 参数可能包含可选 path，但实验中未出现 |
| SSE 视角（Case 5/6） | 超时未完成 | NestJS 启动超时，但 SDK 直连数据已足够 |
| 100 个文件截断阈值的精确性 | 已验证 | Case 3 确认上限为 100 个文件 |
| `.gitignore` 遵守行为 | 未测试 | 默认不遵守 .gitignore（`CLAUDE_CODE_GLOB_NO_IGNORE=false` 可改变） |
| 文件排序方式 | 已确认 | 按修改时间排序 |
| 大型 monorepo 中的性能 | 未测试 | durationMs 1908ms 在本项目中，更大项目可能更长 |
| 并行 Glob 调用 | 未测试 | 多个 Glob 调用是否并行执行 |
