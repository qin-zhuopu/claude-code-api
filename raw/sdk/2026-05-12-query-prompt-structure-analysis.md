---
name: sdk-query-prompt-structure
description: SDK query() options 生成的 API 请求体结构与 options 影响映射
type: project
---

# SDK query() 生成的 API 请求体结构分析

**来源**: test/integration/local-llm.spec.ts 捕获的实际请求 + SDK 文档交叉分析
**日期**: 2026-05-12

---

## 捕获的请求体顶层结构

从 `test/integration/tmp/api-bodies/20260512-152204/*.request.json` 提取的 11 个顶层字段：

| 字段 | 示例值 | 受控 Options |
|------|--------|-------------|
| `model` | `"Jereh-LLM-NO-THINK-V1"` | `options.env.ANTHROPIC_DEFAULT_*_MODEL` |
| `messages` | `[{role, content[]}]` | `prompt` + 动态上下文 |
| `system` | `[{type, text, cache_control}]` | `systemPrompt`, `settingSources` |
| `tools` | `[{name, description, input_schema}]` | `tools`, `agents`, `mcpServers`, `plugins`, `skills`, `allowedTools`, `disallowedTools` |
| `betas` | `["claude-code-20250219", ...]` | `options.betas` |
| `metadata` | `{user_id: {...}}` | SDK 自动注入 (device_id, session_id) |
| `max_tokens` | `32000` | SDK 根据模型默认值设定 |
| `thinking` | `{type: "adaptive"}` | `options.thinking` (默认 `{type: 'adaptive'}`) |
| `context_management` | `{edits: [...]}` | `systemPrompt.excludeDynamicSections` |
| `output_config` | `{effort: "low"}` | `options.effort` |
| `stream` | `true` | SDK 强制为 `true` |

---

## System Prompt 结构与 systemPrompt 选项的关系

### 默认行为（systemPrompt 未设置）

SDK 使用 Claude Code 的**完整系统提示语**（最大化），包含：
- 工具使用指令和可用工具列表
- 代码风格和格式规范
- 响应语气和详细度设置
- 安全和安全指引
- 当前工作目录和环境上下文

### settingSources: [] 的影响

当测试代码设置 `settingSources: []` 时，禁掉了文件系统设置源（用户/项目/本地），导致 CLAUDE.md、output-styles 等上下文无法注入。此时 system 数组退化为：

```json
"system": [
  {"type": "text", "text": "x-anthropic-billing-header: cc_version=...;"},
  {"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.", "cache_control": {"type": "ephemeral"}}
]
```

### systemPrompt 各模式对比

| systemPrompt 值 | system 数组内容 | 工具/安全/上下文 |
|-----------------|----------------|-----------------|
| `undefined` (默认) | 完整 Claude Code 系统提示语 | 全部保留 |
| `{type: "preset", preset: "claude_code"}` | 完整 Claude Code 系统提示语 | 全部保留 |
| `{type: "preset", preset: "claude_code", append: "..."}` | 完整 + 追加内容 | 全部保留 |
| `{type: "preset", preset: "claude_code", append: "...", excludeDynamicSections: true}` | 静态部分 + 追加；动态部分移到首条 user message | 全部保留 |
| 自定义字符串 | 仅自定义内容 | **丢失**（需手动包含） |

**excludeDynamicSections 效果**：工作目录、git 状态、memory 路径等动态上下文从 system 移到第一条 user message，使不同机器/用户的 system prompt 相同，提升 prompt cache 命中率。

---

## Messages 内部结构

`messages[0].content` 数组包含多个文本块：

1. **可用 Skills 列表** — `<system-reminder>The following skills are available...</system-reminder>`
   - 受 `skills` 选项控制
   - `settingSources: []` 时仍然加载（SDK 自动发现机制）

2. **动态上下文** — `<system-reminder>...# currentDate...</system-reminder>`
   - 受 `systemPrompt.excludeDynamicSections` 影响
   - `true` 时移到第一条 user message 中

3. **实际用户输入** — 来自 `prompt` 参数（带 `cache_control: {type: "ephemeral"}`）

---

## Tools 数组结构与影响选项

捕获请求中 tools 数组包含 22 个内置工具（Agent, AskUserQuestion, Bash, CronCreate, Edit, EnterPlanMode, Glob, Grep, Read, Write, WebFetch, WebSearch 等）。

每个工具的结构：
```json
{
  "name": "工具名",
  "description": "详细使用说明（包含最佳实践、注意事项）",
  "input_schema": {"$schema": "...", "type": "object", "properties": {...}, "required": [...]}
}
```

### 影响 tools 数组的 options

| Option | 效果 |
|--------|------|
| `tools: undefined` (默认) | 加载全部 Claude Code 内置工具 |
| `tools: {type: "preset", preset: "claude_code"}` | 加载全部 Claude Code 内置工具 |
| `tools: ["Read", "Grep"]` | 仅加载指定工具 |
| `agents` | 增加 Agent 工具定义（自定义子代理） |
| `mcpServers` | 增加 MCP 服务器提供的工具 |
| `plugins` | 增加插件提供的工具 |
| `skills` | 增加 Skill 工具 |
| `allowedTools` | **不限制**工具集，仅自动允许指定工具（不弹窗） |
| `disallowedTools` | **强制拒绝**指定工具，优先级高于 allowedTools 和 permissionMode |
| `settingSources: []` | **不减少**内置工具（工具来自 SDK，非文件系统） |

---

## Options → API 字段完整映射表

| Options 字段 | API 请求体字段 | 映射关系 |
|-------------|---------------|---------|
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` 等 | `model` | 通过 env 变量选择模型 |
| `prompt` | `messages[].content[].text` | 用户输入 |
| `systemPrompt` | `system[]` | 系统提示语内容 |
| `thinking` | `thinking` | 思考模式配置 |
| `effort` | `output_config.effort` | 推理强度 |
| `betas` | `betas[]` | Beta 功能列表 |
| `tools`, `agents`, `mcpServers`, `plugins`, `skills` | `tools[]` | 工具集合并 |
| (SDK 自动注入) | `metadata.user_id` | device_id, session_id |
| (SDK 根据模型设定) | `max_tokens` | 最大输出 token |
| (SDK 强制) | `stream: true` | 始终流式传输 |

---

## 关键结论

1. **systemPrompt 默认行为**：未设置时使用 Claude Code 完整系统提示语（最大化），非最小化
2. **`settingSources: []` 副作用**：禁用文件系统设置源，导致 CLAUDE.md 和 output-styles 无法加载，system prompt 退化为最小化
3. **核心指令分布**：工具说明在 `tools[].description` 中，行为指令在 `system[]` 中
4. **`effort` 直接映射**：到 `output_config.effort`，默认 `'high'`
5. **`thinking` 默认值**：`{type: 'adaptive'}`（Opus 4.6+ 支持）
6. **`tools` 不受 `settingSources` 影响**：内置工具来自 SDK，非文件系统
7. **`cache_control: {type: "ephemeral"}`**：附加在最后一个 content block 上，用于 prompt caching
8. **`excludeDynamicSections: true`**：将动态上下文（cwd、git、memory路径）从 system 移到首条 user message，提升跨机器 cache 命中率
