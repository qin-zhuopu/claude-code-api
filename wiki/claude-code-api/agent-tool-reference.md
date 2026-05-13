# Agent 工具详解

**Sources**: raw/claude-code-docs/docs/agent-sdk__subagents.md; raw/claude-code-docs/docs/sub-agents.md; raw/claude-code-docs/docs/agents.md  
**Updated**: 2026-05-12

## 概述

Agent 工具是 Claude Code 中用于启动子代理（subagent）的核心工具。子代理是在独立上下文窗口中运行的专用 AI 助手，可以处理特定类型的任务，帮助保持主对话的上下文清洁，并支持并行处理复杂工作流。

### 核心价值

- **上下文隔离**：子代理在独立对话中运行，中间工具调用和结果保留在子代理内部，只有最终消息返回给父对话
- **并行处理**：多个子代理可以并发运行，显著加速复杂工作流
- **专业化指令**：每个子代理可以有定制化的系统提示，具备特定专业知识和约束
- **工具限制**：子代理可以限制只能使用特定工具，降低意外操作的风险

## 内置子代理类型

Claude Code 包含几个内置子代理，Claude 会根据任务类型自动使用：

| 子代理 | 模型 | 工具 | 用途 |
|--------|------|------|------|
| **Explore** | Haiku | 只读工具 | 快速搜索和分析代码库，文件发现和代码探索 |
| **Plan** | 继承主对话 | 只读工具 | 在计划模式下进行代码库研究以制定计划 |
| **general-purpose** | 继承主对话 | 所有工具 | 需要探索和修改的复杂多步骤任务 |
| **statusline-setup** | Sonnet | - | 配置状态栏时使用 |
| **claude-code-guide** | Haiku | - | 回答 Claude Code 功能相关问题时使用 |

## Agent 工具参数

### 必需参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `description` | `string` | 简短的任务描述（3-5词），告诉子代理要做什么 |
| `prompt` | `string` | 详细的任务指令，告诉子代理如何完成工作 |

### 可选参数

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `subagent_type` | `string` | `general-purpose` | 指定使用哪个子代理类型（Explore、Plan、general-purpose 或自定义） |
| `model` | `string` | `inherit` | 子代理使用的模型（sonnet、opus、haiku 或完整模型 ID） |
| `run_in_background` | `boolean` | `false` | 是否在后台运行子代理 |
| `isolation` | `string` | - | 隔离模式，设为 "worktree" 时在临时 git worktree 中运行 |

## SDK 使用示例

### TypeScript/JavaScript

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// 使用 Agent 工具启动子代理
for await (const message of query({
  prompt: "分析这个代码库的架构",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Agent"],
    agents: {
      "code-analyzer": {
        description: "静态代码分析和架构审查",
        prompt: `You are a code architecture analyst. Analyze code structure,
identify patterns, and suggest improvements without making changes.`,
        tools: ["Read", "Grep", "Glob"],
        model: "sonnet"
      }
    }
  }
})) {
  if ("result" in message) console.log(message.result);
}
```

### Python

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

async def main():
    async for message in query(
        prompt="分析这个代码库的架构",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Grep", "Glob", "Agent"],
            agents={
                "code-analyzer": AgentDefinition(
                    description="静态代码分析和架构审查",
                    prompt="""You are a code architecture analyst. Analyze code structure,
identify patterns, and suggest improvements without making changes.""",
                    tools=["Read", "Grep", "Glob"],
                    model="sonnet",
                )
            },
        ),
    ):
        if hasattr(message, "result"):
            print(message.result)

asyncio.run(main())
```

## 子代理定义

### AgentDefinition 配置

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `description` | `string` | 是 | 自然语言描述，说明何时使用此子代理 |
| `prompt` | `string` | 是 | 子代理的系统提示，定义其角色和行为 |
| `tools` | `string[]` | 否 | 允许的工具名称数组。如果省略，继承所有工具 |
| `disallowedTools` | `string[]` | 否 | 要从子代理工具集中移除的工具名称数组 |
| `model` | `string` | 否 | 模型覆盖。接受别名（sonnet、opus、haiku、inherit）或完整模型 ID |
| `skills` | `string[]` | 否 | 在启动时预加载到子代理上下文的技能名称列表 |
| `memory` | `string` | 否 | 内存源（user、project 或 local） |
| `mcpServers` | `(string \| object)[]` | 否 | 子代理可用的 MCP 服务器 |
| `maxTurns` | `number` | 否 | 子代理停止前的最大代理轮次数 |
| `background` | `boolean` | 否 | 调用时作为非阻塞后台任务运行 |
| `effort` | `string` | 否 | 子代理的推理努力级别（low、medium、high、xhigh、max） |
| `permissionMode` | `string` | 否 | 子代理内工具执行的权限模式 |

