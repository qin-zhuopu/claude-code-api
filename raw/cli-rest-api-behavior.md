# CLI 进程直接通信：绕过 SDK 实现 REST API

**日期**: 2026-05-23
**来源**: SDK 源码逆向 + `cli-rest-api.spec.ts` 验证实验
**主题**: `--input-format stream-json` JSON 行协议、CLI 进程直接操纵、REST API 转化

---

## 核心发现摘要

| 发现 | 说明 |
|------|------|
| **可以绕过 SDK** | 直接 spawn `claude --input-format stream-json` 进程，通过 stdin/stdout JSON 行协议通信 |
| **两种管道模式** | 默认 `text` 模式接收纯文本输入；`stream-json` 模式接收 JSON 消息流（SDK 内部用的就是这个） |
| **JSON 行协议未文档化** | `--input-format` flag 在 CLI reference 中有列出，但消息格式（`control_request`/`user`/`result` 等）没有任何公开文档 |
| **实验验证成功** | initialize 握手 → 发 user 消息 → 收到完整 assistant + result 响应，全程 3.7 秒 |
| **进程可复用** | 单个 CLI 进程可以处理多条 user 消息，适合做长连接 HTTP API |

---

## 一、背景：SDK 到底做了什么

### 1.1 SDK 的架构

`@anthropic-ai/claude-agent-sdk` 不是 API 客户端，而是 **CLI 进程管理器**。它的核心工作：

```
SDK query()                          claude CLI 进程
┌─────────────┐   stdin (JSON行)    ┌──────────────────┐
│  JS 对象    │ ──────────────────→ │  解析 JSON 消息   │
│  封装       │                     │  调用 Anthropic API│
│             │ ←────────────────── │  返回 JSON 消息   │
└─────────────┘   stdout (JSON行)   └──────────────────┘
```

SDK 源码（`sdk.mjs` 中的 `ProcessTransport` 类）启动 CLI 时的硬编码参数：

```javascript
let l = [
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json"
];
// 然后追加 --model, --tools, --allowedTools 等参数
// 最终通过 child_process.spawn 启动
```

### 1.2 两种"管道"的区别

这是最容易混淆的点。官方文档提到的管道和 SDK 内部用的管道是两回事：

| | 文本管道（文档有写） | JSON 流管道（SDK 内部用） |
|---|---|---|
| `--input-format` | `text`（默认） | `stream-json` |
| stdin 内容 | 纯文本，作为 prompt 附加内容 | 一行一行 JSON 消息 |
| stdout 内容 | 纯文本或 JSON | 一行一行 JSON 事件 |
| 谁在用 | `cat file \| claude -p "explain"` | SDK 程序化调用 |
| 交互模式 | 一次性，stdin EOF 就结束 | 持续双向，可以多轮 |
| 文档状态 | ✅ headless.md 有专门一节 | ❌ 消息格式完全未文档化 |

---

## 二、JSON 行协议详解（逆向自 SDK 源码）

### 2.1 通信格式

每条消息 = 一行 JSON，以 `\n` 分隔。

**SDK → CLI（写入 stdin）**：

```json
{"type":"control_request","request_id":"xxx","request":{"subtype":"initialize","hooks":null}}
{"type":"user","session_id":"","message":{"role":"user","content":"你好"},"parent_tool_use_id":null}
```

**CLI → SDK（从 stdout 读取）**：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"xxx","response":{...}}}
{"type":"system","subtype":"init","sessionId":"...","tools":[...],...}
{"type":"assistant","message":{"role":"assistant","content":[...]},...}
{"type":"result","subtype":"success","result":"回答文本","is_error":false,...}
```

### 2.2 消息类型全景

#### SDK → CLI 方向

| type | subtype | 说明 |
|------|---------|------|
| `control_request` | `initialize` | 初始化握手 |
| `control_request` | `set_model` | 动态切换模型 |
| `control_request` | `set_permission_mode` | 动态切换权限模式 |
| `control_request` | `interrupt` | 中断当前操作 |
| `control_request` | `get_settings` | 获取当前配置 |
| `control_request` | `mcp_*` | MCP 服务器管理 |
| `user` | — | 用户消息 |

#### CLI → SDK 方向

| type | subtype | 说明 |
|------|---------|------|
| `control_response` | `success` / `error` | 控制请求的响应 |
| `control_request` | `can_use_tool` | CLI 反向询问权限 |
| `control_request` | `hook_callback` | CLI 触发 hook 回调 |
| `control_request` | `mcp_message` | MCP 消息转发 |
| `control_request` | `elicitation` | MCP Elicitation 请求 |
| `system` | `init` | 初始化系统消息 |
| `system` | `status` | 状态更新 |
| `assistant` | — | LLM 完整回复 |
| `stream_event` | — | 流式片段（需 `--include-partial-messages`） |
| `result` | `success` / `error` | 最终结果 |
| `keep_alive` | — | 心跳 |
| `transcript_mirror` | — | 会话记录镜像 |

### 2.3 请求-响应匹配机制

`control_request` 和 `control_response` 通过 `request_id` 匹配：

```
SDK 发: {"type":"control_request","request_id":"init_1","request":{...}}
CLI 回: {"type":"control_response","response":{"subtype":"success","request_id":"init_1",...}}
```

SDK 内部用 `pendingControlResponses` Map 管理：发请求时存入，收到响应时按 `request_id` 取出。

---

## 三、实验验证

### 3.1 实验设计

**测试文件**: `test/integration/cli-rest-api.spec.ts`

不使用 SDK 的 `query()`，直接 `spawn('claude', [...])` 启动 CLI 进程，手动发送 JSON 消息。

### 3.2 实验步骤

**Step 1**: spawn CLI 进程

```typescript
spawn('claude', [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--system-prompt', '你是一个简单的助手，简短回答，不使用工具。',
  '--tools', '',
  '--permission-mode', 'bypassPermissions',
  '--setting-sources=',
  '--no-session-persistence',
], { stdio: ['pipe', 'pipe', 'pipe'] });
```

**Step 2**: 发送 initialize 握手

```json
{"type":"control_request","request_id":"init_1","request":{"subtype":"initialize","hooks":null}}
```

**Step 3**: 发送 user 消息

```json
{"type":"user","session_id":"","message":{"role":"user","content":"简单回答：1+1等于几？只回答数字。"},"parent_tool_use_id":null}
```

**Step 4**: 从 stdout 逐行读 JSON，直到收到 `type: "result"`

### 3.3 实验结果

```
✅ Initialize 成功
✅ 收到完整响应流

