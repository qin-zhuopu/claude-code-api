# CLI 多进程池架构验证

**日期**: 2026-05-23
**来源**: `cli-process-pool.spec.ts` 三组验证实验
**主题**: 进程复用、多进程并发、输出流路由、HTTP API 进程池架构

---

## 核心发现摘要

| 发现 | 结论 |
|------|------|
| **进程可以复用** | 收到 `result` 后，继续发 `user` 消息，进程正常响应 |
| **多进程可以并发** | 两个 CLI 进程同时运行，各自独立收发，互不干扰 |
| **每条消息都带 session_id** | stdout 输出的每条 JSON 消息都有 `session_id` 和 `uuid`，可做路由 |
| **同一进程 session_id 不变** | 进程复用时，两条消息的 `session_id` 相同，天然保持对话上下文 |
| **架构是 N:1:N** | 不是简单一对多，而是 HTTP 客户端 N : 会话 1 : CLI 进程 1 : 服务器 N |

---

## 一、实验矩阵

| Case | 验证点 | 方法 | 结果 |
|------|--------|------|------|
| 1 | 进程复用 | 单进程连续发 2 条 user 消息 | ✅ 两次都收到正确响应 |
| 2 | 多进程并发 | 两个进程同时 init + 发消息 | ✅ 各自独立，互不串扰 |
| 3 | 输出流路由 | 分析每条 stdout 消息的标识字段 | ✅ 每条消息都有 session_id + uuid |

---

## 二、Case 1 详细数据：进程复用

### 实验流程

```
spawn 进程 → initialize → 发 msg1 "1+1=?" → 收到 result "2"
                                    ↓ (不关进程)
                      发 msg2 "2+2=?" → 收到 result "4"
```

### 关键数据

```
msg1:
  消息数: 4 (system/init, assistant×2, result/success)
  result: "2"
  session_id: d7a556c8-4417-4434-99ec-29ef734ede58

msg2:
  消息数: 4 (system/init, assistant×2, result/success)
  result: "4"
  session_id: d7a556c8-4417-4434-99ec-29ef734ede58  ← 相同！

Session 相同? true
```

### 结论

- CLI 进程收到 `result` 后，stdin **仍然可写**，进程继续 alive
- 同一进程内，两次消息的 `session_id` **完全相同**
- 消息之间天然保持对话上下文（共享同一个 session）
- 耗时：11 秒（含两次 LLM 调用）

---

## 三、Case 2 详细数据：多进程并发

### 实验流程

```
spawn PA ──→ init PA ──→ 发 "中国的首都？" → result "北京"
spawn PB ──→ init PB ──→ 发 "法国的首都？" → result "巴黎"
              ↑ 同时进行 ↑
```

### 关键数据

```
PA: result="北京", 消息数=4, 耗时≈4.8s
PB: result="巴黎", 消息数=4, 耗时≈4.8s
```

### 结论

- 两个 CLI 进程完全独立，stdin/stdout 互不干扰
- 两个进程的 init 可以 `Promise.all` 并行
- 资源消耗可控：每个进程是独立的 child_process

---

## 四、Case 3 详细数据：输出流路由

### 消息标识字段分析

每条 stdout 消息都包含以下标识字段：

| 字段 | 存在 | 说明 |
|------|------|------|
| `session_id` | ✅ 每条都有 | 进程级唯一标识，进程复用时不变 |
| `uuid` | ✅ 每条都有 | 消息级唯一标识，每条消息不同 |

### 各消息类型完整字段

**system/init**:
```json
{
  "type", "subtype", "cwd", "session_id", "tools", "mcp_servers",
  "model", "permissionMode", "slash_commands", "apiKeySource",
  "claude_code_version", "output_style", "agents", "skills",
  "plugins", "analytics_disabled", "uuid", "memory_paths", "fast_mode_state"
}
```

**assistant**:
```json
{
  "type", "session_id", "uuid",
  "message": { "role": "assistant", "content": [{ "type": "text", "text": "..." }] }
}
```

**result/success**:
```json
{
  "type", "subtype", "is_error", "api_error_status",
  "duration_ms", "duration_api_ms", "ttft_ms", "num_turns",
  "result", "stop_reason", "session_id", "total_cost_usd",
  "usage", "modelUsage", "permission_denials", "terminal_reason",
  "fast_mode_state", "uuid"
}
```

### 路由可行性

- ✅ `session_id`：可用于把输出路由到对应的 HTTP 客户端
- ✅ `uuid`：可用于去重、追踪单条消息
- ✅ `result.type === 'result'`：可用于判断一轮对话结束

---

## 五、架构设计：HTTP API + CLI 进程池

### 5.1 数据流拓扑

