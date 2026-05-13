# Hook PreToolUse 机制观察性洞察文档

> 基于 `@anthropic-ai/claude-agent-sdk` 的观察性测试，日期 2026-05-13

## 核心发现摘要

| # | 问题 | 结论 | 验证方法 |
|---|------|------|----------|
| 1 | Hook 能拿到工具调用的全量参数吗？ | ✅ **能**。tool_name、tool_input（完整对象）、tool_use_id、session_id、cwd 全部可获取 | case-1 |
| 2 | 能通过 hook deny 掉高危操作吗？ | ✅ **能**。返回 `permissionDecision: "deny"` 后，SDK 自动生成 `is_error: true` 的 tool_result，LLM 收到拒绝反馈 | case-2, case-5 |
| 3 | 能通过 updatedInput 修改工具参数吗？ | ✅ **能**。返回 `updatedInput` + `permissionDecision: "allow"` 后，工具使用修改后的参数执行 | case-3 |
| 4 | 不需要子 agent，master agent 直接用 hooks？ | ✅ **能**。hooks 直接在 `query()` 的 `options.hooks` 中配置，不依赖 agent/Agent 机制 | 全部 cases |
| 5 | 多个 hook 并行执行时的优先级？ | ✅ **deny > allow**。即使另一个 hook 返回 allow，deny 仍然生效 | case-5 |
| 6 | systemMessage 注入是否可见？ | ⚠️ **不可见于 API 请求体**。hook 返回的 systemMessage 不出现在 system prompt 或 messages 中 | case-6 |

## 实验矩阵

| Case | 变量 | matcher | Hook 返回 | 观察目标 |
|------|------|---------|-----------|----------|
| 1 | 基线：只记录不干预 | `Read` | `{}` | Hook 参数完整性 |
| 2 | deny .env 文件 | `Read\|Write\|Edit` | `permissionDecision: "deny"` | 安全拦截效果 |
| 3 | 修改 Bash 命令 | `Bash` | `updatedInput + allow` | 参数修改效果 |
| 4 | 无 matcher | 无 | `{}` | 全局 hook 覆盖 |
| 5 | 多 hook 并行 | 无 + 无 | `allow` vs `deny` | 决策优先级 |
| 6 | systemMessage | `Read` | `systemMessage: "..."` | 上下文注入 |

## 详细发现

### 1. Hook 输入参数结构（PreToolUseHookInput）

Hook 回调接收 3 个参数：

```typescript
type HookCallback = (
  input: HookInput,           // 事件详情
  toolUseID: string | undefined,  // 工具调用唯一 ID
  options: { signal: AbortSignal } // 取消信号
) => Promise<HookJSONOutput>;
```

**PreToolUseHookInput 实际字段（case-1 验证）：**

| 字段 | 类型 | 说明 | 是否可获取 |
|------|------|------|-----------|
| `hook_event_name` | `'PreToolUse'` | 事件类型 | ✅ |
| `tool_name` | `string` | 工具名称（如 `Read`, `Bash`, `Write`） | ✅ |
| `tool_input` | `unknown` | **完整工具参数对象**，包含所有字段 | ✅ |
| `tool_use_id` | `string` | 工具调用唯一 ID | ✅ |
| `session_id` | `string` | 会话 ID | ✅ |
| `cwd` | `string` | 当前工作目录 | ✅ |
| `transcript_path` | `string` | 会话记录路径 | ✅ |
| `permission_mode` | `string?` | 权限模式 | ✅ |

**tool_input 的具体内容（以 Read 工具为例）：**
- `file_path`: 完整文件路径
- 可能包含其他工具特定的参数

**tool_input 的具体内容（以 Bash 工具为例）：**
- `command`: 完整命令字符串
- `description`: 命令描述

### 2. deny 机制的实际行为（case-2, case-5）

当 hook 返回以下结构时：

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Security policy: .env files are protected',
  }
}
```

**SDK 的处理流程：**

1. **工具被阻止**：工具不会实际执行
2. **自动生成 tool_result**：SDK 向 LLM 返回一个错误结果：
   ```json
   {
     "type": "tool_result",
     "content": "Security policy: .env files are protected",
     "is_error": true,
     "tool_use_id": "call_xxx"
   }
   ```
3. **LLM 收到拒绝反馈**：`is_error: true` 让 LLM 知道操作失败
4. **LLM 自适应**：LLM 收到拒绝后会解释为什么不能执行，并建议替代方案

**多 hook 并行的优先级（case-5 验证）：**
- 两个 hook 都被触发（并行执行）
- Hook A 返回 `allow`，Hook B 返回 `deny`
- 最终结果：**deny 生效**（deny > allow）
- 这与官方文档一致：deny > defer > ask > allow

### 3. updatedInput 修改机制（case-3）

当 hook 返回以下结构时：

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: {
      ...originalToolInput,
      command: 'echo "HOOK_MODIFIED: original command"',
    },
  }
}
```

