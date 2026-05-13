# conn-retry: SDK 自动重试行为

## 课题

当配置的大模型接口暂时不可用（连接失败、超时、返回错误信息）时，`@anthropic-ai/claude-agent-sdk` 是否会自动重试？有哪些参数影响自动重试的行为？

## 结论摘要

**是的，SDK 会自动重试。** 连接失败、超时、5xx 服务端错误、529 过载、临时 429 限流等瞬态故障都会触发自动重试，最多重试 10 次（默认），使用指数退避策略（约 2x 增长，上限约 33 秒）。

## 实验数据

### 实验矩阵

| Case | 场景 | CLAUDE_CODE_MAX_RETRIES | API_TIMEOUT_MS | 重试次数 | 总耗时 |
|------|------|------------------------|----------------|----------|--------|
| 1 | 连接拒绝 (ECONNREFUSED) | 默认(10) | 5000 | 10 | ~172s |
| 3 | 连接拒绝 | 2 | 5000 | 2 | ~4s |
| 4 | 连接拒绝 | 0 | 5000 | 0 | ~3s |
| 5 | 连接拒绝 | 1 | 5000 | 1 | ~2s |
| 6 | 超时 (不可达地址) | 2 | 3000 | 2 | ~13s |
| 7 | 连接拒绝 | 5 | 5000 | 5 | ~19s |
| 8a | 连接拒绝 | 1 | 5000 | 1 | ~2s |
| 8b | 超时 | 1 | 3000 | 1 | ~5s |

### 指数退避延迟序列

**Case 1（默认 10 次重试）：**
```
延迟: [513, 1133, 2215, 4129, 8849, 16585, 33687, 33512, 33357, 36536] ms
```

**Case 7（5 次重试）：**
```
延迟: [596, 1050, 2257, 4201, 9005] ms
增长比率: [1.76, 2.15, 1.86, 2.14]
```

### 退避算法特征

| 特征 | 观察值 |
|------|--------|
| 基础延迟 | ~500-600ms（含随机抖动） |
| 增长因子 | ~2x（1.76 - 2.32，含 jitter） |
| 延迟上限 (cap) | ~33-36 秒 |
| 达到 cap 的 attempt | 第 7 次（约 33s） |
| Jitter | 有，每次延迟有随机偏移 |

## 关键发现

### 1. 重试机制确认

SDK 内置自动重试，通过 `SDKAPIRetryMessage` 事件通知调用方：

```typescript
type SDKAPIRetryMessage = {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;        // 当前重试次数（从 1 开始）
  max_retries: number;    // 最大重试次数
  retry_delay_ms: number; // 本次等待延迟（毫秒）
  error_status: number | null;  // HTTP 状态码，连接错误为 null
  error: SDKAssistantMessageError;  // 错误分类
};
```

### 2. 触发重试的错误类型

根据官方文档（errors.md）和实验验证：

| 错误类型 | error_status | error 字段 | 是否重试 |
|----------|-------------|-----------|---------|
| 连接拒绝 (ECONNREFUSED) | null | 'unknown' | ✅ |
| 连接超时 (ETIMEDOUT) | null | 'unknown' | ✅ |
| 服务端错误 (500) | 500 | 'server_error' | ✅ (文档) |
| 过载 (529) | 529 | - | ✅ (文档) |
| 临时限流 (429) | 429 | 'rate_limit' | ✅ (文档) |
| 认证失败 (401) | - | 'authentication_failed' | ❌ |
| 无效请求 (400) | - | 'invalid_request' | ❌ |
| 计费错误 | - | 'billing_error' | ❌ |

### 3. 影响重试行为的参数

#### `CLAUDE_CODE_MAX_RETRIES`（环境变量）

| 值 | 效果 |
|----|------|
| 未设置 | 默认 10 次重试 |
| `0` | 完全禁用重试，立即失败 |
| `1` | 只重试 1 次 |
| `N` | 最多重试 N 次 |

**实验验证：** 设置为 0 时无 `api_retry` 事件，设置为 2 时恰好 2 次重试，`max_retries` 字段准确反映设置值。

#### `API_TIMEOUT_MS`（环境变量）

| 值 | 效果 |
|----|------|
| 未设置 | 默认 600000ms (10 分钟) |
| `3000` | 3 秒超时 |
| `5000` | 5 秒超时 |

