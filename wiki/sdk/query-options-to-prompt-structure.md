# query() Options 到 API 请求体结构的映射

> Sources: @anthropic-ai/claude-agent-sdk 源码分析 (2026-05-12); SDK 文档交叉引用 (2026-05-08)
> Raw: [../../raw/sdk/2026-05-12-query-prompt-structure-analysis.md](../../raw/sdk/2026-05-12-query-prompt-structure-analysis.md)

## Overview

`query()` 的 options 参数通过 SDK 内部转换为发送给 LLM 的 API 请求体。本文档基于实际捕获的请求体（`test/integration/tmp/api-bodies/`）与 SDK 文档交叉分析，梳理每个选项如何影响最终的 API 请求结构。

## 请求体顶层结构

SDK 发出的请求包含 11 个顶层字段，每个字段受不同 options 控制：

| 字段 | 受控 Options | 默认行为 |
|------|-------------|---------|
| `model` | `env.ANTHROPIC_DEFAULT_*_MODEL` 系列环境变量 | CLI 默认模型 |
| `messages` | `prompt` + 动态上下文注入 | 用户输入 + 系统提醒 |
| `system` | `systemPrompt`, `settingSources` | 完整 Claude Code 提示语 |
| `tools[]` | `tools`, `agents`, `mcpServers`, `plugins`, `skills` | 全部内置工具 |
| `betas[]` | `betas` | 空数组 |
| `metadata` | SDK 自动注入 | device_id + session_id |
| `max_tokens` | SDK 根据模型设定 | 模型默认值 |
| `thinking` | `thinking` | `{type: 'adaptive'}` |
| `context_management` | `systemPrompt.excludeDynamicSections` | `{edits: [...]}` |
| `output_config` | `effort` | `{effort: 'high'}` |
| `stream` | SDK 强制 | `true` |

## System Prompt 结构

### 默认行为（最大化）

当 `systemPrompt` 未设置且 `settingSources` 使用默认值时，SDK 加载 Claude Code 的**完整系统提示语**，包含：
- 工具使用指令和最佳实践
- 代码风格和格式规范
- 响应语气和详细度指引
- 安全和安全指令
- 当前工作目录、git 状态、memory 路径等环境上下文

### settingSources: [] 的退化效果

测试代码中设置 `settingSources: []` 时，禁掉了文件系统设置源（用户/项目/本地），导致 CLAUDE.md 和 output-styles 无法加载。system 数组退化为两行：

```json
"system": [
  {"type": "text", "text": "x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-ts; cch=00000;"},
  {"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.", "cache_control": {"type": "ephemeral"}}
]
```

### systemPrompt 各模式对比

| systemPrompt 值 | system 内容 | 工具/安全/上下文 |
|-----------------|------------|-----------------|
| `undefined` (默认) | 完整 Claude Code 提示语 | 全部保留 |
| `{type: "preset", preset: "claude_code"}` | 同上 | 全部保留 |
| `{type: "preset", preset: "claude_code", append: "..."}` | 完整 + 追加 | 全部保留 |
| `{type: "preset", preset: "claude_code", append: "...", excludeDynamicSections: true}` | 静态部分 + 追加；动态部分移到首条 user message | 全部保留 |
| 自定义字符串 | 仅自定义 | **丢失**（需手动包含工具/安全指令） |

**excludeDynamicSections** 将工作目录、git 状态、memory 路径等动态上下文从 system 移到第一条 user message。这使得不同机器/用户的 system prompt 完全相同，提升 prompt cache 跨会话命中率。代价是环境上下文在 user message 中的权重略低于 system prompt。

## Messages 内部结构

`messages[0].content` 数组包含多个文本块：

1. **可用 Skills 列表** — `<system-reminder>The following skills are available...</system-reminder>`
   - 受 `skills` 选项控制（`'all'` 启用全部，或指定列表）
   - 即使 `settingSources: []` 也会加载（SDK 自动发现文件系统技能）

2. **动态上下文** — `<system-reminder>...# currentDate...</system-reminder>`
   - 包含当前日期、工作目录等信息
   - 受 `excludeDynamicSections` 控制：`true` 时移入 user message

3. **实际用户输入** — 来自 `prompt` 参数，最后一个 content block 带 `cache_control: {type: "ephemeral"}` 标记

## Tools 数组结构

每个工具的结构：
```json
{
  "name": "工具名",
  "description": "详细使用说明（含最佳实践、注意事项、安全指引）",
  "input_schema": {"$schema": "...", "type": "object", "properties": {...}, "required": [...]}
}
```

捕获的请求中 tools 数组包含约 22 个内置工具。

### 影响 tools 数组的 options

| Option | 效果 |
|--------|------|
| 默认（tools 未设置） | 加载全部 Claude Code 内置工具 |
| `tools: {type: "preset", preset: "claude_code"}` | 同上 |
| `tools: ["Read", "Grep"]` | 仅指定工具 |
| `agents` | 增加 Agent 工具定义 |
| `mcpServers` | 增加 MCP 服务器提供的工具 |
| `plugins` | 增加插件工具 |
| `skills` | 启用 Skill 工具并注入技能列表 |
| `allowedTools` | **不限制**工具集，仅自动允许指定工具（不弹窗） |
| `disallowedTools` | **强制拒绝**指定工具，优先级高于 allowedTools 和 permissionMode |
| `settingSources` | **不影响**内置工具集（工具来自 SDK 代码，非文件系统） |

> 注意：`allowedTools` 是常见的误解点。它不限制 Claude 只能使用这些工具，而是将这些工具设为自动允许（不需要用户确认）。要限制工具集，使用 `tools` 或 `disallowedTools`。

## Options 到 API 字段完整映射

| Options 字段 | API 请求体字段 | 映射说明 |
|-------------|---------------|---------|
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` 等 | `model` | 环境变量控制模型选择 |
| `prompt` | `messages[].content[].text` | 用户输入文本 |
| `systemPrompt` | `system[]` | 系统提示语内容 |
| `thinking` | `thinking` | `{type: 'adaptive'}` 或其他配置 |
| `effort` | `output_config.effort` | `'low'` / `'medium'` / `'high'` / `'xhigh'` / `'max'` |
| `betas` | `betas[]` | Beta 功能标识列表 |
| `tools` + `agents` + `mcpServers` + `plugins` + `skills` | `tools[]` | 合并为完整工具集 |
| (SDK 自动) | `metadata.user_id` | device_id + session_id |
| (SDK 自动) | `max_tokens` | 模型默认输出限制 |
| (SDK 自动) | `stream` | 始终为 `true` |

## 关键结论

1. **systemPrompt 默认行为**：未设置时使用 Claude Code 完整系统提示语（最大化）
2. **`settingSources: []` 的副作用**：禁用文件系统设置源后，system prompt 退化为最小化的 agent 标识
3. **核心指令双分布**：工具说明在 `tools[].description` 中，行为指令在 `system[]` 中
4. **`effort` 直接映射**到 `output_config.effort`，默认 `'high'`
5. **`thinking` 默认值**为 `{type: 'adaptive'}`（Opus 4.6+）
6. **内置工具不受 `settingSources` 影响**，来自 SDK 代码而非文件系统
7. **`cache_control: {type: "ephemeral"}`** 附加在最后一个 content block 上，用于 prompt caching
8. **`excludeDynamicSections: true`** 提升跨机器 cache 命中率，代价是环境上下文权重略降

## See Also

- [query() Options 参数参考](query-options-reference.md)