## 子代理调用方式

### 1. 自动委托

Claude 根据任务描述和子代理的 `description` 字段自动决定何时调用子代理：

```text
分析认证模块的安全问题
```

如果定义了一个 `security-reviewer` 子代理，描述为 "Security code reviewer"，Claude 会自动委托给该子代理。

### 2. 显式调用（名称引用）

在提示词中明确提及子代理名称：

```text
Use the code-reviewer agent to check the authentication module
```

这会绕过自动匹配，直接调用指定的子代理。

### 3. @ 提及

使用 `@` 符号明确选择子代理：

```text
@"code-reviewer (agent)" look at the auth changes
```

### 4. 会话级子代理

使用 `--agent` 标志启动整个会话作为子代理：

```bash
claude --agent code-reviewer
```

## 工具限制

子代理可以通过 `tools` 字段限制工具访问：

| 用例 | 工具组合 | 描述 |
|------|----------|------|
| 只读分析 | `Read`, `Grep`, `Glob` | 可以检查代码但不能修改或执行 |
| 测试执行 | `Bash`, `Read`, `Grep` | 可以运行命令并分析输出 |
| 代码修改 | `Read`, `Edit`, `Write`, `Grep`, `Glob` | 完整的读写访问但没有命令执行 |
| 完全访问 | 所有工具 | 继承父对话的所有工具（省略 `tools` 字段） |

### 只读子代理示例

```typescript
agents: {
  "code-analyzer": {
    description: "静态代码分析和架构审查",
    prompt: "Analyze code structure without making changes.",
    tools: ["Read", "Grep", "Glob"]  // 只读工具
  }
}
```

### 工具白名单语法

要限制主线程代理可以生成哪些子代理，使用 `Agent(agent_type)` 语法：

```yaml
---
name: coordinator
description: 协调专业代理的工作
tools: Agent(worker, researcher), Read, Bash
---
```

这表示只允许生成 `worker` 和 `researcher` 子代理。要允许生成任何子代理而不加限制，使用不带括号的 `Agent`。

## 检测子代理调用

子代理通过 Agent 工具调用。要检测子代理何时被调用，检查 `name` 为 `"Agent"` 的 `tool_use` 块：

```typescript
for await (const message of query({ ... })) {
  const msg = message as any;
  
  // 检查子代理调用
  for (const block of msg.message?.content ?? []) {
    if (block.type === "tool_use" && block.name === "Agent") {
      console.log(`Subagent invoked: ${block.input.subagent_type}`);
    }
  }
  
  // 检查消息是否来自子代理上下文
  if (msg.parent_tool_use_id) {
    console.log("  (running inside subagent)");
  }
}
```

## 子代理恢复

子代理可以恢复以从中断的地方继续工作。恢复的子代理保留完整的对话历史，包括所有之前的工具调用、结果和推理。

### 恢复流程

1. **捕获会话 ID**：在第一次查询期间从消息中提取 `session_id`
2. **提取代理 ID**：从消息内容中解析 `agentId`
3. **恢复会话**：在第二次查询的选项中传递 `resume: sessionId`，并在提示词中包含代理 ID

```typescript
let agentId: string | undefined;
let sessionId: string | undefined;

// 第一次调用 - 使用 Explore 代理查找 API 端点
for await (const message of query({
  prompt: "Use the Explore agent to find all API endpoints in this codebase",
  options: { allowedTools: ["Read", "Grep", "Glob", "Agent"] }
})) {
  if ("session_id" in message) sessionId = message.session_id;
  const extractedId = extractAgentId(message);
  if (extractedId) agentId = extractedId;
  if ("result" in message) console.log(message.result);
}

// 第二次调用 - 恢复并询问后续问题
if (agentId && sessionId) {
  for await (const message of query({
    prompt: `Resume agent ${agentId} and list the top 3 most complex endpoints`,
    options: { allowedTools: ["Read", "Grep", "Glob", "Agent"], resume: sessionId }
  })) {
    if ("result" in message) console.log(message.result);
  }
}
```

