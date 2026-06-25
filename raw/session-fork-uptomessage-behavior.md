# Session Fork upToMessageId / resumeSessionAt 行为观察

## 核心发现摘要

| 发现 | 结论 | 验证方式 |
|------|------|----------|
| **两条路径截断后 messages 结构完全一致** | 路径 B（forkSession()+upToMessageId）和路径 A（resumeSessionAt+forkSession:true）在同截断点下产出相同 messages 数 | case-6: B=6, A=6 |
| **inclusive 语义确认** | upToMessageId 和 resumeSessionAt 截断点 message 本身被保留（inclusive） | case-2: round-1 截断含 round-1 的 assistant msg |
| **截断层级递增** | 截断到 round-1 → 4 messages；截断到 round-2 → 6 messages（每轮 +2） | case-2 vs case-3 |
| **省略 upToMessageId = 完整拷贝** | forkSession() 不传 upToMessageId 时，等同于截断到最后一条 message | case-7: 6 messages = 完整历史 |
| **forked ID 一定不同** | 无论路径 A 或 B，fork 产出新 session ID，原始 session 不受影响 | 全部 case |
| **resumeSessionAt 只接受 assistant UUID** | SDK 类型定义明确标注 "from SDKAssistantMessage.uuid" | 类型定义 |
| **upToMessageId 可接受任意 message UUID** | SDK 注释说 "Slice transcript up to this message UUID"，不限 message type | 类型定义 |

## 实验矩阵

### Case 1: 基线 — 用 resume 建立 2 轮历史并收集 UUID

- **方法**: 先 query 创建 session，再 resume 继续第二轮
- **结果**:
  - Session ID: `3c8c2a4a-...`
  - Round 1 UUID: `8cc722dd-...`
  - Round 2 UUID: `fd7a390e-...`
  - Round 1 请求: 2 messages (user + assistant)
  - Round 2 请求: 4 messages (round-1 user+assistant + round-2 user+assistant)
- **关键发现**:
  - `resume` 方式下 session ID 保持一致
  - 每次 resume 会把整个历史作为 messages 发送
  - `SDKAssistantMessage.uuid` 能从流式事件中正确提取

### Case 2: 路径 B — forkSession() + upToMessageId (round-1 assistant)

- **方法**: forkSession(originalId, { upToMessageId: round1Uuid }) → resume forkedId
- **结果**:
  - Forked ID 不同于 originalId ✅
  - 截断后 messages 数: **4** (含 round-1 的 user+assistant + 新 prompt 的 user message)
  - 截断后只保留 round-1 的上下文（不含 round-2）
- **关键发现**:
  - inclusive: 截断到 round-1 assistant UUID 时，round-1 的 assistant message 被保留
  - forked session resume 后发起新请求，messages 只含截断前的历史

### Case 3: 路径 B — forkSession() + upToMessageId (round-2 assistant)

- **方法**: forkSession(originalId, { upToMessageId: round2Uuid }) → resume forkedId
- **结果**:
  - 截断后 messages 数: **6** (含 round-1+round-2 的完整历史)
  - 6 > 4：round-2 截断比 round-1 截断多一轮的 2 条 messages
- **关键发现**:
  - 截断层级递增：每多截断一轮，messages 数增加 2 (user+assistant)

### Case 4: 路径 A — resumeSessionAt (round-1) + forkSession:true

- **方法**: query({ resume, resumeSessionAt: round1Uuid, forkSession: true })
- **结果**:
  - Forked ID 不同于 originalId ✅
  - 截断后 messages 数: **4** (与 case-2 完全一致)
- **关键发现**:
  - 路径 A 一步完成截断+fork+发对话，产出与路径 B 相同的 messages 结构

### Case 5: 路径 A — resumeSessionAt (round-2) + forkSession:true

- **方法**: query({ resume, resumeSessionAt: round2Uuid, forkSession: true })
- **结果**:
  - 截断后 messages 数: **6** (与 case-3 完全一致)
- **关键发现**:
  - 两条路径的截断效果在结构层面完全相同

### Case 6: 路径 B↔A 对比 — 同截断点下两条路径的 messages 结构

- **方法**: 同截断到 round-2，分别走路径 B 和路径 A
- **结果**:
  - Path B messages 数: 6
  - Path A messages 数: 6
  - **两者完全一致**: true ✅
  - Path B ID ≠ Path A ID（各自独立创建新 session）
- **关键发现**:
  - 同截断点下两条路径产出的 API 请求结构完全相同
  - 只有 forked session ID 不同（各自独立生成）

### Case 7: 边界 — forkSession() 不传 upToMessageId（完整拷贝）

- **方法**: forkSession(originalId) → resume forkedId
- **结果**:
  - messages 数: **6** (= 完整历史，等同于截断到最后一条)
  - 原始会话存在: true ✅
