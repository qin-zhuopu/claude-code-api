# AskUserQuestion 工具详解

**Sources**: [raw/claude-code-api/ask-user-question.md](../../raw/claude-code-api/ask-user-question.md)  
**Updated**: 2026-05-12

## 概述

`AskUserQuestion` 是 Claude Code 的内置工具，允许 Claude 在任务执行期间向用户提出结构化的多选问题。与普通对话轮次不同，该工具会暂停执行并等待用户通过 `canUseTool` 回调响应。

**核心特性**：
- **无需权限**：只读工具，在任何模式下都安全使用
- **交互式流程**：暂停执行直到用户响应
- **结构化格式**：每次 1-4 个问题，每个问题 2-4 个选项
- **多选支持**：支持单选或多选
- **预览支持**（TypeScript）：支持 HTML/markdown 预览，用于视觉对比

## Claude 何时使用 AskUserQuestion

当 Claude 在有多种可行方法的任务中需要澄清时会调用此工具：

**常见场景**：
- 架构选择（如"你想使用哪个数据库？"）
- 需求澄清（如"输出格式应该是什么？"）
- 设计决策（如"你更喜欢哪个 UI 框架？"）
- 计划模式探索：在提出实施计划前询问问题

**会触发问题的提示示例**：
- "帮我决定新移动应用的技术栈"
- "我应该用 Redux 还是 Context API 进行状态管理？"
- "这个项目应该用什么测试框架？"

## 工具输入格式

```typescript
{
  "questions": [
    {
      "question": "我应该怎么格式化输出？",      // 完整问题文本
      "header": "格式",                          // 短标签（最多12字符）
      "options": [
        {
          "label": "摘要",                        // 简短选择标题
          "description": "关键点的简要概述"        // 详细说明
        },
        {
          "label": "详细",
          "description": "包含示例的完整解释"
        }
      ],
      "multiSelect": false  // 是否允许多选
    }
  ]
}
```

**字段说明**：
- `question`：向用户显示的完整问题文本
- `header`：问题的短标签（最多12字符），显示为芯片/标签
- `options`：2-4 个选择的数组，每个包含：
  - `label`：简短显示文本（1-5个词）
  - `description`：对该选择的解释
  - `preview`（可选）：用于视觉对比的 HTML/markdown 字符串
- `multiSelect`：如果为 `true`，用户可以选择多个选项

## 工具输出格式

返回包含原始 `questions` 数组和 `answers` 映射的对象：

```typescript
{
  "questions": [...],  // 传递原始问题
  "answers": {
    "我应该怎么格式化输出？": "摘要",              // 单选
    "我应该包含哪些部分？": "介绍, 结论"            // 多选（逗号分隔）
  }
}
```

**答案格式规则**：
- **键**：使用 `question` 字段文本作为键
- **值**：使用所选选项的 `label` 字段作为值
- **多选**：传递标签数组或用 `", "`（逗号空格）连接
- **自由文本**：直接使用用户自定义文本（选择"其他"时）

## 在 Claude Agent SDK 中实现

### Python SDK

```python
import asyncio
from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import HookMatcher, PermissionResultAllow

async def handle_ask_user_question(input_data: dict) -> PermissionResultAllow:
    """显示 Claude 的问题并收集用户答案。"""
    answers = {}

    for q in input_data.get("questions", []):
        print(f"\n{q['header']}: {q['question']}")
        
        # 显示选项
        options = q["options"]
        for i, opt in enumerate(options):
            print(f"  {i + 1}. {opt['label']} - {opt['description']}")
        
        # 获取用户输入
        response = input("你的选择: ").strip()
        answers[q["question"]] = response

    return PermissionResultAllow(
        updated_input={
            "questions": input_data.get("questions", []),
            "answers": answers,
        }
    )

async def can_use_tool(tool_name: str, input_data: dict, context):
    if tool_name == "AskUserQuestion":
        return await handle_ask_user_question(input_data)
    return PermissionResultAllow(updated_input=input_data)

# 必需：PreToolUse hook 保持流打开
async def dummy_hook(input_data, tool_use_id, context):
    return {"continue_": True}

async def main():
    async for message in query(
        prompt="帮我决定新移动应用的技术栈",
        options=ClaudeAgentOptions(
            can_use_tool=can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[dummy_hook])]},
        ),
    ):
        print(message)

asyncio.run(main())
```

### TypeScript SDK

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "readline/promises";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function handleAskUserQuestion(input: any) {
  const answers: Record<string, string> = {};

  for (const q of input.questions) {
    console.log(`\n${q.header}: ${q.question}`);
    
    q.options.forEach((opt: any, i: number) => {
      console.log(`  ${i + 1}. ${opt.label} - ${opt.description}`);
    });

    const response = await prompt("你的选择: ");
    answers[q.question] = response;
  }

  return {
    behavior: "allow",
    updatedInput: { questions: input.questions, answers }
  };
}

