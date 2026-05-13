# SDK 工具-用户交互机制洞察文档

**日期**: 2026-05-13
**来源**: SDK 类型定义 (`sdk.d.ts`) 分析 + 已有测试验证
**主题**: 哪些工具需要用户交互、交互方式、通知机制、配置方式、结果提交、数据类型与 Schema

---

## 核心发现摘要

SDK 中有 **3 大类用户交互机制**，每种都有独立的交互路径、通知方式和数据类型：

| 交互类型 | 触发场景 | 通知方式 | 提交方式 | 是否可提前配置跳过 |
|----------|----------|----------|----------|-------------------|
| **权限确认 (Permission)** | 工具执行前 | `canUseTool` 回调 / `SDKControlPermissionRequest` | 返回 `PermissionResult` | ✅ `permissionMode`、`allowedTools`、`hooks` |
| **AskUserQuestion** | LLM 主动调用 | `canUseTool` 回调（同权限路径） | `updatedInput` 注入答案 | ✅ 通过 `tools` 排除 |
| **MCP Elicitation** | MCP 服务器请求 | `onElicitation` 回调 / `Elicitation` Hook / `SDKControlElicitationRequest` | 返回 `ElicitationResult` | ✅ Hook 自动应答 |
| **User Dialog** | 特殊工具 UI | `SDKControlRequestUserDialogRequest` | `SDKControlResponse` | ❌ 工具内部逻辑 |
| **User Message** | 多轮对话 | `AsyncIterable<SDKUserMessage>` 输入流 | `send()` / 下一条消息 | N/A |

---

## 一、权限确认机制 (Permission)

### 1.1 哪些工具需要权限确认

几乎所有"有副作用"的工具都需要权限确认：

| 工具 | 权限级别 | 说明 |
|------|----------|------|
| **Bash** | 高 | 执行 shell 命令，每次调用都可能触发 |
| **Edit** | 中 | 修改文件内容 |
| **Write** | 高 | 创建/覆盖文件 |
| **NotebookEdit** | 中 | 修改 Jupyter notebook |
| **Agent** (子Agent) | 中 | 启动子Agent |
| **Skill** | 中 | 调用自定义 skill |
| **Read** | 低 | 通常不需要权限，但读取受保护路径时可能触发 |
| **Glob/Grep** | 无 | 纯搜索，一般不触发 |

### 1.2 交互通知方式

SDK 提供 **两种并行通道** 接收权限请求：

#### 通道 A: `canUseTool` 回调（编程式）

```typescript
// Options.canUseTool
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;           // 取消信号
    suggestions?: PermissionUpdate[];  // "always allow" 的建议规则
    blockedPath?: string;          // 触发权限的文件路径
    decisionReason?: string;       // 为什么需要权限
    title?: string;               // 完整提示文本（如 "Claude wants to read foo.txt"）
    displayName?: string;         // 短标签（如 "Read file"）
    description?: string;         // 人类可读的副标题
    toolUseID: string;            // 工具调用唯一 ID
    agentID?: string;             // 子Agent ID（如果适用）
  }
) => Promise<PermissionResult>;
```

#### 通道 B: Control Request（Bridge 模式）

```typescript
// 通过 stdout 的 SDKControlRequest
type SDKControlPermissionRequest = {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  decision_reason_type?: 'rule' | 'mode' | 'subcommandResults' | 'permissionPromptTool'
    | 'hook' | 'asyncAgent' | 'sandboxOverride' | 'workingDir' | 'safetyCheck'
    | 'classifier' | 'other';
  classifier_approvable?: boolean;
  title?: string;
  display_name?: string;
  tool_use_id: string;
  agent_id?: string;
  description?: string;
};
```

### 1.3 用户交互结果的数据类型

```typescript
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;   // 可以修改工具输入！
      updatedPermissions?: PermissionUpdate[];   // "always allow" 规则
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: 'deny';
      message: string;                          // 拒绝原因
      interrupt?: boolean;                      // 是否中断整个会话
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

type PermissionDecisionClassification =
  | 'user_temporary'   // 本次允许
  | 'user_permanent'   // 永久允许（always allow）
  | 'user_reject';     // 用户拒绝
```

### 1.4 提前配置跳过权限

| 配置方式 | 类型 | 说明 |
|----------|------|------|
| `permissionMode` | `PermissionMode` | 全局模式控制 |
| `allowedTools` | `string[]` | 工具白名单（无需确认） |
| `hooks.PermissionRequest` | Hook | 编程式自动批准/拒绝 |
| settings.json 的 `permissions` | 配置文件 | 永久规则 |