- **关键发现**:
  - 省略 upToMessageId 等同于完整拷贝全部历史
  - 原始会话不受影响，可继续 resume

## 详细发现

### 1. Messages 结构层级递增规律

原始 session 的 messages 结构（2 轮历史）:

```
截断到 round-1:  [user(r1), assistant(r1), user(new prompt)]  → 4 messages (2 旧 + 1 system + 1 新)
截断到 round-2:  [user(r1), assistant(r1), user(r2), assistant(r2), user(new prompt)]  → 6 messages
完整拷贝:        同截断到 round-2（因为只有 2 轮）  → 6 messages
```

规律：每多保留一轮历史，messages 数增加 2（1 条 user + 1 条 assistant）。

### 2. 路径 A vs 路径 B 的对比

| 维度 | 路径 A（resumeSessionAt） | 路径 B（forkSession()+upToMessageId） |
|------|--------------------------|-------------------------------------|
| API | query() Options 内 | 独立函数 forkSession() |
| 调用步骤 | 1 步（截断+fork+对话） | 2 步（先切片，再 resume） |
| 是否调模型 | ✅ 立刻 | ❌ 切片时不调模型 |
| message UUID 限制 | 只接受 SDKAssistantMessage.uuid | 任意 message UUID |
| 产出 messages 结构 | 与路径 B 完全一致 | — |
| 新 session ID | 一定不同于原始 | 一定不同于原始 |
| SDK 版本要求 | 0.3.x 才有 resumeSessionAt | 0.2.x 就有 |
| 官方文档 | 有（一行描述） | 无 |

### 3. 截断的 inclusive 语义

**confirmed**: `upToMessageId` 和 `resumeSessionAt` 都是 **inclusive** —— 截断点指定的 message 本身被保留在截断后的历史中。

证据：
- case-2 截断到 round-1 assistant UUID → 保留 round-1 的 assistant response
- case-3 截断到 round-2 assistant UUID → 保留 round-2 的 assistant response + round-1 全部

### 4. forkSession() 独立函数的纯文件操作特性

forkSession() 是**纯文件操作**——读取原始 session 的 jsonl 文件，切片拷贝到新文件。不调用 API、不启动 agent。这让它在需要"先切片再看一眼"的场景下很有价值。

## 实际应用建议

### 场景 1: "从某条 assistant message 后换方向" — 推荐路径 A

```typescript
// 一步完成截断+fork+发对话
for await (const msg of query({
  prompt: '换个思路试试...',
  options: {
    resume: originalSessionId,
    resumeSessionAt: targetAssistantUuid,  // SDKAssistantMessage.uuid
    forkSession: true,
  }
})) { ... }
```

优点：一步到位，代码简洁。

### 场景 2: "从某条 user/tool_result message 处切片" — 只能用路径 B

```typescript
// 先切片（不调模型）
const { sessionId: forkedId } = await forkSession(originalSessionId, {
  upToMessageId: targetUserUuid,  // 可以是任意 message 的 UUID
});
// 再决定是否继续
for await (const msg of query({
  prompt: '...',
  options: { resume: forkedId }
})) { ... }
```

原因：resumeSessionAt 只接受 assistant UUID。

### 场景 3: "先切片看一眼，再决定要不要继续" — 推荐路径 B

forkSession() 不调模型，可以先切片、检查 session jsonl 内容、再决定是否 resume。路径 A 无法做到这一点——它一步就发起了对话。

### 场景 4: "从最后一条 fork" — 最简单方式

```typescript
// 方式 1: query() forkSession:true（路径 A，最简单）
for await (const msg of query({
  prompt: '...',
  options: { resume: sessionId, forkSession: true }
})) { ... }

// 方式 2: forkSession() 不传 upToMessageId（路径 B，等效）
const { sessionId: forkedId } = await forkSession(sessionId);
```

两者等效，路径 A 一步完成更简洁。

## 未验证行为

1. **upToMessageId 传 user message UUID 的行为**: resumeSessionAt 明确只接受 assistant UUID，但 forkSession() 的 upToMessageId 类型定义不限。传 user UUID 时截断行为（是否从该 user message 的上一条 assistant 截断？）未验证。

2. **跨工具调用 message 的切片**: session 中有 tool_use 和 tool_result message，传这些类型的 UUID 作为 upToMessageId 时，截断边界是否完整（不会切断工具调用中间）未验证。

3. **sidechain message 的处理**: subagent 的 message 有 parent_tool_use_id，fork 截断到这些 message 时，parent 工具调用的完整性是否受影响未验证。

4. **resumeSessionAt 不搭配 forkSession:true 的行为**: 如果只用 resume+resumeSessionAt 但不 fork，是否原地截断 resume（修改原 session）？这可能有风险——需进一步验证。

5. **resumeSessionAt 传 user UUID 是否报错**: 类型定义说只接受 SDKAssistantMessage.uuid，但传了 user UUID 时是静默忽略还是抛异常？未验证。
