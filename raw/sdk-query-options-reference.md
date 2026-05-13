# Claude Agent SDK query() Options 完整参考

基于 `@anthropic-ai/claude-agent-sdk@0.2.133` 的类型定义提取。

## Options 顶层 Key

| Key | 类型 | 说明 |
|-----|------|------|
| `abortController` | `AbortController` | 取消查询 |
| `additionalDirectories` | `string[]` | 额外可访问目录（绝对路径） |
| `agent` | `string` | 主线程使用的 agent 名称 |
| `agents` | `Record<string, AgentDefinition>` | 自定义 subagent 定义 |
| `allowedTools` | `string[]` | 自动允许的工具名（免权限提示） |
| `allowDangerouslySkipPermissions` | `boolean` | 配合 bypassPermissions 使用 |
| `agentProgressSummaries` | `boolean` | 子 agent 进度摘要 |
| `betas` | `SdkBeta[]` | 启用 beta 特性 |
| `canUseTool` | `CanUseTool` | 自定义权限回调 |
| `continue` | `boolean` | 继续最近会话（与 resume 互斥） |
| `cwd` | `string` | 工作目录（默认 process.cwd()） |
| `debug` | `boolean` | 启用调试日志 |
| `debugFile` | `string` | 调试日志写入文件 |
| `disallowedTools` | `string[]` | 禁用的工具名 |
| `effort` | `EffortLevel` | 推理努力级别 |
| `enableFileCheckpointing` | `boolean` | 启用文件检查点 |
| `env` | `Record<string, string \| undefined>` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | JS 运行时 |
| `executableArgs` | `string[]` | 运行时额外参数 |
| `extraArgs` | `Record<string, string \| null>` | 额外 CLI 参数 |
| `fallbackModel` | `string` | 备用模型 |
| `forkSession` | `boolean` | resume 时 fork 到新 session |
| `forwardSubagentText` | `boolean` | 转发子 agent 文本 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | 事件钩子 |
| `includeHookEvents` | `boolean` | 输出流包含 hook 事件 |
| `includePartialMessages` | `boolean` | 输出流包含流式消息 |
| `loadTimeoutMs` | `number` | sessionStore 加载超时（默认 60000） |
| `managedSettings` | `Settings` | 策略层 settings |
| `maxBudgetUsd` | `number` | 最大预算（美元） |
| `maxThinkingTokens` | `number` | ⚠️ 已废弃，用 thinking |
| `maxTurns` | `number` | 最大对话轮次 |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP 服务器配置 |
| `model` | `string` | 模型名称 |
| `onElicitation` | `OnElicitation` | MCP elicitation 回调 |
| `outputFormat` | `OutputFormat` | 结构化输出格式 |
| `pathToClaudeCodeExecutable` | `string` | Claude Code 可执行文件路径 |
| `permissionMode` | `PermissionMode` | 权限模式 |
| `permissionPromptToolName` | `string` | 权限提示路由到的 MCP 工具 |
| `persistSession` | `boolean` | 会话持久化（默认 true） |
| `planModeInstructions` | `string` | plan 模式自定义指令 |
| `plugins` | `SdkPluginConfig[]` | 加载插件 |
| `promptSuggestions` | `boolean` | 启用 prompt 建议 |
| `resume` | `string` | 恢复指定 session ID |
| `resumeSessionAt` | `string` | 恢复到指定消息 UUID |
| `sandbox` | `SandboxSettings` | 沙箱设置 |
| `sessionId` | `string` | 自定义 session UUID |
| `sessionStore` | `SessionStore` | 外部会话存储 |
| `sessionStoreFlush` | `SessionStoreFlush` | 存储刷新策略 |
| `settings` | `string \| Settings` | 额外 settings（最高优先级） |
| `settingSources` | `SettingSource[]` | 加载哪些文件系统 settings |
| `skills` | `string[] \| 'all'` | 启用的 skill 过滤 |
| `spawnClaudeCodeProcess` | `(options) => SpawnedProcess` | 自定义进程启动 |
| `stderr` | `(data: string) => void` | stderr 回调 |
| `strictMcpConfig` | `boolean` | 严格 MCP 配置校验 |
| `systemPrompt` | `string \| string[] \| PresetConfig` | 系统提示语 |
| `taskBudget` | `{ total: number }` | API 侧 token 预算 |
| `thinking` | `ThinkingConfig` | 思考/推理配置 |
| `title` | `string` | 会话标题 |
| `toolConfig` | `ToolConfig` | 工具配置 |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | 可用工具集 |

