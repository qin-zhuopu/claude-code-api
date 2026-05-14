# ReadMcpResourceTool 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-readmcpresource.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `{ server: string; uri: string }` — 两个必需参数 |
| tool_result 结构 | `{ contents: [{uri, mimeType?, text?, blobSavedTo?}] }` — 资源内容数组 |
| stream_event 总数 | ~40 个（case-1，2 轮 API 调用） |
| tool_progress 推送次数 | **0** — 瞬时工具，无执行时间 |
| 状态更新频率 | 无 tool_progress、无 tool_use_summary |
| input_json_delta 次数 | **固定 5 次** — 所有场景 |
| 前置条件 | **必须至少配置 1 个 MCP 服务器**，否则工具不可用 |
| num_turns | 固定 2 轮（调用 + 结果回复） |
| 错误处理 | 资源不存在时返回错误字符串（非结构化对象） |

## 一、tool_use 调用格式

### input_schema（来自 SDK 类型定义 `sdk-tools.d.ts`）

```typescript
interface ReadMcpResourceInput {
  /** The MCP server name */
  server: string;
  /** The resource URI to read */
  uri: string;
}
```

### 实际 input 示例

**读取文本资源**：
```json
{
  "server": "test-mcp-server",
  "uri": "test://resource/hello"
}
```

**读取 JSON 资源**：
```json
{
  "server": "test-mcp-server",
  "uri": "test://resource/config"
}
```

**读取 Markdown 资源**：
```json
{
  "server": "test-mcp-server",
  "uri": "test://resource/readme"
}
```

### input_json_delta 推送模式

| 场景 | 推送次数 | 推送序列 |
|------|----------|----------|
| 所有场景 | **固定 5 次** | `""` → `"{"` → `"server": "test-mcp-server"` → `, "uri": "test://resource/hello"` → `"}"` |

**关键发现**：与 ListMcpResourcesTool（3-4 次）不同，ReadMcpResourceTool 总是推送 5 次 input_json_delta，因为 server 和 uri 都是必需参数。

### 前置条件（重要）

`ReadMcpResourceTool` **只在至少配置了 1 个 MCP 服务器时才可用**。测试中需要通过 `mcpServers` 选项传入 MCP 服务器配置：

```typescript
const queryOptions = {
  // ... 其他选项
  mcpServers: {
    'test-mcp-server': {
      type: 'stdio',
      command: 'node',
      args: ['./fixtures/mcp-server/server.mjs'],
      alwaysLoad: true,  // 确保工具在启动时可用
    },
  },
};
```

## 二、tool_result 返回值格式

### 完整结构（来自 user 消息的 tool_result）

#### 成功场景

**文本资源（text/plain）**：

```json
{
  "tool_use_result": {
    "contents": [
      {
        "uri": "test://resource/hello",
        "mimeType": "text/plain",
        "text": "Hello World from MCP!"
      }
    ]
  },
  "parent_tool_use_id": null,
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_dc5df9d5afcf4509811455fd",
      "contentType": "string",
      "contentSnippet": "{\"contents\":[{\"uri\":\"test://resource/hello\",\"mimeType\":\"text/plain\",\"text\":\"Hello World from MCP!\"}]}"
    }
  ]
}
```

**JSON 资源（application/json）**：

```json
{
  "tool_use_result": {
    "contents": [
      {
        "uri": "test://resource/config",
        "mimeType": "application/json",
        "text": "{\"name\":\"test-config\",\"version\":\"1.0.0\",\"debug\":true}"
      }
    ]
  }
}
```

**Markdown 资源（text/markdown）**：

```json
{
  "tool_use_result": {
    "contents": [
      {
        "uri": "test://resource/readme",
        "mimeType": "text/markdown",
        "text": "# Test MCP Server\n\nThis is a test README."
      }
    ]
  }
}
```

#### 失败场景（资源不存在）

