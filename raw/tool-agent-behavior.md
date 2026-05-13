# Agent 工具行为洞察

**实验来源**: `test/integration/agent-tool.spec.ts`（8 组观察性测试）  
**SDK 版本**: `@anthropic-ai/claude-agent-sdk` v2.1.133  
**测试日期**: 2026-05-13

## 核心发现摘要

| # | 发现 | 影响 |
|---|------|------|
| 1 | 自定义 agents 注入到 Agent 工具的 `description` 字段，而非 system prompt | Agent 工具的 description 是模型选择子代理的唯一信息来源 |
| 2 | `agent` 会话模式完全替换 system prompt 和 tools | 子代理运行环境与主会话完全隔离 |
| 3 | 模型不一定设置 `subagent_type`，未设置时使用 general-purpose | 自定义 agent 的 prompt/tools 限制可能不生效 |
| 4 | Agent 工具的 input_schema 只有 6 个字段，其中 2 个 required | 接口简洁，扩展性通过 subagent_type 实现 |
| 5 | 子代理请求在同一个 OTEL 日志目录中产出，可区分（tools 数量不同） | 可通过 tools 数量区分主对话和子代理请求 |
| 6 | `tools: []` 在 agent definition 中不等于"无工具"，general-purpose 仍获得完整工具集 | 只有正确设置 subagent_type 时 tools 限制才生效 |

---

## 实验矩阵

| Case | 配置 | 观察目标 | 关键结论 |
|------|------|----------|----------|
| 1 | 默认配置 + 简单 prompt | Agent 工具是否默认存在 | ✅ 默认 23 个工具中包含 Agent |
| 2 | 自定义 agents + 简单 prompt | agents 配置如何影响请求 | agents 注入到 Agent tool description |
| 3 | 自定义 agent + 触发调用 | Agent 调用的完整流程 | 4 个 request 文件（主 2 + 子 2） |
| 4 | 默认配置 | Agent input_schema 结构 | 6 个属性，2 个 required |
| 5 | tools 不含 Agent | 禁用 Agent 工具 | 精确控制，只有指定的 3 个工具 |
| 6 | agent 会话模式 | 整个会话作为子代理 | system prompt 被替换，tools 被限制 |
| 7 | 多 agents + 触发特定 agent | 模型如何选择 agent | 模型可能不设置 subagent_type |
| 8 | maxTurns 配置 | maxTurns 是否影响行为 | maxTurns 是 SDK 侧限制，不出现在请求中 |

---

## 详细发现

### 1. Agent 工具的 input_schema

Agent 工具接受以下参数：

```json
{
  "type": "object",
  "properties": {
    "description": {
      "description": "A short (3-5 word) description of the task",
      "type": "string"
    },
    "prompt": {
      "description": "The task for the agent to perform",
      "type": "string"
    },
    "subagent_type": {
      "description": "The type of specialized agent to use for this task",
      "type": "string"
    },
    "model": {
      "description": "Optional model override for this agent...",
      "type": "string",
      "enum": ["sonnet", "opus", "haiku"]
    },
    "run_in_background": {
      "description": "Set to true to run this agent in the background...",
      "type": "boolean"
    },
    "isolation": {
      "description": "Isolation mode. \"worktree\" creates a temporary git worktree...",
      "type": "string",
      "enum": ["worktree"]
    }
  },
  "required": ["description", "prompt"],
  "additionalProperties": false
}
```

**关键点**：
- `description` 和 `prompt` 是唯二的 required 字段
- `subagent_type` 是可选的 — 不设置时使用 general-purpose
- `model` 只接受 3 个枚举值：sonnet、opus、haiku
- `isolation` 只接受 "worktree" 一个值
- `additionalProperties: false` — 不接受额外字段

### 2. 自定义 Agents 的注入机制

自定义 agents 通过 `agents` 选项传入 SDK 后，被注入到 **Agent 工具的 `description` 字段**中：