## 复合类型展开

### AgentDefinition

| Key | 类型 | 说明 |
|-----|------|------|
| `description` | `string` | agent 描述（必填） |
| `prompt` | `string` | agent 系统提示（必填） |
| `tools` | `string[]` | 允许的工具名 |
| `disallowedTools` | `string[]` | 禁止的工具名 |
| `model` | `string` | 模型（'sonnet'/'opus'/'haiku' 或完整 ID） |
| `skills` | `string[]` | 预加载的 skill 名 |
| `mcpServers` | `AgentMcpServerSpec[]` | MCP 服务器 |
| `criticalSystemReminder_EXPERIMENTAL` | `string` | 关键提醒 |
| `initialPrompt` | `string` | 首轮自动提交的 prompt |
| `maxTurns` | `number` | 最大轮次 |
| `background` | `boolean` | 后台运行 |
| `memory` | `'user' \| 'project' \| 'local'` | 记忆范围 |
| `effort` | `EffortLevel \| number` | 推理努力 |
| `permissionMode` | `PermissionMode` | 权限模式 |

### ThinkingConfig

| 变体 | 字段 | 说明 |
|------|------|------|
| `{ type: 'adaptive' }` | — | Claude 自行决定思考深度（Opus 4.6+） |
| `{ type: 'enabled', budgetTokens: number }` | `budgetTokens` | 固定思考 token 预算 |
| `{ type: 'disabled' }` | — | 禁用思考 |

### systemPrompt

| 变体 | 说明 |
|------|------|
| `string` | 自定义 prompt（追加到基础身份之后） |
| `string[]` | 多段自定义（合并后追加） |
| `{ type: 'preset', preset: 'claude_code' }` | 完整 Claude Code prompt（~26000 chars） |
| `{ type: 'preset', preset: 'claude_code', append: string }` | 完整 + 追加（在动态段之前） |
| `{ type: 'preset', preset: 'claude_code', excludeDynamicSections: true }` | 去动态段（移到 user message） |

### EffortLevel

`'low' | 'medium' | 'high' | 'xhigh' | 'max'`

### PermissionMode

`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`

### SettingSource

`'user' | 'project' | 'local'`

### SandboxSettings

| Key | 类型 | 说明 |
|-----|------|------|
| `enabled` | `boolean` | 启用沙箱 |
| `autoAllowBashIfSandboxed` | `boolean` | 沙箱内自动允许 Bash |
| `failIfUnavailable` | `boolean` | 沙箱不可用时是否失败 |
| `network` | `SandboxNetworkConfig` | 网络配置 |

### SandboxNetworkConfig

| Key | 类型 | 说明 |
|-----|------|------|
| `allowLocalBinding` | `boolean` | 允许本地端口绑定 |
| `allowUnixSockets` | `string[]` | 允许的 Unix socket 路径 |
| `allowedDomains` | `string[]` | 允许的域名 |
| `deniedDomains` | `string[]` | 拒绝的域名 |
| `allowManagedDomainsOnly` | `boolean` | 仅允许管理域名 |

### McpServerConfig（联合类型）

**Stdio 模式：**

| Key | 类型 | 说明 |
|-----|------|------|
| `command` | `string` | 启动命令 |
| `args` | `string[]` | 命令参数 |
| `env` | `Record<string, string>` | 环境变量 |
| `cwd` | `string` | 工作目录 |
| `alwaysLoad` | `boolean` | 始终加载（不延迟） |

**HTTP 模式：**

