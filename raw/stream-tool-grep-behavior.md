# Grep 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-grep.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `{ pattern: string }`（必填），可选：`path, glob, output_mode, -B, -A, -C, context, -n, -i, type, head_limit, offset, multiline` |
| tool_result 结构 | 按模式不同：`{ mode, filenames: string[], numFiles }` 或 `{ mode, filenames, numFiles, content: string, numLines }` |
| stream_event 总数 | 35-347 个（取决于结果量和 LLM 回复长度） |
| tool_progress 推送次数 | **0 次**（Grep 是瞬时工具） |
| input_json_delta 推送次数 | **5-6 次**（取决于可选参数数量） |
| 状态更新频率 | 极低：只有 input_json_delta 几次推送，无 tool_progress |
| 多模式差异 | `files_with_matches` 返回 filenames 数组；`content` 额外返回 content 字符串和 numLines |
| 关闭流式后 | 仅 6 个事件（system + assistant×2 + user + result + done） |

---

## 一、tool_use 调用格式

### input_schema（来自 SDK sdk-tools.d.ts）

Grep 工具接受 1 个必填参数 + 12 个可选参数：

```typescript
interface GrepInput {
  pattern: string;       // 必填：正则表达式搜索模式
  path?: string;         // 搜索路径（默认 cwd）
  glob?: string;         // glob 文件过滤器（如 "*.js", "*.{ts,tsx}"）
  output_mode?: "content" | "files_with_matches" | "count";  // 输出模式，默认 files_with_matches
  "-B"?: number;         // 前置上下文行数（仅 content 模式）
  "-A"?: number;         // 后置上下文行数（仅 content 模式）
  "-C"?: number;         // 上下文行数别名
  context?: number;      // 上下文行数（另一个别名）
  "-n"?: boolean;        // 显示行号（仅 content 模式，默认 true）
  "-i"?: boolean;        // 大小写不敏感
  type?: string;         // 文件类型过滤（rg --type：js, py, rust, go, java 等）
  head_limit?: number;   // 限制输出数量（默认 250，传 0 无限制）
  offset?: number;       // 跳过前 N 行（默认 0）
  multiline?: boolean;   // 多行模式（. 匹配换行）
}
```

### 实际 input 示例（来自 assistant 消息的 tool_use block）

**Case 1 — 默认模式（files_with_matches）**：
```json
{
  "pattern": "vitest",
  "output_mode": "files_with_matches"
}
```

**Case 2 — content 模式**：
```json
{
  "pattern": "describe\\(",
  "output_mode": "content",
  "-n": true,
  "head_limit": 30
}
```

**Case 2 — 第一次 Grep 调用（无 head_limit）**：
```json
{
  "pattern": "describe\\(",
  "output_mode": "content",
  "-n": true
}
```

> **注意**：LLM 在 content 模式下可能先做一次无 head_limit 的查询，发现结果太多后再加 head_limit 重试。这导致多轮 Grep 调用（num_turns=3）。

---

## 二、tool_result 返回值格式

### 完整结构（来自 user 消息的 tool_result）

Grep 的 `tool_use_result` 始终返回结构化对象，根据 output_mode 有两种格式：

#### 格式 A：files_with_matches 模式（默认）

```typescript
interface GrepOutputFilesWithMatches {
  mode: "files_with_matches";
  filenames: string[];   // 匹配文件路径列表
  numFiles: number;      // 匹配文件总数
}
```

**实验数据（Case 1，搜索 "vitest"，120 个文件）**：
```json
{
  "mode": "files_with_matches",
  "filenames": [
    "test\\integration\\stream-tool-grep.spec.ts",
    "docs\\methodology\\project-guide.md",
    "test\\integration\\stream-tool-glob.spec.ts",
    "... (120 项)"
  ],
  "numFiles": 120
}
```

#### 格式 B：content 模式

```typescript
interface GrepOutputContent {
  mode: "content";
  filenames: string[];   // 匹配文件路径列表（可能为空 []）
  numFiles: number;      // 匹配文件数（content 模式可能为 0）
  content: string;       // 匹配行内容（格式：filepath:lineNum:lineContent）
  numLines?: number;     // 匹配行数
}
```

**实验数据（Case 2，content 模式搜索 "describe\("）**：
```json
{
  "mode": "content",
  "numFiles": 0,
  "filenames": [],
  "content": "C:\\...\\tools-skill-only.spec.ts:10:describe('Local LLM - skill tool only', () => {\n...",
  "numLines": 7
}
```

> **注意**：content 模式下 `filenames` 和 `numFiles` 的值可能为空/0（即使有 content 匹配），因为文件信息已内嵌在 content 字符串的路径前缀中。