**SDK 的处理流程：**

1. **原始 tool_use 保持不变**：API 请求中 `tool_use` 的 `input` 仍是原始值
2. **实际执行使用修改后的参数**：`tool_result` 显示修改后的命令被执行了
3. **必须配合 permissionDecision**：`updatedInput` 需要配合 `permissionDecision: 'allow'` 或 `'ask'`

**关键发现：**
- 在 API 日志（OTEL_LOG_RAW_API_BODIES）中，`tool_use` 的 input 字段仍是原始值
- 但 `tool_result` 的内容证明了修改后的参数被实际执行
- 这意味着 SDK 在内部层面替换了参数，而不是修改 API 请求

### 4. 无 matcher 的全局覆盖（case-4）

不设置 `matcher` 时，hook 对所有工具调用生效。在 case-4 中：

- Prompt 要求使用 Read 和 Grep
- Hook 被触发了多次
- 至少捕获到 `Read` 工具
- 每个 hook 调用都收到了完整的参数

### 5. systemMessage 注入的否定发现（case-6）

**实验：** Hook 返回 `systemMessage: "HOOK_INJECTED: Remember that all version information is confidential..."`

**结果：**
- 在 API 请求体（system prompt + messages）中完全找不到 `HOOK_INJECTED` 关键字
- 对比 case-1（无 systemMessage）和 case-6（有 systemMessage）的请求大小差异 < 10 bytes
- 这说明 `systemMessage` 可能：
  1. 在 SDK 内部的某个中间层处理，不反映到 API 请求中
  2. 仅在流式消息中传递（不影响发送到 LLM 的内容）
  3. 需要 `settingSources` 非 `[]` 才能生效
  4. 或者当前 SDK 版本中此功能的行为与文档描述不一致

**这需要进一步验证。**

### 6. Master Agent 直接使用 hooks（全部 cases）

**关键确认：**
- Hooks 在 `query()` 的 `options.hooks` 中配置
- 不需要创建子 agent（`Agent` 工具）
- 不需要 `agents` 配置
- Hooks 在 master agent 的主循环中直接生效
- 与 `settingSources: []` 兼容（不依赖 filesystem 配置发现）

## 实际应用建议

### 1. 安全策略：禁止读取 .env 文件

```typescript
const protectEnvFiles: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;

  // 只拦截文件操作工具
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(preInput.tool_name)) {
    const filePath = (toolInput?.file_path as string) || '';
    const fileName = filePath.split('/').pop()?.split('\\').pop() || '';

    if (fileName === '.env' || fileName.endsWith('.env')) {
      return {
        hookSpecificOutput: {
          hookEventName: preInput.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Security: .env files are protected',
        },
      };
    }
  }

  return {}; // 允许其他操作
};

// 使用
for await (const message of query({
  prompt: 'Do something',
  options: {
    hooks: {
      PreToolUse: [{ hooks: [protectEnvFiles] }],
    },
  },
})) { ... }
```

### 2. 审计日志：记录所有工具调用

```typescript
const auditLogger: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  await sendToAuditLog({
    tool: preInput.tool_name,
    args: preInput.tool_input,
    session: preInput.session_id,
    timestamp: new Date().toISOString(),
  });
  return { async: true }; // 异步模式，不阻塞执行
};
```

### 3. 沙箱重定向

```typescript
const redirectToSandbox: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;

  if (['Write', 'Edit'].includes(preInput.tool_name) && toolInput.file_path) {
    return {
      hookSpecificOutput: {
        hookEventName: preInput.hook_event_name,
        permissionDecision: 'allow',
        updatedInput: {
          ...toolInput,
          file_path: `/sandbox${toolInput.file_path}`,
        },
      },
    };
  }
  return {};
};
```

## 未验证行为

| # | 行为 | 需要进一步验证 |
|---|------|---------------|
| 1 | `systemMessage` 的实际注入路径 | 需要检查 SDK 内部代码或用不同 settingSources 测试 |
| 2 | `permissionDecision: "ask"` 在 headless 模式下的行为 | 需要 canUseTool 回调或 PermissionRequest hook |
| 3 | `permissionDecision: "defer"` 的恢复机制 | 需要 `resumeDeferredToolCall` API |
| 4 | Hook 超时行为 | 需要设置极短 timeout 验证 |
| 5 | PostToolUse + updatedToolOutput | 修改工具输出后 LLM 看到什么 |
| 6 | 子 agent 内的 hook 继承 | 子 agent 是否继承父 agent 的 hooks |
| 7 | Shell command hooks 与 callback hooks 的优先级 | settingSources 加载的 hooks 和 programmatic hooks 的冲突处理 |

## 测试文件

- 测试：`test/integration/hook-pre-tool-use.spec.ts`
- 日志：`test/integration/tmp/hook-pre-tool-use/`
