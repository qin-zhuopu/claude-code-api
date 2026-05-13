# AskUserQuestion Tool

**Source**: https://docs.anthropic.com/en/docs/claude-code  
**Collected**: 2026-05-12  
**Published**: Unknown

## Overview

`AskUserQuestion` is a built-in Claude Code tool that enables Claude to ask structured multiple-choice questions to users during task execution. Unlike normal conversation turns where Claude finishes and waits, this tool pauses execution and waits for user input via the `canUseTool` callback.

**Key Characteristics**:
- **No permission required**: Read-only tool, safe to use in any mode
- **Interactive flow**: Pauses execution until user responds
- **Structured format**: 1-4 questions with 2-4 options each
- **Multi-select support**: Can allow single or multiple selections per question
- **Preview support** (TypeScript): Optional HTML/markdown previews for visual comparisons

## When Claude Uses AskUserQuestion

Claude calls `AskUserQuestion` when it needs clarification on tasks with multiple valid approaches:

**Common scenarios**:
- Choosing between architectural approaches (e.g., "Which database do you want to use?")
- Clarifying requirements (e.g., "What should be the output format?")
- Design decisions (e.g., "Which UI framework do you prefer?")
- Plan mode exploration: Asking questions before proposing implementation plans

**Example prompts that trigger questions**:
- "Help me decide on the tech stack for a new mobile app"
- "Should I use Redux or Context API for state management?"
- "What testing framework should I use for this project?"

## Tool Input Format

The `AskUserQuestion` tool receives a `questions` array with 1-4 questions:

```typescript
{
  "questions": [
    {
      "question": "How should I format the output?",    // Full question text
      "header": "Format",                               // Short label (max 12 chars)
      "options": [
        {
          "label": "Summary",                           // Short choice title
          "description": "Brief overview of key points" // Detailed explanation
        },
        {
          "label": "Detailed",
          "description": "Full explanation with examples"
        }
      ],
      "multiSelect": false  // Allow multiple selections?
    }
  ]
}
```

**Field specifications**:
- `question`: The complete question text to display to user
- `header`: Short label for the question (max 12 characters), displayed as chip/tag
- `options`: Array of 2-4 choices, each with:
  - `label`: Short display text (1-5 words)
  - `description`: Explanation of what this choice means
  - `preview` (optional): HTML/markdown string for visual comparison
- `multiSelect`: If `true`, users can select multiple options

## Tool Output Format

Return an object with the original `questions` array and an `answers` mapping:

```typescript
{
  "questions": [...],  // Pass through original questions
  "answers": {
    "How should I format the output?": "Summary",           // Single select
    "Which sections should I include?": "Intro, Conclusion" // Multi-select (comma-separated)
  }
}
```

**Answer format rules**:
- **Keys**: Use the `question` field text as the key
- **Values**: Use the selected option's `label` field as the value
- **Multi-select**: Pass array of labels OR join with `", "` (comma-space)
- **Free-text**: Use user's custom text directly (when "Other" option is chosen)

## Implementation in Claude Agent SDK

### Python SDK

```python
import asyncio
from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import HookMatcher, PermissionResultAllow

async def handle_ask_user_question(input_data: dict) -> PermissionResultAllow:
    """Display Claude's questions and collect user answers."""
    answers = {}

    for q in input_data.get("questions", []):
        print(f"\n{q['header']}: {q['question']}")
        
        # Display options
        options = q["options"]
        for i, opt in enumerate(options):
            print(f"  {i + 1}. {opt['label']} - {opt['description']}")
        
        # Get user input
        response = input("Your choice: ").strip()
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

# Required: PreToolUse hook to keep stream open
async def dummy_hook(input_data, tool_use_id, context):
    return {"continue_": True}

async def main():
    async for message in query(
        prompt="Help me decide on the tech stack for a new mobile app",
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

    const response = await prompt("Your choice: ");
    answers[q.question] = response;
  }

  return {
    behavior: "allow",
    updatedInput: { questions: input.questions, answers }
  };
}

for await (const message of query({
  prompt: "Help me decide on the tech stack for a new mobile app",
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

## Preview Support (TypeScript Only)

The `toolConfig.askUserQuestion.previewFormat` setting adds a `preview` field to options for visual comparisons:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Help me choose a card layout",
  options: {
    toolConfig: {
      askUserQuestion: { previewFormat: "html" }  // or "markdown"
    },
    canUseTool: async (toolName, input) => {
      // input.questions[].options[].preview is now available
      return { behavior: "allow", updatedInput: input };
    }
  }
})) {
  // ...
}
```