#### SDK 类型定义（完整 GrepOutput）

```typescript
export interface GrepOutput {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `string?` | 输出模式（与 input 的 output_mode 对应） |
| `filenames` | `string[]` | 匹配文件路径列表 |
| `numFiles` | `number` | 匹配文件总数 |
| `content` | `string?` | content 模式下的匹配行文本（格式 `path:lineNum:text`） |
| `numLines` | `number?` | content 模式下的匹配行数 |
| `numMatches` | `number?` | count 模式下的匹配数 |
| `appliedLimit` | `number?` | 实际应用的 head_limit |
| `appliedOffset` | `number?` | 实际应用的 offset |

### tool_result 的双通道传递

Grep 的结果通过两个通道传递给 LLM：

1. **`tool_use_result`**：结构化 JSON 对象（如上所述），用于程序化消费
2. **`message.content`（string）**：人类可读的文本格式（如 `"Found 120 files\ntest\\...\n..."`）

前端可任选一个通道渲染。

---

## 三、流式事件序列

### 完整时间线（Case 1，files_with_matches 模式）

```
[  0] system (init)              ← 会话初始化
[  1] system (status)            ← 状态更新
[  2] stream_event message_start ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start (thinking)
[  4] stream_event content_block_stop
[  5] stream_event content_block_start (tool_use: Grep)
[  6] stream_event content_block_delta [input_json_delta] ""
[  7] stream_event content_block_delta [input_json_delta] "{"
[  8] stream_event content_block_delta [input_json_delta] ""pattern": "vitest""
[  9] stream_event content_block_delta [input_json_delta] ", "output_mode": "files_with_matches""
[ 10] stream_event content_block_delta [input_json_delta] "}"
[ 11] stream_event content_block_stop
[ 12] stream_event message_delta
[ 13] stream_event message_stop
[ 14] assistant (tool_use: Grep) ← 完整 tool_use block
[ 15] user (tool_result)         ← Grep 执行结果
[ 16] stream_event message_start ← 第 2 轮 API 调用开始
[ 17-34] stream_event (thinking + text_delta × N)
[ 35] assistant (text)           ← LLM 文本回复
[ 36] stream_event message_delta
[ 37] stream_event message_stop
[ 38] result (success)           ← 最终结果
```

### 各阶段事件数量统计

| Case | 模式 | 总事件 | stream_event | assistant | user | result | tool_progress | num_turns |
|------|------|--------|-------------|-----------|------|--------|--------------|-----------|
| 1 | files_with_matches | 38 | 32 | 2 | 1 | 1 | 0 | 2 |
| 2 | content | 341 | 334 | 4 | 2 | 1 | 0 | 3 |
| 5 (SSE) | files_with_matches | 347 | ~340 | 2 | 1 | 1 | 0 | 2 |
| 6 (无流式) | files_with_matches | 6 | 0 | 2 | 1 | 1 | 0 | 2 |

> **注意**：Case 2 事件数暴增（341 个），因为 LLM 做了两次 Grep 调用（第一次结果太多，第二次加 head_limit），且回复了大量 text_delta。

---

## 四、状态更新机制

### tool_progress 推送分析

**实验结果：所有 case 的 tool_progress 推送次数均为 0。**

Grep 是典型的**瞬时工具**——基于 ripgrep 的文件内容搜索，执行速度极快（通常 < 1s），因此 SDK 不推送 tool_progress 事件。

### input_json_delta 推送分析

Grep 的 input_json_delta 推送次数取决于参数数量：

| Case | 参数数量 | input_json_delta 推送次数 | 推送内容序列 |
|------|----------|--------------------------|-------------|
| 1 (files_with_matches) | 2 个 | **5 次** | `""` → `"{"` → `"pattern"` → `", output_mode"` → `"}"` |
| 2 (content, 3 参数) | 3 个 | **6 次** | `""` → `"{"` → `"pattern"` → `", output_mode"` → `", -n"` → `"}"` |
| 2 (content, 4 参数) | 4 个 | **7 次** | + `", head_limit"` |

> **模式**：input_json_delta 推送 = 2（空字符串 + 开括号）+ N（每个参数 1 次）+ 1（闭括号）= **N + 3 次**。

### SDK 推送频率统计

对于 Grep 工具调用场景（以 Case 1 为例）：

| 事件类型 | 数量 | 说明 |
|---------|------|------|
| system | 2-3 | init + status（可能多 1 个 status） |
| stream_event (input_json_delta) | 5 | Grep 参数流式推送 |
| stream_event (text_delta) | 10-300+ | LLM 回复文本（差异极大） |
| stream_event (thinking) | 0-1 | thinking block（LLM 可能跳过） |
| assistant | 2-4 | 完整消息块 |
| user | 1-2 | tool_result |
| tool_progress | **0** | 瞬时工具无进度 |
| result | 1 | 最终结果 |

### 是否需要不断修改前端状态？

**不需要频繁修改。** Grep 工具调用的前端状态更新仅涉及：

1. **input_json_delta 期间**（约 5 次更新）：拼接 JSON → 尝试 parse → 更新 toolInput
2. **tool_result 到达时**（1 次更新）：从 `calling` 状态切换为 `complete`
3. **无 tool_progress**：不需要更新进度条

前端实际需要的 state transition：

```
idle → calling (content_block_start: tool_use)
calling → running (input_json_delta 拼接中)
running → complete (user: tool_result 到达)
```

---

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
// Grep 工具调用状态
interface GrepToolState {
  // 工具输入（来自 input_json_delta 拼接）
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    output_mode?: 'files_with_matches' | 'content' | 'count';
    head_limit?: number;
    '-n'?: boolean;
    '-i'?: boolean;
    [key: string]: unknown;
  };

  // 工具结果（来自 tool_result）
  result?: {
    mode?: string;
    filenames: string[];
    numFiles: number;
    content?: string;    // content 模式
    numLines?: number;   // content 模式
    numMatches?: number; // count 模式
  };

  // 状态
  status: 'calling' | 'running' | 'complete' | 'error';
}
```

