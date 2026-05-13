# ListMcpResourcesTool 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-listmcpresources.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | `{ server?: string }` — 唯一可选参数，用于按服务器名过滤 |
| tool_result 结构 | `{ uri, name, mimeType?, description?, server }[]` — 资源对象数组 |
| stream_event 总数 | ~134 个（case-1，2 轮 API 调用） |
| tool_progress 推送次数 | **0** — 瞬时工具，无执行时间 |
| 状态更新频率 | 无 tool_progress、无 tool_use_summary |
| input_json_delta 次数 | 不带参数时 3 次，带 server 参数时 4 次 |
| 前置条件 | **必须至少配置 1 个 MCP 服务器**，否则工具不可用 |
| num_turns | 固定 2 轮（调用 + 结果回复） |

## 一、tool_use 调用格式

### input_schema（来自 SDK 类型定义 `sdk-tools.d.ts`）

```typescript
interface ListMcpResourcesInput {
  /** Optional server name to filter resources by */
  server?: string;
}
```

### 实际 input 示例

**不带参数（列出所有资源）**：
```json
{}
```

**带 server 参数（过滤指定服务器）**：
```json
{
  "server": "test-mcp-server"
}
```

### input_json_delta 推送模式

| 场景 | 推送次数 | 推送序列 |
|------|----------|----------|
| 无参数 `{}` | 3 次 | `""` → `"{"` → `"}"` |
| 带 server 参数 | 4 次 | `""` → `"{"` → `"server": "test-mcp-server"` → `"}"` |

### 前置条件（重要）

`ListMcpResourcesTool` **只在至少配置了 1 个 MCP 服务器时才可用**。测试中需要通过 `mcpServers` 选项传入 MCP 服务器配置：

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

当无 MCP 服务器时，LLM 会回复：*"The tool ListMcpResourcesTool exists but is not enabled in this context."*

## 二、tool_result 返回值格式

### 完整结构（来自 user 消息的 tool_result）

**成功 — 有资源时**：

```json
{
  "tool_use_result": [
    {
      "name": "hello",
      "uri": "test://resource/hello",
      "description": "A simple hello world resource",
      "mimeType": "text/plain",
      "server": "test-mcp-server"
    },
    {
      "name": "config",
      "uri": "test://resource/config",
      "description": "Test configuration JSON",
      "mimeType": "application/json",
      "server": "test-mcp-server"
    },
    {
      "name": "readme",
      "uri": "test://resource/readme",
      "description": "Test README document",
      "mimeType": "text/markdown",
      "server": "test-mcp-server"
    }
  ],
  "parent_tool_use_id": null,
  "messageContentTypes": [
    {
      "type": "tool_result",
      "tool_use_id": "call_c4ecda15c37c4e0b8d1e320e",
      "contentType": "string",
      "contentSnippet": "[{\"name\":\"hello\",...}]"
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool_use_result` | `Array<{uri, name, mimeType?, description?, server}>` | 资源对象数组，与 SDK 类型定义 `ListMcpResourcesOutput` 完全匹配 |
| `parent_tool_use_id` | `string \| null` | 通常为 null（非嵌套调用时） |
| `messageContentTypes` | `Array<{type, tool_use_id, contentType, contentSnippet}>` | user 消息 content 的元信息 |

### tool_result 在 user 消息 content 中的表现

在 `message.content` 中，tool_result 的 `content` 字段是 **string** 类型（JSON 序列化的资源数组）：

```json
{
  "type": "tool_result",
  "tool_use_id": "call_0ba2565423af499f9b9e5beb",
  "content": "[{\"name\":\"hello\",\"uri\":\"test://resource/hello\",...}]"
}
```

需要 `JSON.parse(content)` 获取资源数组。

## 三、流式事件序列

### 完整时间线（case-1：不带参数）