**作用范围：** 控制单次 HTTP 请求的超时时间。超时后触发重试（如果还有重试次数）。**不影响重试延迟本身**（延迟由退避算法决定）。

**实验验证：** Case 6 中 `API_TIMEOUT_MS=3000` 配合不可达地址，每次请求等待 3 秒后超时，然后按退避延迟等待后重试。总耗时 = (N+1) × timeout + Σ(delays)。

#### `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`（环境变量）

当流式请求中途失败时，SDK 默认会回退到非流式请求重试。设置为 `1` 可禁用此行为，让流式错误直接进入重试层。

### 4. 重试期间的请求行为

- 每次重试都会重新发送完整的 API 请求（从日志中可见多个 `.request.json` 文件）
- 请求内容完全相同（相同的 messages、system prompt、tools 等）
- 不会累积之前的错误信息到请求中

### 5. 最终失败的错误消息

重试耗尽后，SDK 返回的错误消息格式：

| 错误类型 | 最终错误消息 |
|----------|-------------|
| 连接拒绝 | `API Error: Unable to connect to API (ConnectionRefused)` |
| 超时 | `Request timed out` |
| 重复 529 | `API Error: Repeated 529 Overloaded errors` |

### 6. SDK 消息流中的重试事件位置

正常消息流：`system:init` → `system:status` → `system:api_retry` (×N) → `assistant` → `result:success`

重试事件穿插在 `init` 和最终结果之间，调用方可以实时监听重试进度。

## 退避算法推断

基于多次实验数据，推断 SDK 使用的退避算法为：

```
delay = min(base * 2^(attempt-1) + jitter, cap)

其中：
- base ≈ 500ms
- jitter ≈ ±100ms (随机)
- cap ≈ 33000ms (~33 秒)
- 增长因子 = 2
```

实际延迟序列（5 次重试典型值）：
```
attempt 1: ~530ms  (500 * 2^0 + jitter)
attempt 2: ~1100ms (500 * 2^1 + jitter)
attempt 3: ~2100ms (500 * 2^2 + jitter)
attempt 4: ~4300ms (500 * 2^3 + jitter)
attempt 5: ~9000ms (500 * 2^4 + jitter)
```

## 实际应用建议

### 场景 1：CI/CD 脚本中快速失败

```bash
CLAUDE_CODE_MAX_RETRIES=2  # 只重试 2 次
API_TIMEOUT_MS=10000       # 10 秒超时
```

总最大等待时间 ≈ 3 × 10s + 0.5s + 1.1s ≈ 32s

### 场景 2：生产环境容忍短暂故障

```bash
CLAUDE_CODE_MAX_RETRIES=5  # 重试 5 次
API_TIMEOUT_MS=30000       # 30 秒超时
```

总最大等待时间 ≈ 6 × 30s + (0.5 + 1.1 + 2.1 + 4.3 + 9.0)s ≈ 197s

### 场景 3：完全禁用重试（调试用）

```bash
CLAUDE_CODE_MAX_RETRIES=0
```

### 场景 4：慢速网络/代理

```bash
API_TIMEOUT_MS=1200000     # 20 分钟超时
CLAUDE_CODE_MAX_RETRIES=3  # 减少重试次数以控制总时间
```

## 监听重试事件

SDK 调用方可以通过 async iterator 实时监听重试事件：

```typescript
for await (const message of sdkQuery) {
  if (message.type === 'system' && message.subtype === 'api_retry') {
    console.log(
      `重试 ${message.attempt}/${message.max_retries}, ` +
      `等待 ${message.retry_delay_ms}ms, ` +
      `错误: ${message.error_status || 'connection'}`
    );
  }
}
```

## 测试文件

`test/integration/conn-retry.spec.ts` — 8 个 case，覆盖连接拒绝、超时、重试次数控制、指数退避验证。

## 未验证项（需要 mock server）

- HTTP 500 返回时的 `error_status` 和 `error` 字段具体值
- HTTP 529 返回时的重试行为
- HTTP 429 返回时是否区分 "临时限流" 和 "配额耗尽"
- 流式传输中途断开时的 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 效果
- 重试期间如果服务恢复，是否能成功完成请求