```json
{
  "tool_use_result": "Error: MCP error -32602: MCP error -32602: Resource test://resource/nonexistent not found",
  "parent_tool_use_id": null,
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_865f111815004befa2fb3ef5",
      "contentType": "string",
      "contentSnippet": "MCP error -32602: MCP error -32602: Resource test://resource/nonexistent not found"
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `contents` | `Array<{uri, mimeType?, text?, blobSavedTo?}>` | 资源内容数组（通常只有一个元素） |
| `contents[].uri` | `string` | 资源 URI（如 "test://resource/hello"） |
| `contents[].mimeType` | `string?` | MIME 类型（可选，如 "text/plain"、"application/json"） |
| `contents[].text` | `string?` | 文本内容（文本资源） |
| `contents[].blobSavedTo` | `string?` | 二进制内容保存路径（二进制资源，未在测试中验证） |
| `parent_tool_use_id` | `string \| null` | 通常为 null（非嵌套调用时） |
| `messageContentTypes` | `Array<{type, tool_use_id, contentType, contentSnippet}>` | user 消息 content 的元信息 |

### tool_result 在 user 消息 content 中的表现

在 `message.content` 中，tool_result 的 `content` 字段是 **string** 类型（JSON 序列化的 contents 数组或错误消息）：

```json
{
  "type": "tool_result",
  "tool_use_id": "call_dc5df9d5afcf4509811455fd",
  "content": "{\"contents\":[{\"uri\":\"test://resource/hello\",\"mimeType\":\"text/plain\",\"text\":\"Hello World from MCP!\"}]}"
}
```

需要 `JSON.parse(content)` 获取资源对象。**注意错误场景时，content 直接是错误字符串，不是 JSON 格式。**

## 三、流式事件序列

### 完整时间线（case-1：读取文本资源）

```
[  0] system (init)                    ← 会话初始化（含 MCP 服务器连接）
[  1] system (status)                  ← 状态更新

── 第 1 轮 API 调用（思考 + 工具调用）──
[  2] stream_event → message_start     ← 第 1 轮 API 调用开始
[  3-?] stream_event → thinking_delta  ← 思考内容流式推送
[  ?] stream_event → content_block_start (tool_use: ReadMcpResourceTool)
[  ?] stream_event → input_json_delta × 5  ← 工具参数推送
[  ?] stream_event → content_block_stop
[  ?] assistant (tool_use: ReadMcpResourceTool)  ← 完整 tool_use block
[  ?] stream_event → message_delta
[  ?] stream_event → message_stop

── SDK 自动执行 ReadMcpResourceTool ──
[  ?] user (tool_result)               ← 资源内容作为 user 消息

── 第 2 轮 API 调用（结果回复）──
[  ?] stream_event → message_start     ← 第 2 轮 API 调用开始
[  ?-?] stream_event → thinking_delta  ← 思考内容
[  ?-?] stream_event → text_delta      ← 回复文本流式推送
[  ?] assistant (text)                 ← 完整回复 block
[  ?] stream_event → message_delta
[  ?] stream_event → message_stop

[  ?] result (success)                 ← 最终结果
```

### 各阶段事件数量统计

| Case | 场景 | system | stream_event | assistant | user | result | num_turns |
|------|------|--------|-------------|-----------|------|--------|-----------|
| 1 | 读取文本资源 | 3 | 28 | 2 | 1 | 1 | 2 |
| 2 | 读取 JSON 资源 | 3 | 53 | 2 | 1 | 1 | 2 |
| 3 | 读取 Markdown 资源 | 3 | 38 | 2 | 1 | 1 | 2 |
| 4 | 读取不存在的 URI | 3 | 33 | 2 | 1 | 1 | 2 |
| 5 | SSE 前端视角 | 3 | 28 | 2 | 1 | 1 | 2 |
| 6 | 关闭流式 | ~2 | 0 | 2 | 1 | 1 | 2 |

## 四、状态更新机制

### tool_progress 推送分析

**结论：ReadMcpResourceTool 是瞬时工具，不产生任何 tool_progress 事件。**

- 所有测试 case 中 tool_progress 数量均为 **0**
- 这是因为 ReadMcpResourceTool 只是向 MCP 服务器发起资源读取请求，执行时间极短（通常 <100ms）
- 与 Glob、Grep、ListMcpResourcesTool 等瞬时工具行为一致

### SDK 推送频率统计

| 事件类型 | Case 1 | Case 2 | Case 3 | Case 4 | Case 5 |
|----------|--------|--------|--------|--------|--------|
| tool_progress | 0 | 0 | 0 | 0 | 0 |
| tool_use_summary | 0 | 0 | 0 | 0 | 0 |
| system (status) | 2 | 2 | 2 | 2 | 2 |
| input_json_delta | 5 | 5 | 5 | 5 | 5 |

### 是否需要不断修改前端状态？

**不需要。** ReadMcpResourceTool 的调用过程中：
- ✅ `input_json_delta` 固定 5 次推送，开销极小
- ✅ 无 `tool_progress` 事件，不需要更新进度条
- ✅ 无 `tool_use_summary` 事件
- ✅ 工具执行是瞬时的，调用到结果之间几乎无延迟
- 前端只需要处理 input_json_delta 的拼接和 tool_result 的解析

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
/** MCP 资源内容对象 — tool_result 返回的 contents 数组元素 */
interface McpResourceContent {
  /** 资源 URI（如 "test://resource/hello"） */
  uri: string;
  /** MIME 类型（可选，如 "text/plain"、"application/json"、"text/markdown"） */
  mimeType?: string;
  /** 文本内容（文本资源） */
  text?: string;
  /** 二进制内容保存路径（二进制资源，可选） */
  blobSavedTo?: string;
}

/** ReadMcpResourceTool 工具调用块 */
interface ReadMcpResourceBlock {
  type: 'tool_use';
  toolUseId: string;
  toolName: 'ReadMcpResourceTool';
  toolInput: {
    server: string;  // MCP 服务器名称
    uri: string;     // 资源 URI
  };
  toolStatus: 'calling' | 'running' | 'complete' | 'error';
  toolResult?: {
    contents: McpResourceContent[];
  } | string;  // 成功时是对象，失败时是错误字符串
}
```