```
[  0] system (init)                    ← 会话初始化（含 MCP 服务器连接）
[  1] system (status)                  ← 状态更新

── 第 1 轮 API 调用（思考 + 工具调用）──
[  2] stream_event → message_start     ← 第 1 轮 API 调用开始
[  3-?] stream_event → thinking_delta  ← 思考内容流式推送
[  ?] stream_event → content_block_start (tool_use: ListMcpResourcesTool)
[  ?] stream_event → input_json_delta × 3  ← 工具参数推送: "" → "{" → "}"
[  ?] stream_event → content_block_stop
[  ?] assistant (tool_use: ListMcpResourcesTool)  ← 完整 tool_use block
[  ?] stream_event → message_delta
[  ?] stream_event → message_stop

── SDK 自动执行 ListMcpResourcesTool ──
[  ?] user (tool_result)               ← 资源数组作为 user 消息

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
| 1 | 不带参数 | 3 | 134 | 2 | 1 | 1 | 2 |
| 2 | 带 server 参数 | ~3 | ~130 | 2 | 1 | 1 | 2 |
| 3 | 纯文本基线 | ~2 | ~50 | 2 | 0 | 1 | 1 |
| 4 | SSE 前端视角 | 3 | 127 | 2 | 1 | 1 | 2 |

## 四、状态更新机制

### tool_progress 推送分析

**结论：ListMcpResourcesTool 是瞬时工具，不产生任何 tool_progress 事件。**

- 所有测试 case 中 tool_progress 数量均为 **0**
- 这是因为 ListMcpResourcesTool 只是查询已连接 MCP 服务器的资源列表，不涉及长时间运行的操作
- 与 Glob、Grep 等瞬时工具行为一致

### SDK 推送频率统计

| 事件类型 | Case 1 | Case 2 | Case 3 (基线) |
|----------|--------|--------|---------------|
| tool_progress | 0 | 0 | 0 |
| tool_use_summary | 0 | 0 | 0 |
| system (status) | 1 | 1 | 1 |

### 是否需要不断修改前端状态？

**不需要。** ListMcpResourcesTool 的调用过程中：
- ✅ `input_json_delta` 只有 3-4 次推送，开销极小
- ✅ 无 `tool_progress` 事件，不需要更新进度条
- ✅ 无 `tool_use_summary` 事件
- ✅ 工具执行是瞬时的，调用到结果之间几乎无延迟
- 前端只需要处理 input_json_delta 的拼接和 tool_result 的解析

## 五、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
/** MCP 资源对象 — tool_result 返回的数组元素 */
interface McpResource {
  /** 资源 URI（如 "test://resource/hello"） */
  uri: string;
  /** 资源名称（如 "hello"） */
  name: string;
  /** MIME 类型（可选，如 "text/plain"、"application/json"） */
  mimeType?: string;
  /** 资源描述 */
  description?: string;
  /** 提供该资源的服务器名称 */
  server: string;
}

/** ListMcpResourcesTool 工具调用块 */
interface ListMcpResourcesBlock {
  type: 'tool_use';
  toolUseId: string;
  toolName: 'ListMcpResourcesTool';
  toolInput: {
    server?: string;  // 可选的服务器过滤参数
  };
  toolStatus: 'calling' | 'running' | 'complete' | 'error';
  toolResult?: McpResource[];  // 工具执行后填充
}
```

### 状态机设计

```
[waiting] → content_block_start(tool_use) → [calling]
[calling] → input_json_delta × N → [calling] (拼接参数)
[calling] → content_block_stop → [executing]
[executing] → user(tool_result) → [complete]
```

由于是瞬时工具，`[calling]` → `[complete]` 几乎是瞬间完成。

### 组件模板

```vue
<template>
  <el-card class="mcp-resources-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">
          <el-icon><Connection /></el-icon>
          MCP 资源列表
        </el-tag>
        <el-tag v-if="toolInput?.server" type="info" size="small">
          服务器: {{ toolInput.server }}
        </el-tag>
        <el-tag v-if="status === 'complete'" type="success" size="small">
          完成 ({{ resourceCount }} 个资源)
        </el-tag>
        <el-tag v-else-if="status === 'calling'" type="warning" size="small">
          <el-icon class="is-loading"><Loading /></el-icon>
          查询中...
        </el-tag>
      </div>
    </template>

    <!-- 资源列表 -->
    <el-table v-if="resources.length > 0" :data="resources" stripe size="small">
      <el-table-column prop="name" label="名称" width="120" />
      <el-table-column prop="uri" label="URI" min-width="200">
        <template #default="{ row }">
          <el-text type="primary" size="small" class="uri-text">{{ row.uri }}</el-text>
        </template>
      </el-table-column>
      <el-table-column prop="mimeType" label="类型" width="150">
        <template #default="{ row }">
          <el-tag v-if="row.mimeType" size="small" type="info">{{ row.mimeType }}</el-tag>
          <el-text v-else type="info" size="small">—</el-text>
        </template>
      </el-table-column>
      <el-table-column prop="description" label="描述" min-width="200" />
      <el-table-column prop="server" label="服务器" width="140" />
    </el-table>

    <!-- 无资源 -->
    <el-empty v-else-if="status === 'complete'" description="没有可用的 MCP 资源" />

    <!-- 调用中 -->
    <div v-else-if="status === 'calling'" class="loading-placeholder">
      <el-skeleton :rows="3" animated />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Connection, Loading } from '@element-plus/icons-vue';

interface Props {
  toolInput?: { server?: string };
  toolResult?: any;
  status: 'calling' | 'complete' | 'error';
}

const props = defineProps<Props>();

const resources = computed<McpResource[]>(() => {
  if (Array.isArray(props.toolResult)) return props.toolResult;
  if (typeof props.toolResult === 'string') {
    try { return JSON.parse(props.toolResult); } catch { return []; }
  }
  return [];
});

const resourceCount = computed(() => resources.value.length);
const statusClass = computed(() => props.status);
const statusTagType = computed(() =>
  props.status === 'complete' ? 'success' :
  props.status === 'error' ? 'danger' : 'warning'
);
</script>

<style scoped>
.mcp-resources-card {
  margin: 8px 0;
  border-left: 3px solid #409eff;
}
.uri-text {
  font-family: monospace;
  font-size: 12px;
}
</style>
```