**Preview formats**:
- **unset** (default): No preview field
- `"markdown"`: ASCII art and fenced code blocks
- `"html"`: Styled `<div>` fragments (script/style/DOCTYPE stripped for security)

**When previews appear**:
- Claude includes previews where visual comparison helps (layouts, color schemes)
- Omits previews where unnecessary (yes/no confirmations, text-only choices)
- Check for `undefined` before rendering

## Handling "Other" (Free-Text Input)

Claude's predefined options won't always cover user needs. To support free-text input:

1. Display an "Other" option after Claude's options
2. Accept text input when user chooses "Other"
3. Use the user's custom text as the answer value (not "Other")

```typescript
function parseResponse(response: string, options: any[]): string {
  // Try to parse as option number
  const index = parseInt(response) - 1;
  if (!isNaN(index) && index >= 0 && index < options.length) {
    return options[index].label;
  }
  // Otherwise, treat as free text
  return response;
}
```

## Tool Availability

### In Claude Code CLI
- Always available by default
- No permission required
- Works in all permission modes

### In Claude Agent SDK
**Default**: Available unless restricted

**When using `tools` array**: Must include `AskUserQuestion` explicitly
```typescript
// ✅ AskUserQuestion works
tools: ["Read", "Glob", "Grep", "AskUserQuestion"]

// ❌ AskUserQuestion blocked
tools: ["Read", "Glob", "Grep"]
```

### Subagents
**Currently not available** in subagents spawned via the Agent tool.

## Limitations

- **Question count**: 1-4 questions per call
- **Options per question**: 2-4 options each
- **Subagent support**: Not available in subagents
- **SDK availability**: Requires `canUseTool` callback implementation

## Best Practices

### For SDK Users
1. **Route explicitly**: Check `toolName === "AskUserQuestion"` in your `canUseTool` callback
2. **Pass through questions**: Always include the original `questions` array in response
3. **Validate input**: Handle both numeric selections and free-text input
4. **Display clearly**: Show header, question, and all options to users
5. **Support multi-select**: Join multiple selections with `", "` for array values

### For Prompt Authors
- Use when task has multiple valid approaches
- Provide clear, distinct option labels (1-5 words)
- Write descriptive option explanations
- Set `multiSelect: true` when multiple choices make sense
- Consider enabling previews for visual/design choices

### UI/UX Considerations
- Display questions prominently with headers as chips/tags
- Show option descriptions clearly alongside labels
- Support keyboard shortcuts (1, 2, 3, 4) for quick selection
- Allow free-text input when predefined options don't fit
- For multi-select, show checkboxes instead of radio buttons

## Related Tools

- **[`ExitPlanMode`](exit-plan-mode.md)**: Requires user approval of plans (often uses AskUserQuestion during exploration)
- **[`Bash`](bash.md)**: Often needs permission approval via `canUseTool`
- **[`Write`](write.md)**: Often needs permission approval via `canUseTool`
- **[`Skill`](skill.md)**: Can invoke skills that use AskUserQuestion

## See Also

- [Permissions Documentation](https://docs.anthropic.com/en/docs/claude-code/permissions)
- [Claude Agent SDK - User Input](https://docs.anthropic.com/en/docs/agent-sdk/user-input)
- [Plan Mode](https://docs.anthropic.com/en/docs/claude-code/permission-modes#plan-mode-plan)