```
HTTP 客户端 A (SSE)  ─┐
HTTP 客户端 B (SSE)  ─┤         ┌── CLI 进程 A (session_id=aaa)
HTTP 客户端 C (SSE)  ─┼── HTTP ─┤
      ...             ─┘  服务器 └── CLI 进程 B (session_id=bbb)
```

### 5.2 关系模型：N:1:N

不是简单的一对多，而是：

| 维度 | 关系 | 说明 |
|------|------|------|
| HTTP 客户端 : 会话 | N:1 | 多个客户端可以订阅同一个会话（如刷新页面重连） |
| 会话 : CLI 进程 | **1:1** | 每个会话绑定一个独立的 CLI 进程 |
| HTTP 服务器 : CLI 进程 | 1:N | 一个服务器管理多个进程 |

### 5.3 核心路由逻辑

```
POST /chat { message, session_id? }

1. 有 session_id？
   ├─ 有 → 查进程池，找到对应进程？
   │       ├─ 找到 → 直接往 stdin 写 user 消息
   │       └─ 没找到 → spawn 新进程，initialize，绑定 session_id
   └─ 没有 → 生成新 session_id，spawn 新进程，initialize

2. CLI 进程 stdout 输出：
   → readline 逐行读 JSON
   → 按 session_id 找到对应的 SSE 连接
   → 推送给 HTTP 客户端
   → 遇到 type=result → 标记本轮结束（但不关进程）
```

### 5.4 请求-响应流时序

```
客户端           HTTP 服务器          CLI 进程
  │                 │                   │
  │── POST /chat ──→│                   │
  │                 │── user JSON ─────→│
  │                 │                   │── API 调用 ──→ Anthropic
  │                 │←── system/init ───│←── 响应 ───────
  │←── SSE: init ──│                   │
  │                 │←── assistant ─────│
  │←── SSE: text ──│                   │
  │                 │←── result ────────│
  │←── SSE: done ──│                   │
  │                 │                   │ (进程保持 alive)
  │                 │                   │
  │── POST /chat ──→│                   │
  │                 │── user JSON ─────→│ (复用同一进程)
  │                 │←── assistant ─────│
  │←── SSE: text ──│                   │
  │                 │←── result ────────│
  │←── SSE: done ──│                   │
```

### 5.5 进程池管理

```typescript
class CliProcessPool {
  private processes = new Map<string, ChildProcess>();  // session_id → 进程
  private listeners = new Map<string, Set<SSEResponse>>(); // session_id → SSE 连接们

  // 获取或创建进程（懒启动）
  getOrCreate(sessionId: string): ChildProcess;

  // 注册 SSE 监听
  subscribe(sessionId: string, res: SSEResponse): void;

  // 取消 SSE 监听（客户端断开）
  unsubscribe(sessionId: string, res: SSEResponse): void;

  // 进程空闲超时回收
  startIdleTimer(sessionId: string, timeoutMs: number): void;
}
```

### 5.6 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 会话绑定 | session_id → 进程 1:1 | 同一进程天然保持对话上下文 |
| 输出推送 | SSE (text/event-stream) | HTTP 标准单向流，浏览器原生支持 |
| 进程回收 | 空闲超时 kill | 避免僵尸进程占用资源 |
| 并发安全 | 每个进程同一时间只处理一条消息 | CLI 进程是单工的，不能并发写入 stdin |
| 错误恢复 | 进程崩溃时清理 + 下次请求重建 | 简单可靠 |

---

## 六、与现有 SDK 方案对比

| | SDK `query()` (现有项目) | CLI 进程池 (本方案) |
|---|---|---|
| 进程生命周期 | 每次调用创建+销毁 | **长活，跨请求复用** |
| 会话上下文 | 需要 resume/continue | **天然保持**（同进程同 session） |
| 多会话并发 | 需要多次 `query()` | **进程池，N:1:N 路由** |
| 初始化开销 | 每次都要 | **只初始化一次** |
| 复杂度 | 低（SDK 全包） | 中等（自己管进程池） |
| 灵活度 | 受 SDK API 限制 | **完全控制** |

---

## 七、未验证行为

| 待验证项 | 说明 |
|----------|------|
| 空闲超时 | 进程多久不活动会自己退出？需要发 keep_alive 吗？ |
| 进程崩溃检测 | 进程异常退出时，stdout 的 EOF 行为 |
| 最大进程数 | 一台机器能同时跑多少个 CLI 进程（内存/端口限制） |
| 会话恢复 | 进程崩溃后，用新进程能否 resume 旧会话（`--resume` 参数） |
| 并发写入保护 | 同一进程同时收到两条 user 消息会怎样 |
| 工具调用场景 | 有工具调用时（多轮），进程复用行为是否一致 |
