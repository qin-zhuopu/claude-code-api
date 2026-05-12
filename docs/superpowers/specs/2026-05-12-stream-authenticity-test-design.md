# Stream Authenticity Test Design

## Context

`/api/query` 接口通过 SSE 返回流式输出。需要集成测试断言这是真正的逐 token 流式推送，而非各种伪流式手段（后端等完再分块发、批量刷新、攒数据等）。

利用两组时间戳做时序分析：服务端在每个 SSE 事件上打的 `ts`（controller 中 `Date.now()`），以及客户端测试代码收到事件时的 `Date.now()`。

## 数据采集

测试代码发送请求后，不分类型地采集所有 SSE 事件：

```typescript
interface CapturedEvent {
  index: number;       // 第几个 SSE 事件（从 0 开始）
  serverTs: number;    // 服务端的 ts 字段
  clientTs: number;    // 客户端收到时的 Date.now()
  raw: any;            // 完整的 SSE 事件 JSON
}
```

同时记录 `requestStart`（发起请求时间）和 `streamEnd`（收到 done 时间）。

## 断言指标（5 个）

### 1. TTFT 比率

首个 `content_block_delta` + `text_delta` 事件的到达时间占流总时长的比率。

```
(clientTs(firstTextDelta) - requestStart) < totalDuration * 0.4
```

真流式 TTFT 通常在总时长 5-15%，伪流式接近 100%。阈值 40% 留出网络波动余量。

### 2. 事件时间跨度

首个和最后一个 text_delta 事件之间的时间跨度占流总时长的比率。

```
(lastDelta.clientTs - firstDelta.clientTs) > totalDuration * 0.3
```

真流式中事件在生成过程中持续到达，伪流式可能最后才突发。阈值 30%。

### 3. 服务端-客户端延迟方差

对每个 partial 事件计算 `delay = clientTs - serverTs`，取标准差。

```
stddev(all partial delays) < 200ms
```

真流式延迟稳定（网络抖动几十 ms）。后端攒数据批量推会导致某些事件 delay 突然变大，标准差升高。

### 4. 有效 partial 事件数量

```
count(content_block_delta + text_delta events) >= 3
```

至少 3 个 token 级别的流式事件，证明是逐 token 推送而非一次性返回。

### 5. 内容一致性

拼接所有 `text_delta` 的 text，与 result 事件中的 `result` 字段比较（去除首尾空白后）。

```
concat(all text_delta.text).trim() === result.result.trim()
```

确保流式内容与最终结果完全一致。

## 诊断报告

测试不只 pass/fail，还输出诊断报告：

```
📊 流式输出真伪分析报告
═══════════════════════════════════
总事件数: 47
有效 text_delta 事件: 12
thinking_delta 事件: 8

⏱ 时序分析:
  请求开始:     1778456547378
  首 token 到达: 1778456548102  (+724ms, 占总时长 12.3%)
  最后 token:    1778456558890
  流结束:        1778456558901
  总时长:        11523ms

📈 延迟分析 (clientTs - serverTs):
  平均: 12ms
  标准差: 8ms
  最大: 35ms
  最小: 4ms

✅ TTFT 比率: 12.3% < 40% — PASS
✅ 事件跨度: 10788ms > 3457ms (30%) — PASS
✅ 延迟方差: σ=8ms < 200ms — PASS
✅ 最少事件数: 12 >= 3 — PASS
✅ 内容一致性: partial 拼接 === result — PASS
```

## 文件结构

- 新增 `test/integration/stream-authenticity.spec.ts`
- 复用现有 `test/integration/vitest.config.ts`（singleThread, 60s timeout）
- 复用现有 NestJS app 初始化模式（`beforeAll` + `AppModule` + `listen(0)`）
- 测试超时 120s（真实 LLM 调用）

## 复用

- NestJS 测试工具：`@nestjs/testing` 的 `Test.createTestingModule`
- SSE 读取模式：`fetch` + `response.body.getReader()` + `TextDecoder` + buffer 拆行
- Agent 配置：simple agent + haiku model + no tools + `includePartialMessages: true`
- 环境变量：`dotenv.config()` 加载 `.env` 中的 `ANTHROPIC_AUTH_TOKEN` 等