**PermissionMode 取值**：

| 值 | 行为 |
|----|------|
| `'default'` | 标准行为，危险操作提示确认 |
| `'acceptEdits'` | 自动接受文件编辑 |
| `'bypassPermissions'` | 绕过所有权限检查（需 `allowDangerouslySkipPermissions: true`） |
| `'plan'` | 计划模式，不执行任何工具 |
| `'dontAsk'` | 不提示权限，未预批准的自动拒绝 |
| `'auto'` | 用模型分类器自动批准/拒绝 |

**PermissionUpdate 规则类型**：

```typescript
type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination; }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination; }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination; }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination; }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination; }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination; };

type PermissionRuleValue = {
  toolName: string;       // 如 "Bash", "Edit", "Write"
  ruleContent?: string;   // 如 "git *", "npm *"
};

type PermissionBehavior = 'allow' | 'deny' | 'ask';
type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
```

---

## 二、AskUserQuestion 工具交互

### 2.1 特殊之处

AskUserQuestion 走的也是 `canUseTool` 通道，但交互语义完全不同：
- 权限确认：用户回答 allow/deny
- AskUserQuestion：用户回答问题内容

### 2.2 交互流程

```
LLM → tool_use(AskUserQuestion, { questions: [...] })
  → SDK 调用 canUseTool("AskUserQuestion", { questions: [...] })
    → SDK 消费者在回调中：
       1. 提取 questions 给用户展示
       2. 收集用户选择
       3. 返回 { behavior: 'allow', updatedInput: { questions, answers } }
  → SDK 将 updatedInput 作为 tool_result 发给 LLM
```

### 2.3 AskUserQuestion Schema

```typescript
// AskUserQuestion input_schema
{
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        required: ['question', 'header', 'options', 'multiSelect'],
        properties: {
          question: { type: 'string' },       // 完整问题
          header: { type: 'string' },          // ≤12字符标签
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['label', 'description'],
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
                preview: { ... }               // 可选的预览内容
              }
            }
          },
          multiSelect: { type: 'boolean', default: false },
        }
      }
    },
    answers: { type: 'object', additionalProperties: { type: 'string' } },
    annotations: { type: 'object' },
    metadata: { type: 'object' },
  }
}
```

### 2.4 tool_result 格式

SDK 将 `updatedInput` 中的 answers 格式化为：
```
User has answered your questions: "问题文本"="选择的选项label". You can now continue with the user's answers in mind.
```

---

## 三、MCP Elicitation 交互

### 3.1 触发场景

MCP 服务器请求用户输入时触发。两种模式：
- **`form` 模式**：结构化表单，带 `requestedSchema`
- **`url` 模式**：浏览器认证，带 `url`

### 3.2 交互通知方式（三层）

1. **Hook 层**（最先触发）：
```typescript
type ElicitationHookInput = BaseHookInput & {
  hook_event_name: 'Elicitation';
  mcp_server_name: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
};

// Hook 可以自动应答
type ElicitationHookSpecificOutput = {
  hookEventName: 'Elicitation';
  action?: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
};
```

2. **`onElicitation` 回调**（Hook 未处理时）：
```typescript
type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal; }
) => Promise<ElicitationResult>;
```

3. **Bridge Control Request**（远程模式）：
```typescript
type SDKControlElicitationRequest = {
  subtype: 'elicitation';
  mcp_server_name: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
  title?: string;
  display_name?: string;
  description?: string;
};
```

### 3.3 ElicitationRequest Schema

```typescript
type ElicitationRequest = {
  serverName: string;       // MCP 服务器名
  message: string;          // 展示给用户的消息
  mode?: 'form' | 'url';   // 交互模式
  url?: string;             // URL 模式的链接
  elicitationId?: string;   // URL 模式的关联 ID
  requestedSchema?: Record<string, unknown>;  // form 模式的 JSON Schema
  title?: string;           // 权限显示标题
  displayName?: string;     // 短工具/服务器标签
  description?: string;     // 权限显示副标题
};
```

### 3.4 提交交互结果

```typescript
// from @modelcontextprotocol/sdk/types.js
type ElicitResult = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;  // form 模式的字段值
};
```

### 3.5 ElicitationResult Hook（后处理）

```typescript
// 用户回答后、发送给 MCP 服务器前触发
type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: 'ElicitationResult';
  mcp_server_name: string;
  elicitation_id?: string;
  mode?: 'form' | 'url';
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
};

type ElicitationResultHookSpecificOutput = {
  hookEventName: 'ElicitationResult';
  action?: 'accept' | 'decline' | 'cancel';   // 可以覆盖用户的回答！
  content?: Record<string, unknown>;
};
```

