# 会话复用方法行为观察

## 核心发现摘要

| 方法 | 状态 | 第二轮耗时 (相对第一轮) | 会话 ID 变化 | 适用场景 | 性能提升 |
|------|------|------------------------|-------------|----------|----------|
| **continue** | ✅ 稳定 | -4,295ms (快 42%) | 相同 | 单用户应用，自动复用最近会话 | ⭐⭐⭐⭐⭐ |
| **resume** | ✅ 稳定 | -5,710ms (快 53%) | 相同 | 多用户应用，精确恢复指定会话 | ⭐⭐⭐⭐⭐ |
| **forkSession** | ✅ 稳定 | +15,206ms (慢 122%) | 不同 | 探索性分支，保留原会话 | ⭐⭐ |
| **单次 query 多轮** | ✅ 稳定 | 总耗时 7,888ms (2轮) | 相同 | 批量处理，自动化流程 | ⭐⭐⭐⭐⭐ |
| **V2 session API** | ❌ 已弃用 | N/A | N/A | 不应再使用 | - |
| **bridge/perpetual** | ⚠️ 实验性 | N/A | N/A | 仅 claude.ai 集成 | ⭐ |

> 耗时数据基于实际测试，第一轮耗时 10,301ms (continue)、10,806ms (resume)、12,468ms (fork)

## 实验矩阵

### Case 1: 基线 - 创建新会话的性能
- **目的**: 建立性能基准
- **结果**: 7,139ms，51 个事件
- **观察**: 每次创建新会话都有固定的启动开销

### Case 2: continue 方式复用最近会话
- **配置**: 第二轮设置 `continue: true`
- **结果**:
  - 第一轮: 10,301ms
  - 第二轮: 6,006ms (-4,295ms，快 42%)
  - Session ID 相同: ✅
  - 记住名字: ✅
- **关键发现**:
  - 无需跟踪 session ID，自动复用最近会话
  - 显著减少启动开销
  - 适合单用户应用

### Case 3: resume 方式复用指定会话
- **配置**: 第二轮设置 `resume: sessionId`
- **结果**:
  - 第一轮: 10,806ms
  - 第二轮: 5,096ms (-5,710ms，快 53%)
  - Session ID 相同: ✅
  - 记住名字: ✅
- **关键发现**:
  - 精确指定要复用的会话
  - 性能提升最大（53%）
  - 适合多用户应用

### Case 4: forkSession 创建分支会话
- **配置**: 第二轮设置 `resume: sessionId, forkSession: true`
- **结果**:
  - 第一轮: 12,468ms
  - 第二轮: 27,674ms (+15,206ms，慢 122%)
  - Session ID 不同: ✅
  - 原始会话存在: ✅
- **关键发现**:
  - 创建新会话 ID，保留原会话
  - 需要复制会话历史，开销较大
  - 适合探索不同方案的场景

### Case 5: 单次 query 内多轮对话
- **配置**: 使用 async generator 传递多轮对话
- **结果**:
  - 总耗时: 7,888ms (2 轮对话)
  - 平均每轮: 3,944ms
  - 96 个事件
- **关键发现**:
  - 最快速的方式，避免进程重启
  - 需要提前知道所有问题
  - 适合批量处理

### Case 6-7: 不稳定/弃用方法分析
- **V2 session API**: 官方已弃用，推荐使用 V1 query + session options
- **bridge/perpetual**: @alpha 标记，仅用于 claude.ai 集成，API 不稳定

## 详细发现

### 1. continue vs resume 性能对比

虽然两者都避免了进程重启，但 **resume 稍快一些**：
- continue: -4,295ms (42% 提升)
- resume: -5,710ms (53% 提升)

可能原因：
- `continue` 需要扫描目录查找最近会话
- `resume` 直接使用指定的 session ID

### 2. forkSession 的性能开销

forkSession 需要：
1. 读取原始会话的完整历史
2. 复制并重新映射所有消息 UUID
3. 写入新的会话文件

这导致 **第二轮比第一轮慢 122%**，不适合高频复用场景。

### 3. 单次 query 多轮对话的性能优势

这是**最快的方案**：
- 平均每轮 3,944ms
- 相比第一轮创建新会话 (7,139ms) 快 45%
- 完全避免进程重启开销