```
Available agent types and the tools they have access to:
- Explore: Fast read-only search agent... (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- general-purpose: General-purpose agent... (Tools: *)
- Plan: Software architect agent... (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- statusline-setup: Use this agent to configure... (Tools: Read, Edit)
- code-reviewer: Reviews code for quality and best practices (Tools: Read, Grep, Glob)  ← 自定义
- test-writer: Writes unit tests for code (Tools: Read, Write, Bash)                    ← 自定义
```

**注入格式**：`- {name}: {description} (Tools: {tools.join(', ')})`

**影响**：
- 模型通过阅读 Agent 工具的 description 来决定使用哪个子代理
- 自定义 agents 与内置子代理平等列出
- description 写得越清晰，模型越容易正确选择

### 3. Agent 工具调用的完整流程

当模型决定调用 Agent 工具时，产生以下请求序列：

```
主对话 Request 1 (77KB, tools=23)
  → Response 1: tool_use name="Agent" input={description, prompt, subagent_type}
    ↓ SDK 拦截，启动子代理
    子代理 Request 1 (6KB, tools=1)  ← 子代理的第一轮
      → 子代理 Response 1: tool_use name="Read"
    子代理 Request 2 (9KB, tools=1)  ← 子代理的第二轮（含 tool_result）
      → 子代理 Response 2: end_turn（最终输出）
    ↓ SDK 收集子代理最终输出
主对话 Request 2 (81KB, tools=23)  ← 包含 tool_result（子代理输出）
  → Response 2: end_turn（最终回复用户）
```

**关键观察**：
- 子代理请求在同一个 OTEL 日志目录中产出
- 子代理请求可通过 tools 数量区分（子代理 tools 少，主对话 tools=23）
- 子代理的 system prompt 来自 agent definition 的 `prompt` 字段
- 子代理的 system prompt 极短（~200-300 chars），不包含主对话的完整 system prompt
- 子代理的 tool_result 作为文本返回给主对话

### 4. `agent` 会话模式 vs Agent 工具调用

| 维度 | `agent` 会话模式 | Agent 工具调用 |
|------|-----------------|---------------|
| system prompt | 完全替换为 agent 的 prompt | 主对话保持完整 system prompt |
| tools | 只有 agent 定义的工具 | 主对话保持完整 tools |
| Agent 工具 | 不可用（子代理不能再生成子代理） | 可用 |
| system prompt 长度 | ~241 chars | ~77KB（完整） |
| 适用场景 | 整个会话作为专用代理 | 临时委托子任务 |

### 5. `subagent_type` 的关键作用

**当模型设置了 `subagent_type`**：
- SDK 查找对应的 agent definition
- 子代理使用该 definition 的 `prompt` 作为 system prompt
- 子代理使用该 definition 的 `tools` 限制工具集
- 子代理使用该 definition 的 `model` 选择模型

**当模型未设置 `subagent_type`**：
- SDK 使用 `general-purpose` 子代理
- 子代理获得完整的默认 system prompt
- 子代理获得完整的工具集（18 个，排除 Agent、AskUserQuestion、EnterPlanMode、ExitPlanMode、TaskOutput）
- 自定义 agent 的 prompt 和 tools 限制完全不生效

**实际观察**：在 case-7 中，即使 prompt 明确说 "Use the test-writer agent"，模型仍然没有设置 `subagent_type: "test-writer"`。这意味着：
- 不能依赖模型自动正确设置 subagent_type
- 如果需要确保使用特定子代理，应在 prompt 中更明确地指示
- 或者考虑在 SDK 层面做 fallback 匹配

### 6. 默认工具集

**主对话默认工具集（23 个）**：
Agent, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep, NotebookEdit, Read, ScheduleWakeup, Skill, TaskOutput, TaskStop, TodoWrite, WebFetch, WebSearch, Write

**子代理默认工具集（general-purpose, 18 个）**：
Bash, CronCreate, CronDelete, CronList, Edit, EnterWorktree, ExitWorktree, Glob, Grep, NotebookEdit, Read, ScheduleWakeup, Skill, TaskStop, TodoWrite, WebFetch, WebSearch, Write

**子代理排除的工具**：Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskOutput

### 7. 内置子代理类型

从 Agent 工具 description 中提取的内置子代理：

| 类型 | 用途 | 工具限制 |
|------|------|----------|
| `Explore` | 快速只读搜索代码 | 排除 Agent, ExitPlanMode, Edit, Write, NotebookEdit |
| `general-purpose` | 通用多步骤任务 | 所有工具 (*) |
| `Plan` | 设计实现计划 | 排除 Agent, ExitPlanMode, Edit, Write, NotebookEdit |
| `statusline-setup` | 配置状态栏 | Read, Edit |

---

## 实际应用建议

### 定义有效的自定义 Agent

```typescript
agents: {
  'code-reviewer': {
    // description 要清晰具体 — 这是模型选择子代理的唯一依据
    description: 'Reviews code for quality, security, and best practices. Use proactively after code changes.',
    // prompt 要自包含 — 子代理看不到主对话的上下文
    prompt: 'You are a senior code reviewer. Analyze code for bugs, security issues, and style problems. Be concise and actionable.',
    // tools 要最小化 — 只给必要的工具
    tools: ['Read', 'Grep', 'Glob'],
    // model 可选 — 简单任务用 haiku 省成本
    model: 'haiku',
    // maxTurns 限制子代理的轮次（SDK 侧限制）
    maxTurns: 5,
  }
}
```

### 确保模型正确选择子代理

1. **在 prompt 中明确指定**：`"Use the code-reviewer agent to..."`
2. **description 包含触发词**：`"Use proactively after code changes"`
3. **避免歧义**：不同 agents 的 description 应该有明确的区分度

### 区分主对话和子代理请求（日志分析）

```typescript
// 主对话请求：tools 数量 = 23（默认）
// 子代理请求：tools 数量 < 23（受限）
const isSubagentRequest = body.tools?.length < 23;

// 或者检查 system prompt 长度
// 主对话：~77KB
// 子代理：~200-300 chars
const isSubagent = systemPromptChars < 1000;
```

### 禁用 Agent 工具

```typescript
// 方法 1：通过 tools 选项移除（推荐）
options: { tools: ['Read', 'Grep', 'Glob'] }

// 方法 2：通过 disallowedTools 禁止
options: { disallowedTools: ['Agent'] }
```

---

## 未验证的行为（待后续实验）

- [ ] `run_in_background: true` 时的请求结构差异
- [ ] `isolation: "worktree"` 时子代理的工作目录
- [ ] 多个 Agent 工具并行调用时的请求序列
- [ ] `maxTurns` 达到上限时的行为（是否有特殊的 tool_result）
- [ ] 子代理中使用 MCP 工具时的请求结构
- [ ] `SendMessage` 恢复子代理时的请求结构
- [ ] `effort` 字段对子代理请求的影响
- [ ] `memory` 字段的实际效果

---

## 测试环境限制

### 本地 LLM Proxy 兼容性

Agent 工具触发类测试（case-3/7/8）在本地 LLM proxy 上存在以下问题：

1. **"Content block not found" 错误**：proxy 不完整支持 Agent tool_use 的流式响应格式，导致 SDK 无法正确解析子代理的响应
2. **subagent_type 不可靠**：本地 LLM 不一定正确设置 `subagent_type` 字段，导致 SDK 使用 general-purpose 子代理（完整工具集），子代理执行时间不可控
3. **general-purpose 子代理失控**：当 subagent_type 未设置时，general-purpose 子代理获得 18 个工具，可能执行大量不必要的操作

**解决方案**：
- case-3/7/8 标记为 `.skip`，需要兼容的 LLM（如 Anthropic API 直连）才能运行
- 核心结论已从之前的成功运行中提取并记录
- case-1/2/4/5/6 不触发 Agent 工具调用，可在任何 LLM 上稳定运行

---

## 相关文档

- [Agent 工具详解](../wiki/claude-code-api/agent-tool-reference.md)
- [Tools Reference](../wiki/claude-code/tools-reference.md)
- [query() Options 参考](../wiki/sdk/query-options-reference.md)
