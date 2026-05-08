# query() Options 参数参考

**Sources**: @anthropic-ai/claude-agent-sdk TypeScript 定义 (2026-05-08)
**Raw**: [../../raw/sdk/2024-05-08-query-options-reference.md](../../raw/sdk/2024-05-08-query-options-reference.md)
**Updated**: 2026-05-08

---

本文档是 `@anthropic-ai/claude-agent-sdk` 中 `query()` 函数 `Options` 参数的完整参考。

---

## 快速参考

### 常用参数

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = query({
  prompt: 'Hello, Claude!',
  options: {
    model: 'claude-3-5-sonnet-20241022',  // 模型选择
    cwd: '/path/to/project',              // 工作目录
    permissionMode: 'default',            // 权限模式
    thinking: { type: 'adaptive' },       // 思考模式
  }
});
```

### 通过 env 设置 API Base URL

```typescript
options: {
  env: {
    ANTHROPIC_BASE_URL: 'https://custom-api.example.com'
  }
}
```

---

## 参数分类

### 控制与中断

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `abortController` | `AbortController` | - | 取消查询的控制器 |

### 工作目录与文件系统

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cwd` | `string` | `process.cwd()` | 当前工作目录 |
| `additionalDirectories` | `string[]` | - | Claude 可访问的额外目录（绝对路径） |
| `enableFileCheckpointing` | `boolean` | - | 启用文件检查点，可回滚文件状态 |

### 模型配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | `string` | CLI 默认模型 | Claude 模型，如 `claude-opus-4-7`、`claude-sonnet-4-6` |
| `fallbackModel` | `string` | - | 主模型失败时的备用模型 |

### 推理与思考

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `thinking` | `ThinkingConfig` | - | 控制思考行为 |
| `effort` | `EffortLevel` | - | 推理强度：`'low'` / `'medium'` / `'high'` / `'xhigh'` / `'max'` |
| `maxThinkingTokens` | `number` | - | ~~最大思考 token 数~~（已弃用，用 `thinking`） |

**ThinkingConfig**:
- `{ type: 'adaptive' }` - Claude 自主决定（Opus 4.6+ 默认）
- `{ type: 'enabled', budgetTokens: N }` - 固定预算（旧模型）
- `{ type: 'disabled' }` - 禁用扩展思考

### 权限控制

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `allowDangerouslySkipPermissions` | `boolean` | - | 使用 `bypassPermissions` 时必须为 `true` |
| `allowedTools` | `string[]` | - | 自动允许的工具列表 |
| `disallowedTools` | `string[]` | - | 禁用的工具列表 |
| `tools` | `string[] \| { type: 'preset' }` | - | 可用工具集 |
| `canUseTool` | `CanUseTool` | - | 自定义权限处理函数 |

**PermissionMode 值**:
- `'default'` - 标准行为，危险操作提示
- `'acceptEdits'` - 自动接受文件编辑
- `'bypassPermissions'` - 跳过权限检查
- `'plan'` - 计划模式，不执行
- `'dontAsk'` - 不提示，未授权则拒绝
- `'auto'` - 模型自动判断

### Agent 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agent` | `string` | - | 主线程 agent 名称 |
| `agents` | `Record<string, AgentDefinition>` | - | 自定义子代理 |
| `skills` | `string[] \| 'all'` | - | 启用的技能 |

### MCP 服务器

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mcpServers` | `Record<string, McpServerConfig>` | - | MCP 服务器配置 |

### 会话管理

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sessionId` | `string` | - | 自定义会话 ID（UUID） |
| `resume` | `string` | - | 恢复的会话 ID |
| `resumeSessionAt` | `string` | - | 恢复到特定消息 ID |
| `continue` | `boolean` | - | 继续当前目录最近的对话 |
| `forkSession` | `boolean` | - | 恢复时创建新会话 |
| `persistSession` | `boolean` | `true` | 是否持久化会话 |
| `title` | `string` | - | 会话标题 |

### 限制与预算

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxTurns` | `number` | - | 最大对话轮次 |
| `maxBudgetUsd` | `number` | - | 最大预算（美元） |
| `taskBudget` | `{ total: number }` | - | 任务 token 预算 |

### 输出控制

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `outputFormat` | `OutputFormat` | - | 结构化输出（JSON Schema） |
| `includePartialMessages` | `boolean` | - | 包含流式消息事件 |
| `includeHookEvents` | `boolean` | - | 包含 hook 事件 |
| `forwardSubagentText` | `boolean` | - | 转发子代理文本 |

### 环境与执行

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `env` | `{ [key: string]: string }` | `process.env` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自动检测 | JS 运行时 |
| `pathToClaudeCodeExecutable` | `string` | - | 可执行文件路径 |

**通过 env 设置 API 地址**:
```typescript
env: {
  ANTHROPIC_BASE_URL: 'https://api.example.com'
}
```

### 沙箱与安全

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sandbox` | `SandboxSettings` | - | 命令执行隔离 |

### 系统提示

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `systemPrompt` | `string \| string[] \| Config` | - | 自定义系统提示 |

### Hooks 与回调

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | - | Hook 回调 |
| `onElicitation` | `OnElicitation` | - | MCP 请求处理 |
| `stderr` | `(data: string) => void` | - | stderr 回调 |

### 调试

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `debug` | `boolean` | - | 启用调试模式 |
| `debugFile` | `string` | - | 调试日志文件路径 |

### 设置与插件

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `settings` | `string \| Settings` | - | 额外设置 |
| `managedSettings` | `Settings` | - | 策略层设置 |
| `settingSources` | `SettingSource[]` | - | 设置源：`'user'` / `'project'` / `'local'` |
| `plugins` | `SdkPluginConfig[]` | - | 要加载的插件 |

---

## 完整类型定义

Options 类型包含约 50+ 个可选参数，支持细粒度控制 Claude 的行为。完整定义见 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 中的 `Options` 类型。

---

## 另见

- [Claude API 文档](https://docs.anthropic.com/)
- [Adaptive Thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking)
- [Effort 参数](https://docs.anthropic.com/en/docs/build-with-claude/effort)