### 状态机设计

```
content_block_start(Grep)  →  status = 'calling'
                              inputJsonBuffer = ''
                              
input_json_delta × 5        →  inputJsonBuffer += delta
                              try { input = JSON.parse(buffer) }
                              status = 'running'

user(tool_result)           →  result = parsed_result
                              status = 'complete'
```

### 组件模板

```vue
<template>
  <el-card class="grep-tool-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">
          <el-icon v-if="status === 'running'" class="is-loading"><Loading /></el-icon>
          Grep
        </el-tag>
        <span class="pattern-text">{{ input?.pattern }}</span>
        <el-tag v-if="input?.output_mode" size="small" type="info">
          {{ input.output_mode }}
        </el-tag>
        <el-tag v-if="result" type="success" size="small">
          {{ result.numFiles }} 个文件
        </el-tag>
      </div>
    </template>

    <!-- 工具参数 -->
    <el-descriptions v-if="input" :column="2" border size="small">
      <el-descriptions-item label="pattern">
        <code>{{ input.pattern }}</code>
      </el-descriptions-item>
      <el-descriptions-item v-if="input.output_mode" label="output_mode">
        {{ input.output_mode }}
      </el-descriptions-item>
      <el-descriptions-item v-if="input.path" label="path">
        {{ input.path }}
      </el-descriptions-item>
      <el-descriptions-item v-if="input.glob" label="glob">
        {{ input.glob }}
      </el-descriptions-item>
      <el-descriptions-item v-if="input.head_limit" label="head_limit">
        {{ input.head_limit }}
      </el-descriptions-item>
      <el-descriptions-item v-if="input['-i']" label="ignore case">
        true
      </el-descriptions-item>
    </el-descriptions>

    <!-- 结果渲染：files_with_matches 模式 -->
    <template v-if="result?.mode === 'files_with_matches' && result.filenames.length > 0">
      <div class="result-section">
        <el-text type="info">找到 {{ result.numFiles }} 个文件</el-text>
        <el-table :data="fileList" stripe size="small" max-height="400">
          <el-table-column type="index" width="50" />
          <el-table-column prop="path" label="文件路径">
            <template #default="{ row }">
              <code class="file-path">{{ row.path }}</code>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 结果渲染：content 模式 -->
    <template v-if="result?.mode === 'content' && result.content">
      <div class="result-section">
        <el-text type="info">
          {{ result.numLines }} 行匹配
        </el-text>
        <div class="content-output">
          <pre><code>{{ result.content }}</code></pre>
        </div>
      </div>
    </template>

    <!-- 无结果 -->
    <template v-if="result && result.numFiles === 0 && !result.content">
      <el-empty description="未找到匹配" :image-size="60" />
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Loading } from '@element-plus/icons-vue'

const props = defineProps<{
  input: GrepToolState['input']
  result?: GrepToolState['result']
  status: GrepToolState['status']
}>()

const statusClass = computed(() => ({
  'tool-calling': props.status === 'calling',
  'tool-running': props.status === 'running',
  'tool-complete': props.status === 'complete',
}))

const statusTagType = computed(() => {
  if (props.status === 'complete') return 'success'
  if (props.status === 'running') return 'warning'
  return 'info'
})

const fileList = computed(() =>
  (props.result?.filenames || []).map(path => ({ path }))
)
</script>

<style scoped>
.grep-tool-card { margin: 8px 0; }
.pattern-text { font-family: monospace; color: var(--el-color-primary); margin: 0 8px; }
.file-path { font-size: 12px; }
.content-output {
  max-height: 400px;
  overflow: auto;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 8px;
}
.content-output pre { margin: 0; font-size: 12px; }
</style>
```