| Key | 类型 | 说明 |
|-----|------|------|
| `url` | `string` | HTTP URL |
| `headers` | `Record<string, string>` | 请求头 |
| `alwaysLoad` | `boolean` | 始终加载 |

**SDK 内置模式：**

| Key | 类型 | 说明 |
|-----|------|------|
| `mcpServer` | `McpServer` | SDK createSdkMcpServer 实例 |
| `alwaysLoad` | `boolean` | 始终加载 |

### OutputFormat (JsonSchemaOutputFormat)

| Key | 类型 | 说明 |
|-----|------|------|
| `type` | `'json_schema'` | 固定值 |
| `schema` | `object` | JSON Schema 定义 |

### HookCallbackMatcher

| Key | 类型 | 说明 |
|-----|------|------|
| `matcher` | `string` | 匹配模式 |
| `hooks` | `HookCallback[]` | 回调函数数组 |
| `timeout` | `number` | 超时（秒） |

### HookEvent（所有事件类型）

`'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'Notification' | 'UserPromptSubmit' | 'UserPromptExpansion' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact' | 'PermissionRequest' | 'PermissionDenied' | 'Setup' | 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted' | 'Elicitation' | 'ElicitationResult' | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove' | 'InstructionsLoaded' | 'CwdChanged' | 'FileChanged'`

## 关键环境变量

通过 `options.env` 传入，影响 SDK 子进程行为。官方文档共列出 **237 个**环境变量，以下按类别列出对 SDK 封装 Agent 最相关的。

### 认证

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | API key（X-Api-Key 头） |
| `ANTHROPIC_AUTH_TOKEN` | Authorization Bearer token |
| `ANTHROPIC_BASE_URL` | API 端点 URL（代理/网关） |
| `ANTHROPIC_AWS_API_KEY` | Claude Platform on AWS key |
| `ANTHROPIC_AWS_BASE_URL` | AWS 端点 URL |
| `ANTHROPIC_AWS_WORKSPACE_ID` | AWS workspace ID |
| `ANTHROPIC_BEDROCK_BASE_URL` | Bedrock 端点 URL |
| `ANTHROPIC_FOUNDRY_API_KEY` | Microsoft Foundry key |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry 端点 URL |
| `ANTHROPIC_VERTEX_BASE_URL` | Vertex AI 端点 URL |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID |

### 模型

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_MODEL` | 覆盖默认模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus 模型名 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet 模型名 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku 模型名 |
| `ANTHROPIC_SMALL_FAST_MODEL` | ⚠️ 已废弃，Haiku 级后台模型 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | 自定义模型 ID |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 agent 模型 |

### 配置目录

| 变量 | 说明 |
|------|------|
| `CLAUDE_CONFIG_DIR` | 覆盖 ~/.claude 配置目录 |
| `CLAUDE_ENV_FILE` | 自定义 .env 文件路径 |
| `CLAUDE_CODE_TMPDIR` | 临时文件目录 |
| `CLAUDE_CODE_DEBUG_LOGS_DIR` | 调试日志路径 |

### 功能开关（DISABLE 系列）

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用非必要网络（等于 DISABLE_AUTOUPDATER + TELEMETRY + ERROR_REPORTING + FEEDBACK） |
| `CLAUDE_CODE_DISABLE_CRON` | 禁用定时任务和 /loop |
| `CLAUDE_CODE_DISABLE_THINKING` | 强制禁用扩展思考 |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | 禁用自适应推理（回退到固定预算） |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | 禁用所有 CLAUDE.md 加载 |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | 移除 git 工作流指令 |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | 禁用文件检查点 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 禁用后台任务 |
| `CLAUDE_CODE_DISABLE_POLICY_SKILLS` | 跳过系统级 managed skills |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | 禁用快速模式 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 禁用 1M 上下文 |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | 禁用 agent view |
| `DISABLE_TELEMETRY` | 禁用遥测 |
| `DISABLE_PROMPT_CACHING` | 禁用 prompt 缓存 |
| `DISABLE_AUTO_COMPACT` | 禁用自动压缩 |

### 功能启用（ENABLE 系列）

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | 启用遥测 |
| `CLAUDE_CODE_ENABLE_TASKS` | 启用任务功能 |
| `ENABLE_TOOL_SEARCH` | 启用 MCP 工具搜索 |
| `ENABLE_PROMPT_CACHING_1H` | 启用 1 小时 prompt 缓存 TTL |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | 启用 prompt 建议 |

### 遥测/日志

| 变量 | 说明 |
|------|------|
| `OTEL_LOG_RAW_API_BODIES` | 记录原始 API 请求体（`file:<dir>`） |
| `OTEL_LOGS_EXPORTER` | OTEL 日志导出器（`none` 禁用） |
| `OTEL_METRICS_EXPORTER` | OTEL 指标导出器 |
| `OTEL_TRACES_EXPORTER` | OTEL 追踪导出器 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 端点 |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP 请求头 |
| `OTEL_LOG_TOOL_CONTENT` | 记录工具内容 |
| `OTEL_LOG_TOOL_DETAILS` | 记录工具详情 |
| `OTEL_LOG_USER_PROMPTS` | 记录用户 prompt |

### 超时

| 变量 | 说明 |
|------|------|
| `API_TIMEOUT_MS` | API 请求超时（默认 600000，10 分钟） |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash 命令默认超时（默认 120000） |
| `BASH_MAX_TIMEOUT_MS` | Bash 命令最大超时（默认 600000） |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 流式空闲超时 |
| `MCP_CONNECT_TIMEOUT_MS` | MCP 连接超时 |
| `MCP_TIMEOUT` | MCP 通用超时 |
| `MCP_TOOL_TIMEOUT` | MCP 工具执行超时 |

### SDK 专用

| 变量 | 说明 |
|------|------|
| `CLAUDE_AGENT_SDK_CLIENT_APP` | 客户端应用标识（写入 User-Agent） |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | 禁用内置 subagent（Explore/Plan） |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | MCP 工具名不加 `mcp__<server>__` 前缀 |

### Skill 相关

| 变量 | 说明 |
|------|------|
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | skill 列表字符预算 |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | 额外目录加载 CLAUDE.md（设为 1） |
| `CLAUDE_CODE_DISABLE_POLICY_SKILLS` | 跳过系统级 managed skills |

### 限制

| 变量 | 说明 |
|------|------|
| `MAX_THINKING_TOKENS` | 思考 token 上限 |
| `MAX_MCP_OUTPUT_TOKENS` | MCP 输出 token 上限 |
| `MAX_OUTPUT_LENGTH` | 输出长度上限 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 上下文 token 上限 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 输出 token 上限 |
| `CLAUDE_CODE_MAX_TURNS` | 最大轮次 |
| `CLAUDE_CODE_MAX_RETRIES` | 最大重试次数 |
| `BASH_MAX_OUTPUT_LENGTH` | Bash 输出字符上限 |

### 网络/代理

| 变量 | 说明 |
|------|------|
| `HTTP_PROXY` | HTTP 代理 |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` | 代理解析主机名 |
| `CLAUDE_CODE_CERT_STORE` | CA 证书来源（`bundled,system`） |
| `CLAUDE_CODE_CLIENT_CERT` | mTLS 客户端证书 |
| `CLAUDE_CODE_CLIENT_KEY` | mTLS 客户端私钥 |

### 自动压缩

| 变量 | 说明 |
|------|------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 自动压缩触发百分比（1-100） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 压缩计算用的上下文窗口大小 |
| `DISABLE_AUTO_COMPACT` | 禁用自动压缩 |

### 其他常用

| 变量 | 说明 |
|------|------|
| `CLAUDECODE` | 检测是否在 Claude Code 子进程中（自动设为 1） |
| `CLAUDE_EFFORT` | 当前轮次的 effort 级别（自动设置） |
| `CLAUDE_CODE_SHELL` | 指定 shell |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | 启用 PowerShell 工具 |
| `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` | 使用简化 system prompt |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | 设为 0 移除 billing header（利于缓存） |