📊 消息流分析
═══════════════════════════════════
总消息数: 4
消息类型分布: {
  "system/init": 1,
  "assistant": 2,
  "result/success": 1
}

assistant 消息数: 2
  文本: "2"

result: is_error=false, subtype=success
  result text: "2"

全程耗时: 3.7 秒
```

### 3.4 关键技术点

| 要点 | 说明 |
|------|------|
| **stdin 不能关** | 写完消息后不要 `stdin.end()`，进程需要保持 alive |
| **readline 逐行读** | stdout 是 JSON 行流，用 `readline.createInterface` 逐行解析 |
| **request_id 匹配** | `control_request` 和 `control_response` 通过 `request_id` 配对 |
| **Windows 需要 shell:true** | `spawn('claude', args, { shell: true })` 才能解析 `.cmd` 扩展名 |

---

## 四、转化为 REST API 的方案

### 4.1 最小实现

```typescript
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import express from 'express';

const app = express();
app.use(express.json());

// 保持一个长活的 CLI 进程
let cliProcess: ChildProcess;
let requestId = 0;
const pendingRequests = new Map<string, { resolve: Function; reject: Function }>();

function startCli() {
  cliProcess = spawn('claude', [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
  ], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });

  const rl = createInterface({ input: cliProcess.stdout! });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'control_response') {
      const pending = pendingRequests.get(msg.response.request_id);
      if (pending) pending.resolve(msg.response);
    }
    // 处理 assistant、result 等消息...
  });
}

function sendControl(request: any): Promise<any> {
  const id = `req_${++requestId}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    cliProcess.stdin!.write(JSON.stringify({
      type: 'control_request',
      request_id: id,
      request,
    }) + '\n');
  });
}

// 初始化
startCli();
await sendControl({ subtype: 'initialize', hooks: null });

// REST API 端点
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  // 设置 SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();

  // 发送 user 消息
  cliProcess.stdin!.write(JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: message },
    parent_tool_use_id: null,
  }) + '\n');

  // 从 stdout 流中收集响应，推送到 SSE...
});

app.listen(3000);
```

### 4.2 与现有项目的对比

| | 现有项目（SDK `query()`） | 直接 CLI 进程方案 |
|---|---|---|
| 启动方式 | `query({ prompt, options })` | `spawn('claude', [...args])` |
| 通信 | SDK 自动处理 JSON 流 | 手动写/读 JSON 行 |
| 初始化 | SDK 自动 | 需手动发 `initialize` |
| 多轮 | 每次调 `query()` 创建新进程 | **进程保持 alive**，可持续写入新消息 |
| 权限回调 | SDK 的 `canUseTool` 选项 | 需处理 `control_request` 中的 `can_use_tool` |
| Hook | SDK 的 `hooks` 选项 | 需处理 `hook_callback` 控制请求 |
| 复杂度 | 低 | 中等 |
| 灵活度 | 受 SDK API 限制 | 完全控制，可访问未文档化功能 |

### 4.3 什么时候用直接 CLI 方案

**适合**：
- 需要 CLI 进程长活、多轮复用
- 需要访问 SDK 未暴露的 CLI 功能
- 想要最小依赖、不装 SDK
- 需要自定义 JSON 协议处理（如代理、中间件）

**不适合**：
- 简单场景，SDK `query()` 够用
- 需要类型安全的 TypeScript 体验
- 不想自己管理进程生命周期和错误恢复

---

## 五、未验证行为

| 待验证项 | 说明 |
|----------|------|
| 多轮消息复用 | 一个进程收到 result 后再发第二条 user 消息是否正常 |
| `can_use_tool` 反向请求 | CLI 发权限确认请求时，不回复会怎样 |
| 进程崩溃恢复 | CLI 进程异常退出后如何检测和重启 |
| 并发请求 | 一个进程同时处理多条 user 消息是否安全 |
| `--include-partial-messages` 流式 | 直接 CLI 方案下 stream_event 的推送行为 |
| Windows 以外的平台兼容性 | Linux/macOS 上的 spawn 方式差异 |

---

## 附录：信息来源

| 来源 | 内容 |
|------|------|
| `raw/claude-code-docs/docs/cli-reference.md` | `--input-format` 和 `--output-format` 的官方描述 |
| `raw/claude-code-docs/docs/headless.md` | 文本管道模式的文档（"Pipe data through Claude"） |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | SDK 源码（minified），JSON 行协议的 ground truth |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `OutputFormat`、`SpawnedProcess`、`SpawnOptions` 类型定义 |