---

## 四、User Dialog 交互

### 4.1 触发场景

特殊工具需要渲染自定义 UI 对话框时触发（如 `it2_setup`、`computer_use_approval`）。

```typescript
type SDKControlRequestUserDialogRequest = {
  subtype: 'request_user_dialog';
  dialog_kind: string;           // 对话框类型标识（开放字符串联合）
  payload: Record<string, unknown>;  // 对话框特定数据（按 dialog_kind 定义）
  tool_use_id?: string;
};
```

### 4.2 特点

- 这是 **最不透明** 的交互类型
- `dialog_kind` 是开放联合类型，可能随版本增加新值
- `payload` 完全按 `dialog_kind` 定义，SDK 不约束其结构
- 通过 `SDKControlResponse` 返回结果

---

## 五、多轮对话中的用户消息提交

### 5.1 输入方式

`query()` 接受两种输入：

```typescript
// 单轮：直接字符串
query({ prompt: "Hello" })

// 多轮：AsyncIterable
query({
  prompt: (async function* () {
    yield { type: 'user', message: { role: 'user', content: 'Hello' }, parent_tool_use_id: null };
    // 等待 assistant 回复后继续...
    yield { type: 'user', message: { role: 'user', content: 'Follow up' }, parent_tool_use_id: null };
  })()
})
```

### 5.2 SDKUserMessage Schema

```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;           // Anthropic API 的 MessageParam
  parent_tool_use_id: string | null;  // 关联的 tool_use（如果适用）
  isSynthetic?: boolean;           // 合成消息（非用户直接输入）
  tool_use_result?: unknown;       // 工具执行结果
  priority?: 'now' | 'next' | 'later';  // 消息优先级
  origin?: SDKMessageOrigin;       // 消息来源
  shouldQuery?: boolean;           // 是否触发 assistant 回复（false = 静默追加）
  timestamp?: string;              // ISO 时间戳
  uuid?: UUID;
  session_id?: string;
};
```

---

## 六、交互机制的统一消息流

```
SDK stdout 输出（StdoutMessage 联合类型）:
├── SDKMessage              → 各种事件消息
│   ├── SDKAssistantMessage → assistant 回复
│   ├── SDKResultMessage    → 最终结果
│   ├── SDKPartialAssistantMessage → 流式片段
│   ├── SDKStatusMessage    → 状态更新
│   ├── SDKToolUseSummaryMessage  → 工具调用摘要
│   └── ...
├── SDKControlRequest       → **需要 SDK 消费者响应的请求**
│   ├── SDKControlPermissionRequest  → 权限确认
│   ├── SDKControlElicitationRequest → MCP 用户输入
│   ├── SDKControlRequestUserDialogRequest → 自定义对话框
│   └── ...
├── SDKControlResponse      → SDK 消费者提交的响应
├── SDKControlCancelRequest → 取消之前的请求
└── SDKKeepAliveMessage     → 保活心跳
```

---

## 七、提前配置策略

### 7.1 完全自动化的配置（无交互）

```typescript
const result = await query({
  prompt: '...',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hooks: {
      Elicitation: [{
        hooks: [async (input) => ({
          hookEventName: 'Elicitation',
          action: 'accept',
          content: { username: 'auto' }
        })]
      }]
    },
    onElicitation: async (req) => ({ action: 'accept' }),
    canUseTool: async (toolName, input) => ({
      behavior: 'allow',
      updatedInput: input
    }),
  }
});
```

### 7.2 部分自动化的配置

```typescript
const result = await query({
  prompt: '...',
  options: {
    allowedTools: ['Read', 'Grep', 'Glob'],  // 这些工具免确认
    canUseTool: async (toolName, input, opts) => {
      // 只对特定工具弹交互
      if (toolName === 'Bash') {
        return { behavior: 'deny', message: 'Bash not allowed' };
      }
      if (toolName === 'AskUserQuestion') {
        const answers = await showUserDialog(opts.title!, input);
        return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
      }
      return { behavior: 'allow' };
    },
  }
});
```

---

## 八、SDKControlRequestInner 完整列表

所有可能的 Control Request 类型（即所有需要 SDK 消费者响应的请求）：