for await (const message of query({
  prompt: "帮我决定新移动应用的技术栈",
  options: {
    canUseTool: async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        return handleAskUserQuestion(input);
      }
      return { behavior: "allow", updatedInput: input };
    }
  }
})) {
  console.log(message);
}
```

## 预览支持（仅 TypeScript）

`toolConfig.askUserQuestion.previewFormat` 设置为选项添加 `preview` 字段用于视觉对比：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "帮我选择卡片布局",
  options: {
    toolConfig: {
      askUserQuestion: { previewFormat: "html" }  // 或 "markdown"
    },
    canUseTool: async (toolName, input) => {
      // input.questions[].options[].preview 现在可用
      return { behavior: "allow", updatedInput: input };
    }
  }
})) {
  // ...
}
```

**预览格式**：
- **未设置**（默认）：无预览字段
- `"markdown"`：ASCII 艺术和围栏代码块
- `"html"`：样式化的 `<div>` 片段（出于安全考虑移除 script/style/DOCTYPE）

**预览何时出现**：
- Claude 在视觉对比有帮助的地方包含预览（布局、配色方案）
- 在不必要的地方省略预览（是/否确认、纯文本选择）
- 渲染前检查 `undefined`

## 处理"其他"（自由文本输入）

Claude 的预定义选项并不总是满足用户需求。要支持自由文本输入：

1. 在 Claude 的选项后显示"其他"选项
2. 用户选择"其他"时接受文本输入
3. 使用用户自定义文本作为答案值（而非"其他"）

```typescript
function parseResponse(response: string, options: any[]): string {
  // 尝试解析为选项编号
  const index = parseInt(response) - 1;
  if (!isNaN(index) && index >= 0 && index < options.length) {
    return options[index].label;
  }
  // 否则，视为自由文本
  return response;
}
```

## 工具可用性

### 在 Claude Code CLI 中
- 默认始终可用
- 无需权限
- 在所有权限模式下工作

### 在 Claude Agent SDK 中
**默认**：可用，除非受限

**使用 `tools` 数组时**：必须显式包含 `AskUserQuestion`
```typescript
// ✅ AskUserQuestion 可用
tools: ["Read", "Glob", "Grep", "AskUserQuestion"]

// ❌ AskUserQuestion 被阻止
tools: ["Read", "Glob", "Grep"]
```

### 子 Agent
目前通过 Agent 工具生成的子 Agent 中**不可用**。

## 限制

- **问题数量**：每次调用 1-4 个问题
- **每个问题的选项**：每个问题 2-4 个选项
- **子 Agent 支持**：在子 Agent 中不可用
- **SDK 可用性**：需要实现 `canUseTool` 回调

## 最佳实践

### 对于 SDK 用户
1. **显式路由**：在 `canUseTool` 回调中检查 `toolName === "AskUserQuestion"`
2. **传递问题**：始终在响应中包含原始 `questions` 数组
3. **验证输入**：处理数字选择和自由文本输入
4. **清晰显示**：向用户显示标题、问题和所有选项
5. **支持多选**：用 `", "` 连接多个选择的数组值

### 对于提示词作者
- 在任务有多种可行方法时使用
- 提供清晰、不同的选项标签（1-5 个词）
- 编写描述性的选项说明
- 当多个选择有意义时设置 `multiSelect: true`
- 考虑为视觉/设计选择启用预览

### UI/UX 考虑
- 以芯片/标签形式突出显示问题标题
- 在标签旁清晰显示选项说明
- 支持键盘快捷键（1、2、3、4）进行快速选择
- 当预定义选项不合适时允许自由文本输入
- 对于多选，显示复选框而非单选按钮

## 相关工具

- **[`ExitPlanMode`](exit-plan-mode.md)**：需要用户批准计划（通常在探索期间使用 AskUserQuestion）
- **[`Bash`](bash.md)**：通常需要通过 `canUseTool` 进行权限批准
- **[`Write`](write.md)**：通常需要通过 `canUseTool` 进行权限批准
- **[`Skill`](skill.md)**：可以调用使用 AskUserQuestion 的技能

## 另请参阅

- [权限文档](https://docs.anthropic.com/en/docs/claude-code/permissions)
- [Claude Agent SDK - 用户输入](https://docs.anthropic.com/en/docs/agent-sdk/user-input)
- [计划模式](https://docs.anthropic.com/en/docs/claude-code/permission-modes#plan-mode-plan)
