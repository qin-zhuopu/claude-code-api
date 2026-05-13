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

## 其他环境变量（与封装 Agent 关系不大）

以下变量主要用于 CLI 界面、特定云平台区域配置、插件管理等场景，对 SDK 封装 Agent 意义不大，但为完整性列出。

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` | Override the Bedrock Mantle endpoint URL. See [Mantle endpoint](/en/amazon-bedrock#use-the-mantle-endpoint) |
| `ANTHROPIC_BEDROCK_SERVICE_TIER` | Bedrock [service tier](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html) (`default`, `f |
| `ANTHROPIC_BETAS` | Comma-separated list of additional `anthropic-beta` header values to include in API requests. Claude Code already sends  |
| `ANTHROPIC_CUSTOM_HEADERS` | Custom headers to add to requests (`Name: Value` format, newline-separated for multiple headers) |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | Display description for the custom model entry in the `/model` picker. Defaults to `Custom model (<model-id>)` when not  |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` | Display name for the custom model entry in the `/model` picker. Defaults to the model ID when not set |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES` | See [Model configuration](/en/model-config#customize-pinned-model-display-and-capabilities) |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry resource name (for example, `my-resource`). Required if `ANTHROPIC_FOUNDRY_BASE_URL` is not set (see [Microsoft  |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | Override AWS region for the Haiku-class model when using Bedrock or Bedrock Mantle |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key for authentication (see [Bedrock API keys](https://aws.amazon.com/blogs/machine-learning/accelerate-ai-d |
| `CCR_FORCE_BUNDLE` | Set to `1` to force [`claude --remote`](/en/claude-code-on-the-web#send-local-repositories-without-github) to bundle and |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | Stall timeout in milliseconds for background subagents. Default `600000` (10 minutes). The timer resets on each streamin |
| `CLAUDE_AUTO_BACKGROUND_TASKS` | Set to `1` to force-enable automatic backgrounding of long-running agent tasks. When enabled, subagents are moved to the |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | Return to the original working directory after each Bash or PowerShell command in the main session |
| `CLAUDE_CODE_ACCESSIBILITY` | Set to `1` to keep the native terminal cursor visible and disable the inverted-text cursor indicator. Allows screen magn |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | Interval in milliseconds at which credentials should be refreshed (when using [`apiKeyHelper`](/en/settings#available-se |
| `CLAUDE_CODE_AUTO_CONNECT_IDE` | Override automatic [IDE connection](/en/vs-code). By default, Claude Code connects automatically when launched inside a  |
| `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | Passphrase for encrypted CLAUDE\_CODE\_CLIENT\_KEY (optional) |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | Minimum log level written to the debug log file. Values: `verbose`, `debug` (default), `info`, `warn`, `error`. Set to ` |
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | Set to `1` to disable [fullscreen rendering](/en/fullscreen) and use the classic main-screen renderer. The conversation  |
| `CLAUDE_CODE_DISABLE_ATTACHMENTS` | Set to `1` to disable attachment processing. File mentions with `@` syntax are sent as plain text instead of being expan |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Set to `1` to strip Anthropic-specific `anthropic-beta` request headers and beta tool-schema fields (such as `defer_load |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | Set to `1` to disable the "How is Claude doing?" session quality surveys. Surveys are also disabled when `DISABLE_TELEME |
| `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | Set to `1` to prevent automatic remapping of Opus 4.0 and 4.1 to the current Opus version on the Anthropic API. Use when |
| `CLAUDE_CODE_DISABLE_MOUSE` | Set to `1` to disable mouse tracking in [fullscreen rendering](/en/fullscreen). Keyboard scrolling with `PgUp` and `PgDn |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | Set to `1` to disable the non-streaming fallback when a streaming request fails mid-stream. Streaming errors propagate t |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | Set to `1` to skip automatic addition of the official plugin marketplace on first run |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | Set to `1` to disable automatic terminal title updates based on conversation context |
| `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` | Set to `1` to disable virtual scrolling in [fullscreen rendering](/en/fullscreen) and render every message in the transc |
| `CLAUDE_CODE_EFFORT_LEVEL` | Set the effort level for supported models. Values: `low`, `medium`, `high`, `xhigh`, `max`, or `auto` to use the model d |
| `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | Override [session recap](/en/interactive-mode#session-recap) availability. Set to `0` to force recaps off regardless of  |
| `CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH` | Set to `1` to refresh plugin state at turn boundaries in [non-interactive mode](/en/headless) after a background install |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Controls whether tool call inputs stream from the API as Claude generates them. With this off, a large tool input such a |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | Set to `1` to populate the `/model` picker from your gateway's `/v1/models` endpoint when `ANTHROPIC_BASE_URL` points at |
| `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` | Time in milliseconds to wait after the query loop becomes idle before automatically exiting. Useful for automated workfl |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Set to `1` to enable [agent teams](/en/agent-teams). Agent teams are experimental and disabled by default |
| `CLAUDE_CODE_EXTRA_BODY` | JSON object to merge into the top level of every API request body. Useful for passing provider-specific parameters that  |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | Override the default token limit for file reads. Useful when you need to read larger files in full |
| `CLAUDE_CODE_FORCE_SYNC_OUTPUT` | Set to `1` to force-enable DEC private mode 2026 [synchronized output](https://gist.github.com/christianparpart/d8a62cc1 |
| `CLAUDE_CODE_FORK_SUBAGENT` | Set to `1` to enable [forked subagents](/en/sub-agents#fork-the-current-conversation). A forked subagent inherits the fu |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows only: path to the Git Bash executable (`bash.exe`). Use when Git Bash is installed but not in your PATH. See [Wi |
| `CLAUDE_CODE_GLOB_HIDDEN` | Set to `false` to exclude dotfiles from results when Claude invokes the [Glob tool](/en/tools-reference#glob-tool-behavi |
| `CLAUDE_CODE_GLOB_NO_IGNORE` | Set to `false` to make the [Glob tool](/en/tools-reference#glob-tool-behavior) respect `.gitignore` patterns. By default |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | Timeout in seconds for Glob tool file discovery. Defaults to 20 seconds on most platforms and 60 seconds on WSL |
| `CLAUDE_CODE_HIDE_CWD` | Set to `1` to hide the working directory in the startup logo. Useful for screenshares or recordings where the path expos |
| `CLAUDE_CODE_IDE_HOST_OVERRIDE` | Override the host address used to connect to the IDE extension. By default Claude Code auto-detects the correct address, |
| `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` | Skip auto-installation of IDE extensions. Equivalent to setting [`autoInstallIdeExtension`](/en/settings#global-config-s |
| `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` | Set to `1` to skip validation of IDE lockfile entries during connection. Use when auto-connect fails to find your IDE de |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Maximum number of read-only tools and subagents that can execute in parallel (default: 10). Higher values increase paral |
| `CLAUDE_CODE_MCP_ALLOWLIST_ENV` | Set to `1` to spawn stdio MCP servers with only a safe baseline environment plus the server's configured `env`, instead  |
| `CLAUDE_CODE_NATIVE_CURSOR` | Set to `1` to show the terminal's own cursor at the input caret instead of a drawn block. The cursor respects the termin |
| `CLAUDE_CODE_NEW_INIT` | Set to `1` to make `/init` run an interactive setup flow. The flow asks which files to generate, including CLAUDE.md, sk |
| `CLAUDE_CODE_NO_FLICKER` | Set to `1` to enable [fullscreen rendering](/en/fullscreen), a research preview that reduces flicker and keeps memory fl |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | OAuth refresh token for Claude.ai authentication. When set, `claude auth login` exchanges this token directly instead of |
| `CLAUDE_CODE_OAUTH_SCOPES` | Space-separated OAuth scopes the refresh token was issued with, such as `"user:profile user:inference user:sessions:clau |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth access token for Claude.ai authentication. Alternative to `/login` for SDK and automated environments. Takes prece |
| `CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS` | Timeout in milliseconds for flushing pending OpenTelemetry spans (default: 5000). See [Monitoring](/en/monitoring-usage) |
| `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` | Interval for refreshing dynamic OpenTelemetry headers in milliseconds (default: 1740000 / 29 minutes). See [Dynamic head |
| `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` | Timeout in milliseconds for the OpenTelemetry exporter to finish on shutdown (default: 2000). Increase if metrics are dr |
| `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE` | Set to `1` to let Claude Code run your package manager's upgrade command in the background when a new version is availab |
| `CLAUDE_CODE_PERFORCE_MODE` | Set to `1` to enable Perforce-aware write protection. When set, Edit, Write, and NotebookEdit fail with a `p4 edit <file |
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | Override the plugins root directory. Despite the name, this sets the parent directory, not the cache itself: marketplace |
| `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` | Timeout in milliseconds for git operations when installing or updating plugins (default: 120000). Increase this value fo |
| `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` | Set to `1` to keep the existing marketplace cache when a `git pull` fails instead of wiping and re-cloning. Useful in of |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | Path to one or more read-only plugin seed directories, separated by `:` on Unix or `;` on Windows. Use this to bundle a  |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | Set by host platforms that embed Claude Code and manage model provider routing on its behalf. When set, provider-selecti |
| `CLAUDE_CODE_REMOTE` | Set automatically to `true` when Claude Code is running as a [cloud session](/en/claude-code-on-the-web). Read this from |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Set automatically in [cloud sessions](/en/claude-code-on-the-web) to the current session's ID. Read this to construct a  |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | Set to `1` to automatically resume if the previous session ended mid-turn. Used in SDK mode so the model continues witho |
| `CLAUDE_CODE_SCRIPT_CAPS` | JSON object limiting how many times specific scripts may be invoked per session when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`  |
| `CLAUDE_CODE_SCROLL_SPEED` | Set the mouse wheel scroll multiplier in [fullscreen rendering](/en/fullscreen#mouse-wheel-scrolling). Accepts values fr |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | Override the time budget in milliseconds for [SessionEnd](/en/hooks#sessionend) hooks. Applies to session exit, `/clear` |
| `CLAUDE_CODE_SESSION_ID` | Set automatically in Bash and PowerShell tool subprocesses to the current session ID. Matches the `session_id` field pas |
| `CLAUDE_CODE_SHELL_PREFIX` | Command prefix that wraps shell commands Claude Code spawns: Bash tool calls, [hook](/en/hooks) commands, and stdio [MCP |
| `CLAUDE_CODE_SIMPLE` | Set to `1` to run with a minimal system prompt and only the Bash, file read, and file edit tools. MCP tools from `--mcp- |
| `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH` | Skip client-side authentication for [Claude Platform on AWS](/en/claude-platform-on-aws), for gateways that sign request |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Skip AWS authentication for Bedrock (for example, when using an LLM gateway) |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | Skip Azure authentication for Microsoft Foundry (for example, when using an LLM gateway) |
| `CLAUDE_CODE_SKIP_MANTLE_AUTH` | Skip AWS authentication for Bedrock Mantle (for example, when using an LLM gateway) |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | Set to `1` to skip writing prompt history and session transcripts to disk. Sessions started with this variable set do no |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | Skip Google authentication for Vertex (for example, when using an LLM gateway) |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Set to `1` to strip Anthropic and cloud provider credentials from subprocess environments (Bash tool, hooks, MCP stdio s |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | Set to `1` in non-interactive mode (the `-p` flag) to wait for plugin installation to complete before the first query. W |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | Timeout in milliseconds for synchronous plugin installation. When exceeded, Claude Code proceeds without plugins and log |
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | Set to `false` to disable syntax highlighting in diff output. Useful when colors interfere with your terminal setup. To  |
| `CLAUDE_CODE_TASK_LIST_ID` | Share a task list across sessions. Set the same ID in multiple Claude Code instances to coordinate on a shared task list |
| `CLAUDE_CODE_TEAM_NAME` | Name of the agent team this teammate belongs to. Set automatically on [agent team](/en/agent-teams) members |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | Set to `1` to allow 24-bit truecolor output inside tmux. By default, Claude Code clamps to 256 colors when `$TMUX` is se |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Use [Claude Platform on AWS](/en/claude-platform-on-aws) |
| `CLAUDE_CODE_USE_BEDROCK` | Use [Bedrock](/en/amazon-bedrock) |
| `CLAUDE_CODE_USE_FOUNDRY` | Use [Microsoft Foundry](/en/microsoft-foundry) |
| `CLAUDE_CODE_USE_MANTLE` | Use the Bedrock [Mantle endpoint](/en/amazon-bedrock#use-the-mantle-endpoint) |
| `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` | Set to `1` to discover custom commands, subagents, and output styles using Node.js file APIs instead of ripgrep. Set thi |
| `CLAUDE_CODE_USE_VERTEX` | Use [Vertex](/en/google-vertex-ai) |
| `CLAUDE_ENABLE_BYTE_WATCHDOG` | Set to `1` to force-enable the byte-level streaming idle watchdog, or set to `0` to force-disable it. When unset, the wa |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | Set to `1` to enable the event-level streaming idle watchdog. Off by default. For Bedrock, Vertex, and Foundry, this is  |
| `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` | Prefix for auto-generated [Remote Control](/en/remote-control) session names when no explicit name is provided. Defaults |
| `DISABLE_AUTOUPDATER` | Set to `1` to disable automatic background updates. Manual `claude update` still works. Use `DISABLE_UPDATES` to block b |
| `DISABLE_COMPACT` | Set to `1` to disable all compaction: both automatic compaction and the manual `/compact` command |
| `DISABLE_COST_WARNINGS` | Set to `1` to disable cost warning messages |
| `DISABLE_DOCTOR_COMMAND` | Set to `1` to hide the `/doctor` command. Useful for managed deployments where users should not run installation diagnos |
| `DISABLE_ERROR_REPORTING` | Set to `1` to opt out of Sentry error reporting |
| `DISABLE_EXTRA_USAGE_COMMAND` | Set to `1` to hide the `/extra-usage` command that lets users purchase additional usage beyond rate limits |
| `DISABLE_FEEDBACK_COMMAND` | Set to `1` to disable the `/feedback` command. The older name `DISABLE_BUG_COMMAND` is also accepted |
| `DISABLE_GROWTHBOOK` | Set to `1` to disable GrowthBook feature-flag fetching and use code defaults for every flag. Telemetry event logging sta |
| `DISABLE_INSTALLATION_CHECKS` | Set to `1` to disable installation warnings. Use only when manually managing the installation location, as this can mask |
| `DISABLE_INSTALL_GITHUB_APP_COMMAND` | Set to `1` to hide the `/install-github-app` command. Already hidden when using third-party providers (Bedrock, Vertex,  |
| `DISABLE_INTERLEAVED_THINKING` | Set to `1` to prevent sending the interleaved-thinking beta header. Useful when your LLM gateway or provider does not su |
| `DISABLE_LOGIN_COMMAND` | Set to `1` to hide the `/login` command. Useful when authentication is handled externally via API keys or `apiKeyHelper` |
| `DISABLE_LOGOUT_COMMAND` | Set to `1` to hide the `/logout` command |
| `DISABLE_PROMPT_CACHING_HAIKU` | Set to `1` to disable prompt caching for Haiku models |
| `DISABLE_PROMPT_CACHING_OPUS` | Set to `1` to disable prompt caching for Opus models |
| `DISABLE_PROMPT_CACHING_SONNET` | Set to `1` to disable prompt caching for Sonnet models |
| `DISABLE_UPDATES` | Set to `1` to block all updates including manual `claude update` and `claude install`. Stricter than `DISABLE_AUTOUPDATE |
| `DISABLE_UPGRADE_COMMAND` | Set to `1` to hide the `/upgrade` command |
| `DO_NOT_TRACK` | Set to `1` to opt out of telemetry. Equivalent to setting `DISABLE_TELEMETRY`. Honored as the [standard cross-tool conve |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Set to `false` to disable [claude.ai MCP servers](/en/mcp#use-mcp-servers-from-claude-ai) in Claude Code. Enabled by def |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | Deprecated. Use `ENABLE_PROMPT_CACHING_1H` instead |
| `FALLBACK_FOR_ALL_PRIMARY_MODELS` | Set to any non-empty value to trigger fallback to [`--fallback-model`](/en/cli-reference#cli-flags) after repeated overl |
| `FORCE_AUTOUPDATE_PLUGINS` | Set to `1` to force plugin auto-updates even when the main auto-updater is disabled via `DISABLE_AUTOUPDATER` |
| `FORCE_PROMPT_CACHING_5M` | Set to `1` to force the 5-minute prompt cache TTL even when 1-hour TTL would otherwise apply. Overrides `ENABLE_PROMPT_C |
| `HTTPS_PROXY` | Specify HTTPS proxy server for network connections |
| `IS_DEMO` | Set to `1` to enable demo mode: hides your email and organization name from the header and `/status` output, and skips o |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | Number of times to retry when the model's response fails validation against the [`--json-schema`](/en/cli-reference#cli- |
| `MCP_CLIENT_SECRET` | OAuth client secret for MCP servers that require [pre-configured credentials](/en/mcp#use-pre-configured-oauth-credentia |
| `MCP_CONNECTION_NONBLOCKING` | Set to `true` in non-interactive mode (`-p`) to skip the MCP connection wait entirely. Useful for scripted pipelines whe |
| `MCP_OAUTH_CALLBACK_PORT` | Fixed port for the OAuth redirect callback, as an alternative to `--callback-port` when adding an MCP server with [pre-c |
| `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` | Maximum number of remote MCP servers (HTTP/SSE) to connect in parallel during startup (default: 20) |
| `MCP_SERVER_CONNECTION_BATCH_SIZE` | Maximum number of local MCP servers (stdio) to connect in parallel during startup (default: 3) |
| `NO_PROXY` | List of domains and IPs to which requests will be directly issued, bypassing proxy |
| `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | Set to `false` to exclude account UUID from metrics attributes (default: included). See [Monitoring](/en/monitoring-usag |
| `OTEL_METRICS_INCLUDE_SESSION_ID` | Set to `false` to exclude session ID from metrics attributes (default: included). See [Monitoring](/en/monitoring-usage) |
| `OTEL_METRICS_INCLUDE_VERSION` | Set to `true` to include Claude Code version in metrics attributes (default: excluded). See [Monitoring](/en/monitoring- |
| `TASK_MAX_OUTPUT_LENGTH` | Maximum number of characters in [subagent](/en/sub-agents) output before truncation (default: 32000, maximum: 160000). W |
| `USE_BUILTIN_RIPGREP` | Set to `0` to use system-installed `rg` instead of `rg` included with Claude Code |
| `VERTEX_REGION_CLAUDE_3_5_HAIKU` | Override region for Claude 3.5 Haiku when using Vertex AI |
| `VERTEX_REGION_CLAUDE_3_5_SONNET` | Override region for Claude 3.5 Sonnet when using Vertex AI |
| `VERTEX_REGION_CLAUDE_3_7_SONNET` | Override region for Claude 3.7 Sonnet when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_0_OPUS` | Override region for Claude 4.0 Opus when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_0_SONNET` | Override region for Claude 4.0 Sonnet when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_1_OPUS` | Override region for Claude 4.1 Opus when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_5_OPUS` | Override region for Claude Opus 4.5 when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_5_SONNET` | Override region for Claude Sonnet 4.5 when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_6_OPUS` | Override region for Claude Opus 4.6 when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_6_SONNET` | Override region for Claude Sonnet 4.6 when using Vertex AI |
| `VERTEX_REGION_CLAUDE_4_7_OPUS` | {/* min-version: 2.1.111 */}Override region for Claude Opus 4.7 when using Vertex AI |
| `VERTEX_REGION_CLAUDE_HAIKU_4_5` | Override region for Claude Haiku 4.5 when using Vertex AI |