| subtype | 类别 | 需要用户交互 | 说明 |
|---------|------|-------------|------|
| `can_use_tool` | 权限 | ✅ | 工具权限确认 |
| `elicitation` | MCP | ✅ | MCP 服务器请求用户输入 |
| `request_user_dialog` | UI | ✅ | 自定义对话框 |
| `initialize` | 会话 | ❌ | 会话初始化握手 |
| `set_permission_mode` | 配置 | ❌ | 设置权限模式 |
| `set_model` | 配置 | ❌ | 切换模型 |
| `set_max_thinking_tokens` | 配置 | ❌ | 设置思考 token 上限 |
| `set_color` | UI | ❌ | 设置主题色 |
| `rename_session` | 会话 | ❌ | 重命名会话 |
| `rewind_files` | 会话 | ❌ | 回退文件变更 |
| `seed_read_state` | 会话 | ❌ | 预设读取状态缓存 |
| `read_file` | 侧栏 | ❌ | 读取文件（远程侧栏查看器） |
| `get_context_usage` | 状态 | ❌ | 获取上下文使用情况 |
| `get_session_cost` | 状态 | ❌ | 获取会话费用 |
| `get_binary_version` | 状态 | ❌ | 获取 CLI 版本 |
| `get_settings` | 配置 | ❌ | 获取当前设置 |
| `apply_flag_settings` | 配置 | ❌ | 应用标志设置 |
| `stop_task` | 控制 | ❌ | 停止任务 |
| `file_suggestions` | 自动补全 | ❌ | 文件路径建议 |
| `mcp_status` | MCP | ❌ | MCP 服务器状态 |
| `mcp_call` | MCP | ❌ | MCP 工具调用 |
| `mcp_message` | MCP | ❌ | MCP 消息 |
| `mcp_set_servers` | MCP | ❌ | 设置 MCP 服务器 |
| `mcp_reconnect` | MCP | ❌ | 重连 MCP |
| `mcp_toggle` | MCP | ❌ | 启用/禁用 MCP |
| `mcp_authenticate` | MCP | ✅ | MCP 认证 |
| `mcp_clear_auth` | MCP | ❌ | 清除 MCP 认证 |
| `mcp_oauth_callback_url` | MCP | ❌ | OAuth 回调 URL |
| `reload_plugins` | 插件 | ❌ | 重新加载插件 |
| `cancel_async_message` | 控制 | ❌ | 取消异步消息 |
| `hook_callback` | Hook | ❌ | Hook 回调 |
| `channel_enable` | 通道 | ❌ | 启用通道 |
| `end_session` | 会话 | ❌ | 结束会话 |
| `claude_authenticate` | 认证 | ✅ | Claude 账号认证 |
| `claude_oauth_callback` | 认证 | ❌ | OAuth 回调 |
| `claude_oauth_wait` | 认证 | ✅ | 等待 OAuth 完成 |
| `remote_control` | 远程 | ❌ | 远程控制连接 |
| `generate_session_title` | 会话 | ❌ | 生成会话标题 |
| `side_question` | 对话 | ❌ | 旁路问题 |
| `ultrareview_launch` | 审查 | ❌ | 超级审查启动 |
| `message_rated` | 反馈 | ❌ | 消息评分 |
| `oauth_token_refresh` | 认证 | ❌ | OAuth token 刷新 |
| `submit_feedback` | 反馈 | ❌ | 提交反馈 |

**真正需要用户交互的只有 5 种**：
1. `can_use_tool` — 工具权限
2. `elicitation` — MCP 用户输入
3. `request_user_dialog` — 自定义对话框
4. `mcp_authenticate` — MCP 认证
5. `claude_authenticate` / `claude_oauth_wait` — Claude 账号认证

---

## 九、未验证行为

1. **`SDKControlRequestUserDialogRequest` 的实际触发场景**：已知 `dialog_kind` 包括 `it2_setup` 和 `computer_use_approval`，但具体在哪些工具调用时触发，需要在有 Computer Use 等高级工具时验证
2. **`pending_permission_requests` 的行为**：当 `ControlResponse` 返回 error 时，可能包含排队的权限请求，其排队策略需要验证
3. **`permissionPromptToolName` 的具体行为**：设置后权限请求是否真的通过 MCP 工具路由，需要实验验证
4. **`decision_reason_type` 的各种值**：在什么场景下分别触发 `rule`/`mode`/`safetyCheck` 等，需要设计实验逐一验证
5. **`classifier_approvable` 与 `auto` 模式的交互**：auto 模式下分类器如何使用 `classifier_approvable` 字段

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `test/integration/tool-ask-user-question.spec.ts` | AskUserQuestion 交互测试（16 cases） |
| `raw/tool-ask-user-question-behavior.md` | AskUserQuestion 洞察文档 |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | SDK 类型定义（权限、Elicitation、Control Request） |