### 关键交互处理

Grep 工具**不需要用户交互**——它不需要权限确认、不需要 canUseTool 回调。前端只需：

1. **监听 input_json_delta**：拼接 JSON → 解析 → 更新 input 参数显示
2. **监听 tool_result**：解析结构化结果 → 切换到结果渲染视图
3. **三种模式分派渲染**：根据 `mode` 字段选择不同渲染组件

---

## 六、实验数据

### 实验矩阵

| Case | 场景 | Grep 调用数 | input_json_delta | tool_progress | num_turns | 耗时 |
|------|------|-----------|-----------------|--------------|-----------|------|
| 1 | files_with_matches 模式 | 1 | 5 | 0 | 2 | 8.6s |
| 2 | content 模式 | 2 | 13 | 0 | 3 | 21.4s |
| 3 | count 模式 | 0（LLM 未调用） | 0 | 0 | 1 | 3.9s |
| 4 | 无匹配（实际有匹配） | 2 | ~12 | 0 | 4 | 25.0s |
| 5 (SSE) | files_with_matches | 1 | 5 | 0 | 2 | 23.7s |
| 6 (无流式) | files_with_matches | 1 | 0 | 0 | 2 | 16.6s |

### 原始事件样本（关键事件的 JSON）

#### content_block_start(tool_use: Grep)

```json
{
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "tool_use",
    "id": "call_d1fb9981b42445bfbbc92010",
    "name": "Grep",
    "input_schema": {
      "type": "object",
      "properties": {
        "pattern": { "type": "string", "description": "正则表达式..." },
        "path": { "type": "string" },
        "glob": { "type": "string" },
        "output_mode": { "enum": ["content", "files_with_matches", "count"] },
        ...
      },
      "required": ["pattern"]
    }
  }
}
```

#### input_json_delta 推送序列（Case 1，5 次）

```
[1] ""                                    ← 空字符串
[2] "{"                                   ← 开括号
[3] ""pattern": "vitest""                ← 第 1 个参数
[4] ", "output_mode": "files_with_matches""  ← 第 2 个参数
[5] "}"                                   ← 闭括号
```

拼接结果：`{"pattern": "vitest", "output_mode": "files_with_matches"}`

#### tool_use_result（files_with_matches 模式）

```json
{
  "mode": "files_with_matches",
  "filenames": ["test\\integration\\stream-tool-grep.spec.ts", "..."],
  "numFiles": 120
}
```

#### tool_use_result（content 模式）

```json
{
  "mode": "content",
  "numFiles": 0,
  "filenames": [],
  "content": "path:lineNum:lineContent\n...",
  "numLines": 7
}
```

---

## 七、与 Glob 工具的对比

| 维度 | Grep | Glob |
|------|------|------|
| **用途** | 按内容搜索文件 | 按文件名查找文件 |
| **必填参数** | `pattern` | `pattern` |
| **可选参数** | 12 个（path, glob, output_mode, -B, -A, -C, -n, -i, type, head_limit, offset, multiline） | 1 个（path） |
| **input_json_delta** | 5-7 次（取决于参数数） | 固定 4 次 |
| **tool_result** | 含 `mode` + `content`/`filenames` | 仅 `filenames` + `durationMs` + `truncated` |
| **输出模式** | 3 种（files_with_matches, content, count） | 1 种（文件列表） |
| **结果上限** | head_limit 默认 250 行 | 100 个文件 |
| **tool_progress** | 0 次（瞬时工具） | 0 次（瞬时工具） |
| **遵守 .gitignore** | **是**（默认遵守） | **否**（默认不遵守） |
| **底层引擎** | ripgrep | glob 匹配 |

---

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| count 模式的 tool_result 完整结构 | 未触发 | LLM 直接回答未调用工具，需更强制的 prompt |
| numMatches 字段的实际值 | 未验证 | count 模式下应返回 |
| appliedLimit / appliedOffset 字段 | 未验证 | 需要显式传 head_limit 和 offset |
| 多行匹配的 content 格式 | 未验证 | multiline=true 时的 content 输出 |
| glob 过滤效果 | 未验证 | 如 `glob: "*.ts"` 时 filenames 是否只含 .ts |
| 搜索 path 为特定目录 | 未验证 | path 参数是否生效 |
| 大量 content 结果的截断 | 未验证 | content 模式是否有长度限制 |
