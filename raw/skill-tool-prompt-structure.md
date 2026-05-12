# Skill 工具对 API 请求结构的影响

通过对比 `tools: []`（禁用所有工具）和 `tools: ['Skill']`（仅启用 Skill 工具）两种模式下的实际 API 请求体，总结如下。

## 对比概览

| 维度 | tools-disabled (`tools: []`) | tools-skill-only (`tools: ['Skill']`) |
|------|------|------|
| `tools` 字段 | `[]` 空数组 | 包含一个 Skill 工具定义 |
| user message 段数 | 2 段 | 3 段（多一段 skill 列表） |
| system prompt | 不变 | 不变 |
| 其他字段 | 不变 | 不变 |

## 差异 1：`tools` 数组

启用 Skill 后，`tools` 中注入一个工具定义：

```json
{
  "name": "Skill",
  "description": "Execute a skill within the main conversation...",
  "input_schema": {
    "type": "object",
    "properties": {
      "skill": {
        "description": "The name of a skill from the available-skills list. Do not guess names.",
        "type": "string"
      },
      "args": {
        "description": "Optional arguments for the skill",
        "type": "string"
      }
    },
    "required": ["skill"],
    "additionalProperties": false
  }
}
```

关键点：
- 工具名固定为 `Skill`
- 输入只有两个字段：`skill`（必填，skill 名称）和 `args`（可选参数）
- description 中明确要求模型只能调用 system-reminder 中列出的 skill，不能猜测

## 差异 2：user message 中注入 skill 列表

在 user message 的 `content` 数组最前面，SDK 插入了一段 `<system-reminder>`，列出所有可用的 skill：

```xml
<system-reminder>
The following skills are available for use with the Skill tool:

- update-config: Use this skill to configure the Claude Code harness via settings.json...
- keybindings-help: Use when the user wants to customize keyboard shortcuts...
- simplify: Review changed code for reuse, quality, and efficiency...
- fewer-permission-prompts: Scan your transcripts for common read-only Bash and MCP tool calls...
- loop: Run a prompt or slash command on a recurring interval...
- claude-api: Build, debug, and optimize Claude API / Anthropic SDK apps...
- init: Initialize a new CLAUDE.md file with codebase documentation
- review: Review a pull request
- security-review: Complete a security review of the pending changes on the current branch
</system-reminder>
```

每个 skill 包含：
- 名称（即调用 Skill 工具时 `skill` 参数的值）
- 触发条件描述（告诉模型什么时候应该调用这个 skill）

## 不变的部分

以下字段在两种模式下完全一致：

- `model` — 使用配置的模型名
- `system` — 固定两段：billing header + agent 身份声明
- `betas` — 相同的 beta 特性列表
- `max_tokens` — 32000
- `thinking` — `{ "type": "adaptive" }`
- `context_management` — clear_thinking 配置
- `output_config` — `{ "effort": "low" }`
- `stream` — `true`

## 结论

SDK 启用 Skill 工具的机制是双管齐下：
1. **工具定义注入**：在 `tools` 数组中添加 Skill 工具的 schema，让模型知道可以通过 tool_use 调用 skill
2. **上下文注入**：在 user message 前插入 `<system-reminder>` 列出可用 skill 清单，让模型知道有哪些 skill 可选以及何时触发

这种设计将 skill 的发现（通过 system-reminder）和执行（通过 tool_use）分离，模型先看到可用列表，再决定是否调用。