### 状态机设计

```
[waiting] → content_block_start(tool_use) → [calling]
[calling] → input_json_delta × 5 → [calling] (拼接参数)
[calling] → content_block_stop → [executing]
[executing] → user(tool_result) → [complete] | [error]
```

由于是瞬时工具，`[calling]` → `[complete]` 几乎是瞬间完成。

### 组件模板

```vue
<template>
  <el-card class="mcp-resource-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">
          <el-icon><Connection /></el-icon>
          MCP 资源读取
        </el-tag>
        <el-tag type="info" size="small">
          {{ toolInput?.server }}
        </el-tag>
        <el-tag v-if="status === 'complete'" type="success" size="small">
          完成 ({{ contentType }})
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger" size="small">
          失败
        </el-tag>
        <el-tag v-else-if="status === 'calling'" type="warning" size="small">
          <el-icon class="is-loading"><Loading /></el-icon>
          读取中...
        </el-tag>
      </div>
    </template>

    <!-- URI 信息 -->
    <el-descriptions :column="1" border size="small" class="uri-info">
      <el-descriptions-item label="Server">{{ toolInput?.server }}</el-descriptions-item>
      <el-descriptions-item label="URI">
        <el-text type="primary" size="small" class="uri-text">{{ toolInput?.uri }}</el-text>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 成功：显示资源内容 -->
    <div v-if="status === 'complete' && isSuccessResult" class="resource-content">
      <!-- JSON 内容 -->
      <div v-if="isJsonContent" class="json-content">
        <pre><code>{{ formattedJson }}</code></pre>
      </div>

      <!-- Markdown 内容 -->
      <div v-else-if="isMarkdownContent" class="markdown-content" v-html="renderedMarkdown" />

      <!-- 纯文本内容 -->
      <div v-else class="text-content">
        <pre>{{ resourceText }}</pre>
      </div>
    </div>

    <!-- 错误：显示错误消息 -->
    <el-alert
      v-else-if="status === 'complete' && isErrorMessage"
      type="error"
      :closable="false"
      show-icon
    >
      {{ errorMessage }}
    </el-alert>

    <!-- 调用中 -->
    <div v-else-if="status === 'calling'" class="loading-placeholder">
      <el-skeleton :rows="3" animated />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Connection, Loading } from '@element-plus/icons-vue';
import { marked } from 'marked';

interface Props {
  toolInput?: { server: string; uri: string };
  toolResult?: any;
  status: 'calling' | 'complete' | 'error';
}

const props = defineProps<Props>();

// 判断是否成功结果（有 contents 字段）
const isSuccessResult = computed(() => {
  return props.status === 'complete' &&
         props.toolResult &&
         typeof props.toolResult === 'object' &&
         'contents' in props.toolResult;
});

// 判断是否错误消息（字符串）
const isErrorMessage = computed(() => {
  return props.status === 'complete' &&
         typeof props.toolResult === 'string';
});

// 提取资源内容
const resourceContent = computed(() => {
  if (!isSuccessResult.value) return null;
  const contents = props.toolResult?.contents;
  return Array.isArray(contents) && contents.length > 0 ? contents[0] : null;
});

// MIME 类型
const mimeType = computed(() => resourceContent.value?.mimeType);

// 内容类型显示
const contentType = computed(() => {
  if (!mimeType.value) return 'Unknown';
  const typeMap: Record<string, string> = {
    'text/plain': 'Text',
    'application/json': 'JSON',
    'text/markdown': 'Markdown',
    'text/html': 'HTML',
  };
  return typeMap[mimeType.value] || mimeType.value;
});

// 资源文本
const resourceText = computed(() => resourceContent.value?.text || '');

// 判断是否 JSON
const isJsonContent = computed(() => mimeType.value === 'application/json');

// 判断是否 Markdown
const isMarkdownContent = computed(() => mimeType.value === 'text/markdown');

// 格式化 JSON
const formattedJson = computed(() => {
  if (!isJsonContent.value || !resourceText.value) return '';
  try {
    const parsed = JSON.parse(resourceText.value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return resourceText.value;
  }
});

// 渲染 Markdown
const renderedMarkdown = computed(() => {
  if (!isMarkdownContent.value || !resourceText.value) return '';
  return marked(resourceText.value);
});

// 错误消息
const errorMessage = computed(() => {
  if (isErrorMessage.value) {
    const errorStr = String(props.toolResult);
    // 移除 "Error: " 前缀和重复的错误码
    return errorStr.replace(/^Error:\s*/, '').replace(/MCP error -\d+:\s*/g, '');
  }
  return '';
});

// 状态样式类
const statusClass = computed(() => props.status);

// 状态标签类型
const statusTagType = computed(() =>
  props.status === 'complete' ? 'success' :
  props.status === 'error' ? 'danger' : 'warning'
);
</script>

<style scoped>
.mcp-resource-card {
  margin: 8px 0;
  border-left: 3px solid #409eff;
}

.uri-info {
  margin-bottom: 12px;
}

.uri-text {
  font-family: monospace;
  font-size: 12px;
}

.resource-content {
  padding: 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

.json-content pre,
.text-content pre {
  margin: 0;
  padding: 12px;
  background-color: #282c34;
  color: #abb2bf;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  overflow-x: auto;
}

.markdown-content {
  line-height: 1.6;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin-top: 0;
  margin-bottom: 12px;
}

.markdown-content :deep(p) {
  margin-bottom: 8px;
}

.markdown-content :deep(code) {
  background-color: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
}
</style>
```