### 关键交互处理

ListMcpResourcesTool **不需要用户交互**：
- 无需权限确认（No permission required）
- 无需 canUseTool 回调
- 输入参数简单（可选的 server 过滤）
- 执行瞬时，无需进度更新

前端只需处理：
1. **input_json_delta 拼接**：3-4 次 delta 拼接后 `JSON.parse` 获取 `{server?: string}`
2. **tool_result 解析**：直接是 `McpResource[]` 数组（或 JSON 字符串需要 parse）
3. **状态更新**：`calling` → `complete` 两态即可

## 六、实验数据

### 实验矩阵

| Case | 场景 | MCP 服务器 | input | input_json_delta | tool_result | tool_progress | result |
|------|------|-----------|-------|------------------|-------------|---------------|--------|
| 1 | 不带参数 | test-mcp-server | `{}` | 3 次 | 3 个资源对象 | 0 | success |
| 2 | 带 server 参数 | test-mcp-server | `{"server":"test-mcp-server"}` | 4 次 | 3 个资源对象 | 0 | success |
| 3 | 纯文本基线 | test-mcp-server | — | 0 | — | 0 | success |
| 4 | SSE 前端视角 | test-mcp-server | `{}` | 3 次 | 3 个资源对象 | 0 | success |
| 5 | 关闭流式 | test-mcp-server | `{}` | — | 3 个资源对象 | — | success |
| 6 | 无 MCP 服务器 | 无 | — | 0 | 工具不可用 | — | success |

### 原始事件样本

#### Case 1 — input_json_delta 推送序列
```
[1] ""                                     ← 空字符串（首 delta）
[2] "{"                                    ← JSON 开始
[3] "}"                                    ← JSON 结束
→ 拼接结果: "{}"
```

#### Case 2 — input_json_delta 推送序列（带 server 参数）
```
[1] ""                                     ← 空字符串
[2] "{"                                    ← JSON 开始
[3] "server": "test-mcp-server"            ← 参数键值
[4] "}"                                    ← JSON 结束
→ 拼接结果: `{"server":"test-mcp-server"}`
```

#### Case 1 — tool_result 完整 JSON
```json
[
  {
    "name": "hello",
    "uri": "test://resource/hello",
    "description": "A simple hello world resource",
    "mimeType": "text/plain",
    "server": "test-mcp-server"
  },
  {
    "name": "config",
    "uri": "test://resource/config",
    "description": "Test configuration JSON",
    "mimeType": "application/json",
    "server": "test-mcp-server"
  },
  {
    "name": "readme",
    "uri": "test://resource/readme",
    "description": "Test README document",
    "mimeType": "text/markdown",
    "server": "test-mcp-server"
  }
]
```

## 七、与同类工具的对比

| 特征 | ListMcpResourcesTool | Glob | Grep | CronList |
|------|---------------------|------|------|----------|
| 参数复杂度 | 1 个可选参数 | 1 个必需参数 | 1+ 个参数 | 0 个参数 |
| input_json_delta | 3-4 次 | 4 次 | 5-7 次 | 3 次 |
| tool_progress | 0 | 0 | 0 | 0 |
| tool_result 类型 | 结构化对象数组 | 结构化对象 | 结构化对象 | 结构化对象 |
| 需要前置条件 | **需 MCP 服务器** | 无 | 无 | 无 |
| 执行时间 | 瞬时 | 瞬时 | 瞬时 | 瞬时 |
| 权限要求 | No | No | No | No |

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 无 MCP 服务器时调用 | 已验证 | 工具不可用，LLM 报错 |
| 多个 MCP 服务器时的过滤效果 | 未测试 | server 参数应只返回匹配服务器的资源 |
| 大量资源时的返回格式 | 未测试 | 未测试资源数超过上限时的行为 |
| 空 MCP 服务器（连接但无资源） | 未测试 | 可能返回空数组 `[]` |
| MCP 服务器连接失败 | 未测试 | tool_result 可能返回错误字符串 |
| `mimeType` 缺失时 | 已验证 | `mimeType` 为可选字段，部分资源无此字段 |
| SSE 中 content 字段格式 | 已验证 | user 消息 content 为 JSON 字符串，需 parse |
