# Claude Agent SDK query() Options 参数

**Source**: @anthropic-ai/claude-agent-sdk@0.2.133 TypeScript 类型定义
**Collected**: 2026-05-08
**Published**: 2026-05-08

---

## Options 类型完整定义

### 控制与中断

| 参数 | 类型 | 说明 |
|------|------|------|
| `abortController` | `AbortController` | 取消查询的控制器 |

### 工作目录与文件系统

| 参数 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 当前工作目录，默认 `process.cwd()` |
| `additionalDirectories` | `string[]` | Claude 可访问的额外目录（绝对路径） |
| `enableFileCheckpointing` | `boolean` | 启用文件检查点，可回滚文件状态 |

### 模型配置

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | Claude 模型，如 `claude-opus-4-7`、`claude-sonnet-4-6` |
| `fallbackModel` | `string` | 主模型失败时的备用模型 |

### 推理与思考

| 参数 | 类型 | 说明 |
|------|------|------|
| `thinking` | `ThinkingConfig` | 控制思考行为：`{ type: 'adaptive' }` (默认) / `{ type: 'enabled', budgetTokens: N }` / `{ type: 'disabled' }` |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | 推理强度级别 |
| `maxThinkingTokens` | `number` | 最大思考 token 数（已弃用，用 `thinking` 代替） |

### 权限控制

| 参数 | 类型 | 说明 |
|------|------|------|
| `permissionMode` | `PermissionMode` | 权限模式：`'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'` / `'dontAsk'` / `'auto'` |
| `allowDangerouslySkipPermissions` | `boolean` | 使用 `bypassPermissions` 时必须设为 `true` |
| `allowedTools` | `string[]` | 自动允许的工具列表 |
| `disallowedTools` | `string[]` | 禁用的工具列表 |
| `tools` | `string[] \| { type: 'preset', preset: 'claude_code' }` | 可用工具集 |
| `canUseTool` | `CanUseTool` | 自定义权限处理函数 |
| `permissionPromptToolName` | `string` | 用于权限提示的 MCP 工具名称 |

### Agent 配置

| 参数 | 类型 | 说明 |
|------|------|------|
| `agent` | `string` | 主线程使用的 agent 名称 |
| `agents` | `Record<string, AgentDefinition>` | 自定义子代理定义 |
| `skills` | `string[] \| 'all'` | 启用的技能列表 |

### MCP 服务器

| 参数 | 类型 | 说明 |
|------|------|------|
| `mcpServers` | `Record<string, McpServerConfig>` | MCP 服务器配置 |

### 会话管理

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 自定义会话 ID（UUID 格式） |
| `resume` | `string` | 要恢复的会话 ID |
| `resumeSessionAt` | `string` | 恢复到特定消息 ID |
| `continue` | `boolean` | 继续当前目录最近的对话 |
| `forkSession` | `boolean` | 恢复时创建新会话 ID |
| `persistSession` | `boolean` | 是否持久化会话到磁盘（默认 `true`） |
| `title` | `string` | 会话标题 |

### 限制与预算

| 参数 | 类型 | 说明 |
|------|------|------|
| `maxTurns` | `number` | 最大对话轮次 |
| `maxBudgetUsd` | `number` | 最大预算（美元） |
| `taskBudget` | `{ total: number }` | 任务 token 预算 |

### 输出控制

| 参数 | 类型 | 说明 |
|------|------|------|
| `outputFormat` | `OutputFormat` | 结构化输出格式（JSON Schema） |
| `includePartialMessages` | `boolean` | 包含部分/流式消息事件 |
| `includeHookEvents` | `boolean` | 包含 hook 生命周期事件 |
| `forwardSubagentText` | `boolean` | 转发子代理的文本和思考块 |

### 环境与执行

| 参数 | 类型 | 说明 |
|------|------|------|
| `env` | `{ [key: string]: string \| undefined }` | 环境变量（可通过 `ANTHROPIC_BASE_URL` 设置 API 地址） |
| `executable` | `'bun' \| 'deno' \| 'node'` | JavaScript 运行时 |
| `executableArgs` | `string[]` | 运行时参数 |
| `extraArgs` | `Record<string, string \| null>` | 额外的 CLI 参数 |
| `pathToClaudeCodeExecutable` | `string` | Claude Code 可执行文件路径 |
| `spawnClaudeCodeProcess` | `(options) => SpawnedProcess` | 自定义进程生成函数 |

### 沙箱与安全

| 参数 | 类型 | 说明 |
|------|------|------|
| `sandbox` | `SandboxSettings` | 沙箱设置（命令执行隔离） |

### 系统提示

| 参数 | 类型 | 说明 |
|------|------|------|
| `systemPrompt` | `string \| string[] \| SystemPromptConfig` | 自定义系统提示 |

### Hooks 与回调

| 参数 | 类型 | 说明 |
|------|------|------|
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Hook 回调 |
| `onElicitation` | `OnElicitation` | MCP elicitation 请求处理 |
| `stderr` | `(data: string) => void` | stderr 输出回调 |

### 调试

| 参数 | 类型 | 说明 |
|------|------|------|
| `debug` | `boolean` | 启用调试模式 |
| `debugFile` | `string` | 调试日志文件路径 |

### 设置与插件

| 参数 | 类型 | 说明 |
|------|------|------|
| `settings` | `string \| Settings` | 额外设置（文件路径或对象） |
| `managedSettings` | `Settings` | 策略层设置 |
| `settingSources` | `SettingSource[]` | 要加载的设置源：`'user'` / `'project'` / `'local'` |
| `plugins` | `SdkPluginConfig[]` | 要加载的插件 |
| `toolConfig` | `ToolConfig` | 工具配置 |

### Beta 特性

| 参数 | 类型 | 说明 |
|------|------|------|
| `betas` | `SdkBeta[]` | 启用的 beta 特性 |

### 会话存储

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionStore` | `SessionStore` | 会话存储适配器 |
| `sessionStoreFlush` | `SessionStoreFlush` | 存储刷新策略 |
| `loadTimeoutMs` | `number` | 存储加载超时（默认 60000） |

### 其他

| 参数 | 类型 | 说明 |
|------|------|------|
| `promptSuggestions` | `boolean` | 启用提示建议 |
| `agentProgressSummaries` | `boolean` | 启用子代理进度摘要 |
| `strictMcpConfig` | `boolean` | 严格验证 MCP 配置 |
| `planModeInstructions` | `string` | Plan 模式的工作流指令 |

---

## PermissionMode 枚举值

| 值 | 说明 |
|---|---|
| `'default'` | 标准权限行为，危险操作会提示 |
| `'acceptEdits'` | 自动接受文件编辑操作 |
| `'bypassPermissions'` | 跳过所有权限检查（需 `allowDangerouslySkipPermissions: true`） |
| `'plan'` | 计划模式，不执行工具 |
| `'dontAsk'` | 不提示权限，未预授权则拒绝 |
| `'auto'` | 使用模型分类器自动批准/拒绝权限提示 |

---

## EffortLevel 枚举值

| 值 | 说明 |
|---|---|
| `'low'` | 最少思考，最快响应 |
| `'medium'` | 适度思考 |
| `'high'` | 深度推理（默认） |
| `'xhigh'` | 比 high 更深（仅 Opus 4.7） |
| `'max'` | 最大努力（仅 Opus 4.6/4.7） |