### 关键交互处理

ReadMcpResourceTool **不需要用户交互**：
- 无需权限确认（No permission required）
- 无需 canUseTool 回调
- 输入参数简单（server + uri 两个必需参数）
- 执行瞬时，无需进度更新

前端只需处理：
1. **input_json_delta 拼接**：固定 5 次 delta 拼接后 `JSON.parse` 获取 `{server, uri}`
2. **tool_result 解析**：
   - 成功：`{contents: [{uri, mimeType?, text?}]}` 结构化对象
   - 失败：错误字符串，需要清理重复前缀
3. **状态更新**：`calling` → `complete`/`error` 三态
4. **内容渲染**：根据 mimeType 类型选择渲染方式
   - `application/json`：JSON 格式化 + 代码高亮
   - `text/markdown`：Markdown 渲染
   - `text/plain`：纯文本展示
   - 其他 MIME 类型：作为文本展示

## 六、实验数据

### 实验矩阵

| Case | 场景 | MCP 服务器 | input | input_json_delta | tool_result | tool_progress | result |
|------|------|-----------|-------|------------------|-------------|---------------|--------|
| 1 | 读取文本资源 | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/hello"}` | 5 次 | `{contents:[{uri,mimeType,text}]}` | 0 | success |
| 2 | 读取 JSON 资源 | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/config"}` | 5 次 | `{contents:[{uri,mimeType,text}]}` | 0 | success |
| 3 | 读取 Markdown 资源 | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/readme"}` | 5 次 | `{contents:[{uri,mimeType,text}]}` | 0 | success |
| 4 | 读取不存在的 URI | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/nonexistent"}` | 5 次 | `"MCP error -32602: Resource ... not found"` | 0 | success |
| 5 | SSE 前端视角 | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/hello"}` | 5 次 | `{contents:[{uri,mimeType,text}]}` | 0 | success |
| 6 | 关闭流式 | test-mcp-server | `{"server":"test-mcp-server","uri":"test://resource/hello"}` | — | `{contents:[{uri,mimeType,text}]}` | — | success |