限制：
- 需要提前知道所有问题
- 不适合交互式场景

### 4. 会话 ID 行为

| 方法 | Session ID 行为 |
|------|----------------|
| continue | 保持不变，复用最近会话 |
| resume | 保持不变，复用指定会话 |
| forkSession | 创建新 ID，原 ID 保持有效 |
| 单次 query 多轮 | 保持不变，同一会话内 |

## 实际应用建议

### 场景 1: 单用户应用（个人助手）
```typescript
// 推荐使用 continue
for await (const message of query({
  prompt: userMessage,
  options: { continue: true }
})) {
  // 处理响应
}
```

**优点**:
- 无需管理 session ID
- 自动复用最近对话
- 42% 性能提升

### 场景 2: 多用户应用（SaaS 服务）
```typescript
// 推荐使用 resume
for await (const message of query({
  prompt: userMessage,
  options: { resume: userSessionId }
})) {
  // 处理响应
}
```

**优点**:
- 精确恢复用户会话
- 53% 性能提升
- 支持并发用户

### 场景 3: 批量处理（自动化流程）
```typescript
// 推荐使用单次 query 多轮
async function* batchConversation() {
  for (const task of tasks) {
    yield {
      type: 'user',
      message: { role: 'user', content: task.prompt }
    };
  }
}

for await (const message of query({
  prompt: batchConversation()
})) {
  // 处理响应
}
```

**优点**:
- 最快速（45% 提升）
- 一次启动完成多任务
- 适合自动化脚本

### 场景 4: 探索性开发
```typescript
// 推荐使用 forkSession
for await (const message of query({
  prompt: '尝试方案 B',
  options: {
    resume: originalSessionId,
    forkSession: true  // 创建分支，保留原会话
  }
})) {
  // 处理响应
}
```

**优点**:
- 保留原始会话
- 探索不同方案
- 可以对比结果

**注意**: forkSession 有较大性能开销，仅用于探索场景

## 不稳定/弃用方法

### ❌ V2 session API
```typescript
// 已弃用，不应再使用
import { createSession } from '@anthropic-ai/claude-agent-sdk';
const session = createSession(options); // deprecated
```

**替代方案**: 使用 V1 `query()` + `continue`/`resume`

### ⚠️ bridge/perpetual (@alpha)
```typescript
// 实验性 API，仅用于 claude.ai 集成
import { attachBridgeSession } from '@anthropic-ai/claude-agent-sdk/bridge';
const handle = await attachBridgeSession(opts); // @alpha
```

**风险**:
- API 不稳定，可能随版本变化
- 文档不完整
- 不适用于通用场景

## 性能优化建议

### ✅ 推荐做法
1. **使用 continue/resume 保持会话** - 避免 40-50% 的启动开销
2. **使用 conversation generator 批量处理** - 最快速的方案
3. **持久化 session ID** - 便于后续恢复
4. **合理设置 persistSession** - 默认 true，仅在临时场景设为 false

### ❌ 避免做法
1. **每次都创建新 query** - 导致反复重启，严重影响性能
2. **过度使用 forkSession** - 有较大性能开销
3. **使用已弃用的 V2 API** - 不稳定且官方不支持
4. **在生产环境使用 @alpha API** - 风险高

## 未验证行为

1. **会话持久化跨机器**:
   - 文档说明会话文件存储在本地
   - 需要手动迁移会话文件到相同路径
   - 或者使用 `SessionStore` 适配器（@alpha）

2. **会话容量限制**:
   - 未测试会话历史最大长度
   - 未测试多轮对话的性能衰减

3. **并发会话管理**:
   - 未测试同时管理多个会话的性能
   - 未测试 session ID 冲突处理

## 参考文档

- [SDK Sessions - Work with sessions](https://docs.anthropic.com/en/docs/agent-sdk/sessions)
- [SDK TypeScript - Options](https://docs.anthropic.com/en/docs/agent-sdk/typescript)
- [SDK Observability](https://docs.anthropic.com/en/docs/agent-sdk/observability)

## 测试代码

完整测试代码见: `test/integration/session-reuse-methods.spec.ts`

运行测试:
```bash
npx vitest run test/integration/session-reuse-methods.spec.ts
```