## 前台与后台运行

子代理可以在前台（阻塞）或后台（并发）运行：

### 前台子代理

- 阻塞主对话直到完成
- 权限提示会传递给您
- 适用于需要交互的任务

### 后台子代理

- 与您继续工作同时并发运行
- 使用会话中已授予的权限
- 自动拒绝任何需要提示的工具调用
- 如果后台子代理因缺少权限而失败，可以启动新的前台子代理重试

您也可以：
- 要求 Claude "在后台运行这个任务"
- 按 **Ctrl+B** 将运行中的任务转到后台

## 常见使用模式

### 1. 隔离高产量操作

```text
Use a subagent to run the test suite and report only the failing tests with their error messages
```

### 2. 并行研究

```text
Research the authentication, database, and API modules in parallel using separate subagents
```

### 3. 链式子代理

```text
Use the code-reviewer subagent to find performance issues, then use the optimizer subagent to fix them
```

## 最佳实践

### 设计原则

- **专注的子代理**：每个子代理应该擅长一项特定任务
- **详细描述**：Claude 使用描述来决定何时委托
- **限制工具访问**：仅授予必要的权限以确保安全和专注
- **版本控制**：将项目子代理纳入版本控制以便团队协作

### 描述写作技巧

包含诸如 "use proactively"（主动使用）之类的短语以鼓励主动委托：

```yaml
---
name: code-reviewer
description: Expert code review specialist. Use proactively after code changes.
---
```

### 选择正确的工具

| 场景 | 使用 | 原因 |
|------|------|------|
| 需要频繁来回交互 | 主对话 | 子代理有启动延迟 |
| 多阶段共享上下文 | 主对话 | 避免重复传递上下文 |
| 快速针对性更改 | 主对话 | 延迟很重要 |
| 产生大量输出 | 子代理 | 保持主上下文清洁 |
| 需要特定工具限制 | 子代理 | 强制执行安全约束 |
| 自包含任务 | 子代理 | 返回摘要即可 |

## 与其他功能的区别

| 功能 | 上下文 | 适用场景 |
|------|--------|----------|
| **子代理** | 独立上下文，返回摘要 | 侧向任务会产生大量不需要引用的内容 |
| **Agent View** | 独立会话，您监控 | 多个独立任务，需要时介入 |
| **Agent Teams** | 共享任务列表，相互通信 | Claude 协调一组工作者 |
| **Worktrees** | 独立的 git checkout | 并行会话永不接触彼此的文件 |
| **Skills** | 主对话上下文 | 可重用的提示词或工作流 |

## 权限模式

子代理可以覆盖权限模式，但以下情况父模式优先：

| 父模式 | 子代理 behavior |
|--------|----------------|
| `bypassPermissions` | 子代理无法覆盖，继承绕过权限 |
| `acceptEdits` | 子代理无法覆盖，继承自动接受编辑 |
| `auto` | 子代理无法覆盖，继承自动模式 |

可用的权限模式：
- `default`：标准权限检查和提示
- `acceptEdits`：自动接受工作目录中的文件编辑和常见文件系统命令
- `auto`：后台分类器审查命令和受保护目录写入
- `dontAsk`：自动拒绝权限提示
- `bypassPermissions`：跳过权限提示（谨慎使用）
- `plan`：计划模式（只读探索）

## 故障排除

### Claude 不委托给子代理

1. **包含 Agent 工具**：确保 `Agent` 在 `allowedTools` 中
2. **使用显式提示**：在提示词中提及子代理名称（例如 "Use the code-reviewer agent to..."）
3. **编写清晰的描述**：确切说明何时应使用子代理

### 基于文件系统的代理未加载

在 `.claude/agents/` 中定义的代理仅在启动时加载。如果在 Claude Code 运行时创建新的代理文件，请重启会话以加载它。

### Windows：长提示词失败

在 Windows 上，提示词很长的子代理可能由于命令行长度限制（8191 字符）而失败。保持提示词简洁或对复杂指令使用基于文件系统的代理。

## See Also

- [Subagents](../../raw/claude-code-docs/docs/sub-agents.md) - 完整的子代理文档
- [Agent SDK Subagents](../../raw/claude-code-docs/docs/agent-sdk__subagents.md) - SDK 中的子代理使用
- [Permissions](../claude-code/permissions.md) - 权限系统参考
- [Tools Reference](../claude-code/tools-reference.md) - 工具完整参考
