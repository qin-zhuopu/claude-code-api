# OTEL 日志选项行为实验报告

## 实验目标

验证 `OTEL_LOG_RAW_API_BODIES`、`OTEL_LOG_TOOL_CONTENT`、`OTEL_LOG_TOOL_DETAILS`、`OTEL_LOG_USER_PROMPTS` 四个环境变量对 SDK 日志输出的实际影响。

## 实验环境

- SDK: `@anthropic-ai/claude-agent-sdk`
- 后端: `http://10.1.3.115:4000` (Qwen3.5-9B)
- 测试文件: `test/integration/otel-log-options.spec.ts`
- 日期: 2026-05-13

## 核心发现

### 结论：`OTEL_LOG_TOOL_CONTENT`、`OTEL_LOG_TOOL_DETAILS`、`OTEL_LOG_USER_PROMPTS` 在 `file:` 模式下无效

这三个变量 **不影响** `OTEL_LOG_RAW_API_BODIES=file:<dir>` 产出的文件内容。

它们控制的是 **OTLP span/log 导出**（发送到 `OTEL_EXPORTER_OTLP_ENDPOINT` 的遥测数据），而非本地文件 dump。

### 变量作用域

| 变量 | 作用域 | 说明 |
|------|--------|------|
| `OTEL_LOG_RAW_API_BODIES` | **本地文件** | `file:<dir>` 模式将完整 request/response JSON 写入指定目录 |
| `OTEL_LOG_TOOL_CONTENT` | OTLP 导出 | 控制 OTLP span 中是否包含工具输入/输出内容 |
| `OTEL_LOG_TOOL_DETAILS` | OTLP 导出 | 控制 OTLP span 中是否包含工具定义（input_schema） |
| `OTEL_LOG_USER_PROMPTS` | OTLP 导出 | 控制 OTLP span 中是否包含用户 prompt 文本 |

## 实验矩阵

| Case | 变量组合 | req 文件数 | req 大小 | 结果 |
|------|---------|-----------|---------|------|
| 1 | 仅 `OTEL_LOG_RAW_API_BODIES` | 1 | ~77KB | 基线：完整 request/response |
| 2 | + `OTEL_LOG_USER_PROMPTS=false` | 1 | ~77KB | **无差异** — 用户 prompt 仍完整存在 |
| 3 | + `OTEL_LOG_USER_PROMPTS=true` | 1 | ~77KB | 与基线一致 |
| 4 | + `OTEL_LOG_TOOL_DETAILS=false` | 1 | ~77KB | **无差异** — tools 定义仍完整存在 |
| 5 | + `OTEL_LOG_TOOL_DETAILS=true` | 1 | ~77KB | 与基线一致 |
| 6 | + `OTEL_LOG_TOOL_CONTENT=false` (工具调用) | 2 | ~157KB | **无差异** — tool_result content 仍完整 |
| 7 | + `OTEL_LOG_TOOL_CONTENT=true` (工具调用) | 2 | ~157KB | 与 case-6 一致 |
| 8 | 全部 `false` (工具调用) | 2 | ~157KB | **无差异** — 所有内容仍完整 |
| 9 | 全部 `true` (工具调用) | 2 | ~157KB | 与 case-8 一致 |
| 10 | 不设 `OTEL_LOG_RAW_API_BODIES` | 0 | 0 | 无文件产出 |

## 详细观察

### `OTEL_LOG_RAW_API_BODIES=file:<dir>`

- **唯一控制文件输出的变量**
- 不设置时，不产出任何文件（case-10 验证）
- 设置后，每次 API 调用产出一对文件：`<uuid>.request.json` + `<uuid>.response.json`
- 多轮对话（工具调用）产出多对文件（case-6~9 各产出 2 对）
- 文件内容是 **完整的原始 API body**，不受其他变量影响

### Request 文件结构

```json
{
  "model": "Jereh-LLM-NO-THINK-V1",
  "messages": [...],          // 完整的消息历史
  "system": [...],            // system prompt 数组
  "tools": [...],             // 23 个工具定义（含完整 input_schema）
  "betas": [...],
  "metadata": {...},
  "max_tokens": 16384,
  "thinking": {...},
  "context_management": {...},
  "output_config": {...},
  "stream": true
}
```

### Response 文件结构

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [...],           // text 或 tool_use blocks
  "model": "Qwen3.5-9B",
  "stop_reason": "end_turn",  // 或 "tool_use"
  "usage": {...}
}
```

### 多轮对话流程（工具调用场景）

1. **第一个 request**: 用户 prompt → 模型
2. **第一个 response**: `stop_reason: "tool_use"`，content 含 `tool_use` block
3. **第二个 request**: 包含 `tool_result` 消息（工具执行结果）
4. **第二个 response**: `stop_reason: "end_turn"`，最终文本回复

## 实际应用建议

### 对 SDK 封装 Agent 的意义

1. **调试/观察用途**：只需设置 `OTEL_LOG_RAW_API_BODIES=file:<dir>` 即可获得完整的请求/响应日志，无需关心其他三个变量
2. **隐私合规场景**：如果需要在 OTLP 导出中脱敏用户数据，使用 `OTEL_LOG_USER_PROMPTS=false` + `OTEL_LOG_TOOL_CONTENT=false`
3. **减少 OTLP 数据量**：`OTEL_LOG_TOOL_DETAILS=false` 可减少 span 中的工具定义数据

### 推荐配置

```typescript
// 开发调试：完整本地日志
env: {
  OTEL_LOG_RAW_API_BODIES: `file:${logDir}`,
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
}

// 生产环境：OTLP 导出但脱敏
env: {
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://your-collector:4318',
  OTEL_LOG_USER_PROMPTS: 'false',
  OTEL_LOG_TOOL_CONTENT: 'false',
  OTEL_LOG_TOOL_DETAILS: 'false',
}

// 生产环境：OTLP 导出 + 本地完整日志
env: {
  OTEL_LOG_RAW_API_BODIES: `file:${logDir}`,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://your-collector:4318',
  OTEL_LOG_USER_PROMPTS: 'false',   // OTLP 脱敏
  OTEL_LOG_TOOL_CONTENT: 'false',   // OTLP 脱敏
  // file: 模式仍然输出完整内容，不受上面两个变量影响
}
```

## 测试执行

```bash
# 跑全部 10 个 case
npx vitest run test/integration/otel-log-options.spec.ts

# 跑单个 case
npx vitest run test/integration/otel-log-options.spec.ts -t "case-1"

# 跑工具调用相关 case
npx vitest run test/integration/otel-log-options.spec.ts -t "case-6|case-7|case-8|case-9"
```