### 原始事件样本

#### Case 1 — input_json_delta 推送序列
```
[1] ""                                     ← 空字符串（首 delta）
[2] "{"                                    ← JSON 开始
[3] ""server": "test-mcp-server""          ← server 参数
[4] ", "uri": "test://resource/hello""     ← uri 参数
[5] "}"                                    ← JSON 结束
→ 拼接结果: {"server":"test-mcp-server","uri":"test://resource/hello"}
```

#### Case 1 — tool_result 完整 JSON（成功）
```json
{
  "contents": [
    {
      "uri": "test://resource/hello",
      "mimeType": "text/plain",
      "text": "Hello World from MCP!"
    }
  ]
}
```

#### Case 4 — tool_result 完整内容（失败）
```json
"Error: MCP error -32602: MCP error -32602: Resource test://resource/nonexistent not found"
```

**注意**：失败时 tool_result 是**字符串类型**，不是对象结构。

#### Case 2 — JSON 资源内容
```json
{
  "contents": [
    {
      "uri": "test://resource/config",
      "mimeType": "application/json",
      "text": "{\"name\":\"test-config\",\"version\":\"1.0.0\",\"debug\":true}"
    }
  ]
}
```

#### Case 3 — Markdown 资源内容
```json
{
  "contents": [
    {
      "uri": "test://resource/readme",
      "mimeType": "text/markdown",
      "text": "# Test MCP Server\n\nThis is a test README."
    }
  ]
}
```

## 七、与同类工具的对比

| 特征 | ReadMcpResourceTool | ListMcpResourcesTool | Glob | Grep | Read |
|------|---------------------|---------------------|------|------|------|
| 参数复杂度 | 2 个必需参数 | 1 个可选参数 | 1 个必需参数 | 1+ 个参数 | 1 个必需参数 + 3 个可选 |
| input_json_delta | **固定 5 次** | 3-4 次 | 4 次 | 5-7 次 | 4 次 |
| tool_progress | 0 | 0 | 0 | 0 | 0 |
| tool_result 类型 | 结构化对象/错误字符串 | 结构化对象数组 | 结构化对象 | 结构化对象 | 结构化对象 |
| 需要前置条件 | **需 MCP 服务器** | **需 MCP 服务器** | 无 | 无 | 无 |
| 执行时间 | 瞬时 | 瞬时 | 瞬时 | 瞬时 | 瞬时 |
| 权限要求 | No | No | No | No | No |
| 错误返回 | **字符串**（非结构化） | （未验证） | 结构化对象 | 结构化对象 | 错误字符串 |

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 无 MCP 服务器时调用 | 未测试 | 推断：工具不可用，LLM 报错 |
| 多个 MCP 服务器时的切换 | 未测试 | server 参数应控制从哪个服务器读取 |
| 二进制资源（blobSavedTo） | 未测试 | 测试 MCP 服务器未提供二进制资源 |
| 大文本资源的截断行为 | 未测试 | 未测试资源内容过大时的处理 |
| MCP 服务器连接失败 | 未测试 | tool_result 可能返回错误字符串 |
| 特殊 MIME 类型的渲染 | 未测试 | 如 text/html、application/xml 等 |
| contents 数组多元素情况 | 未测试 | 实际测试中始终是单元素数组 |

## 九、实际应用建议

1. **必须先调用 ListMcpResourcesTool**：在调用 ReadMcpResourceTool 前，应该先用 ListMcpResourcesTool 获取可用的资源列表，确保 URI 有效
2. **错误处理要区分两种格式**：
   - 成功：`tool_result.contents[0].text` 提取内容
   - 失败：`tool_result` 本身是错误字符串
3. **根据 mimeType 选择渲染方式**：
   - `application/json`：JSON 格式化 + 代码高亮
   - `text/markdown`：Markdown 渲染
   - `text/plain`：纯文本
   - 其他：尝试作为文本处理
4. **资源不存在时的用户提示**：应该清理错误消息中的重复前缀（`"Error: "` 和 `"MCP error -32602: "`），只显示核心信息
5. **URI 显示建议用等宽字体**：URI 通常较长且包含特殊字符，用 monospace 字体更清晰
6. **瞬时工具无需进度条**：ReadMcpResourceTool 执行时间极短，不建议显示进度条
7. **缓存资源内容**：如果同一资源可能被多次读取，考虑在前端缓存 contents 内容
