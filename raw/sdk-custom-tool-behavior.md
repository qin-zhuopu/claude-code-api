# SDK Custom Tool 观察性测试

## 核心发现

| 发现 | 结论 |
|------|------|
| 自定义 tool 在 API 请求中的位置 | 以 `mcp__{serverName}__{toolName}` 命名，追加在内置 tool 列表末尾 |
| tools=[] + 自定义 tool | 请求只包含 1 个 tool（自定义），所有内置 tool 被清除 |
| 自定义 tool 的 handler | 进程内执行，LLM 调用后 handler 直接返回结果 |
| annotations 在 API 请求中 | **不出现**——tool 定义只有 `name`, `description`, `input_schema` 三个字段 |
| tool 注册但不用 | 仍然出现在 tools 列表中（始终加载） |
| input_schema 结构 | 从 Zod schema 自动推导，包含 `$schema`, `type`, `properties`, `required` |

## 实验矩阵

| Case | 配置 | tools count | 自定义 tool 在列表 | LLM 调用 tool | 请求轮数 |
|------|------|------------|-------------------|--------------|---------|
| 1 基线 | 无自定义 tool | 23 | ❌ | - | 1 |
| 2 注册+调用 | mcpServers + allowedTools | 24 (23+1) | ✅ | ✅ Echo: hello-world | 2 |
| 3 tools=[] | 禁用内置 + 自定义 | **1** | ✅（唯一） | ❌ | 1 |
| 4 annotations | readOnlyHint=true | 24 | ✅ | ❌ | 1 |
| 5 注册不用 | mcpServers + allowedTools | 24 | ✅ | ❌ | 1 |

## 详细发现

### 1. Tool 命名格式

```
SDK 注册: createSdkMcpServer({ name: 'test-echo', tools: [echoTool] })
API 请求中: mcp__test-echo__echo
```

格式固定为 `mcp__{serverName}__{toolName}`，双下划线分隔。

### 2. tools=[] 精确清除内置 tool

Case 3 中 `tools: []` + `mcpServers` 的组合：
- 请求的 `tools` 数组**恰好 1 个元素**：`mcp__test-echo__echo`
- 所有 23 个内置 tool 全部消失
- system blocks 仍为 2（不受 tools=[] 影响）
- 请求 unique keys 从 102 降到 26（少了大量内置 tool 的 input_schema 关键字）

这证实了文档说法：`tools: []` 移除所有内置 tool，MCP tool 不受影响。

### 3. Handler 进程内执行

Case 2 中 LLM 调用了 `mcp__test-echo__echo` tool：
- 第一轮：LLM 返回 `tool_use` block，input 为 `{ text: "hello-world" }`
- Handler 在 Node.js 进程内执行，返回 `Echo: hello-world`
- 第二轮：LLM 收到 tool_result 后回复文本
- 整个过程不 spawn 额外进程（区别于 stdio MCP server）

### 4. Annotations 不出现在 API 请求中

Case 4 注册了 `annotations: { readOnlyHint: true, destructiveHint: false }` 的 tool。
API 请求中该 tool 的 keys 只有：
```
name, description, input_schema
```
没有 `annotations` 也没有 `_meta` 字段。

这意味着 **annotations 是 SDK/MCP 侧的行为提示**（控制并行调用、tool search 等），不会发送给 Anthropic API 的 Messages 端点。模型看不到 annotations。

### 5. Tool 始终加载

Case 5 中 prompt 是 "say no-tool-needed"，LLM 没有调用自定义 tool，但 `mcp__test-echo__echo` 仍然出现在请求的 tools 列表中（tools count 24 = 23 内置 + 1 自定义）。

这与文档说的 `alwaysLoad` 行为一致——不使用 tool search 时，所有 tool 始终在 context 中。

### 6. input_schema 完整结构

自定义 tool 的 `input_schema` 从 Zod schema 自动推导：
```json
{
  "$schema": "https://...",
  "type": "object",
  "properties": {
    "text": {
      "description": "The text to echo back",
      "type": "string"
    }
  },
  "required": ["text"]
}
```

`.describe()` 的内容出现在 `properties.text.description` 中。`.default()` 的字段不出现在 `required` 中。

## 实际应用建议

### 最小自定义 tool 模板

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const myTool = tool('my_tool', '描述', { query: z.string() }, async (args) => ({
  content: [{ type: 'text', text: `结果: ${args.query}` }],
}));

const server = createSdkMcpServer({ name: 'my', tools: [myTool] });

// 使用
query({ prompt: '...', options: {
  mcpServers: { my: server },
  allowedTools: ['mcp__my__my_tool'],
}});
```

### 纯自定义 tool（无内置）

```typescript
query({ prompt: '...', options: {
  tools: [],                              // 移除所有内置 tool
  mcpServers: { my: server },             // 只保留自定义
  allowedTools: ['mcp__my__my_tool'],
}});
```

### 注意事项

- `allowedTools` 列表必须使用 `mcp__{server}__{tool}` 全名，不支持通配符（只有 `mcp__server__*`）
- Handler 中不要 throw，用 `isError: true` 返回错误（保持 agent loop）
- Annotations 不影响模型行为，只影响 SDK 侧的 tool search 和并行调度

## 未验证行为

- `structuredContent` 返回值在日志中的体现
- `image`/`resource` 返回类型的 tool_result 格式
- `alwaysLoad: false`（tool search）的行为
- `searchHint` 字段的作用
- 多个 mcpServers（多个 server）的组合
- `isError: true` 的 tool_result 在日志中的格式差异
- `bypassPermissions` + 自定义 tool 的权限流

## 测试文件

`test/integration/sdk-custom-tool.spec.ts`（5 cases）
