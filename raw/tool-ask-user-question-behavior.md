# AskUserQuestion 工具行为观察报告

**日期**: 2026-05-13
**测试文件**: `test/integration/agent-tool-ask-user-question.spec.ts`
**测试用例数**: 16（2 环境 × 8 用例）

## 双环境配置

| 维度 | Jereh | GLM |
|------|-------|-----|
| BASE_URL | `http://10.1.3.115:4000` | `https://open.bigmodel.cn/api/anthropic` |
| OPUS/SONNET | `Jereh-LLM-NO-THINK-V1` | `glm-4.7` |
| HAIKU | `Jereh-LLM-NO-THINK-V1` | `glm-4.5-air` |
| TOKEN | `ANTHROPIC_AUTH_TOKEN_LOCAL` | `ANTHROPIC_AUTH_TOKEN_BIGMODEL` |

## 测试矩阵

| Case | 类型 | 描述 | canUseTool | toolConfig |
|------|------|------|------------|------------|
| 1 | SDK | 基线：默认 tools 包含 AskUserQuestion | 无 | 无 |
| 2 | SDK | input_schema 结构 | 无 | 无 |
| 3 | SDK | 禁用 AskUserQuestion（tools 排除） | 无 | 无 |
| 4 | SDK | previewFormat=html | 无 | html |
| 5 | SDK | previewFormat=markdown | 无 | markdown |
| 6 | SDK | 默认无 toolConfig | 无 | 无 |
| 7 | LLM | 触发 AskUserQuestion + canUseTool 单选 | 单选回答 | 无 |
| 8 | LLM | 触发 AskUserQuestion + canUseTool 多选 | 多选回答 | 无 |

## 关键发现

### 0. SDK 行为与 LLM 后端无关（交叉对比验证）

通过对 Jereh 和 GLM 两组后端的交叉对比，确认以下行为完全由 SDK 控制（两个环境结果完全一致）：

| 指标 | Jereh | GLM | 一致性 |
|------|-------|-----|--------|
| toolsCount | 23 | 23 | **一致** |
| hasAskUserQuestion | true | true | **一致** |
| descLen（默认） | 1074 | 1074 | **一致** |
| descLen（html） | 1667 | 1667 | **一致** |
| descLen（markdown） | 1763 | 1763 | **一致** |
| schemaProps | [questions,answers,annotations,metadata] | 同左 | **一致** |
| tools 排除后 toolsCount | 3 | 3 | **一致** |
| reqSize 差异 | - | -14 bytes | 仅时间戳差异 |

LLM 行为差异（两组均能成功调用 AskUserQuestion）：
- **Jereh** case-7: 成功触发 1 次 tool_use，2 req + 2 resp
- **GLM** case-7: 成功触发 1 次 tool_use，2 req + 2 resp
- **Jereh** case-8: 成功触发 1 次 tool_use，2 req + 2 resp
- **GLM** case-8: 成功触发 1 次 tool_use，2 req + 2 resp

结论：两组 LLM 在 AskUserQuestion 的调用行为上一致，均能正确触发并处理回调。

### 1. AskUserQuestion 默认包含在 tools 列表中

- 默认配置下，AskUserQuestion 始终出现在 tools 数组中
- 不需要权限（no permission required）
- 通过 `tools` 选项可以排除（`tools: ['Read', 'Grep']` 不含 `'AskUserQuestion'`）

### 2. input_schema 完整结构

AskUserQuestion 的 input_schema 包含以下顶层 properties：

| 属性 | 类型 | required | 说明 |
|------|------|----------|------|
| `questions` | array | **是** | 1-4 个问题，每个含 question/header/options/multiSelect |
| `answers` | object (string→string) | 否 | 用户回答，key 是 question 文本 |
| `annotations` | object | 否 | 每题的可选注释（preview/notes） |
| `metadata` | object | 否 | 追踪元数据（source 字段） |

**questions 内部结构**：
- `question` (string, required): 完整问题文本
- `header` (string, required): 短标签（≤12 字符）
- `options` (array, required): 2-4 个选项，每个含 label (required) + description (required) + preview (optional)
- `multiSelect` (boolean, required in schema, default: false)

**注意**: 虽然在 schema 中 `multiSelect` 是 required 字段，LLM 在实际 tool_use 调用时可能省略它（默认 false）。

### 3. canUseTool 回调处理 AskUserQuestion

当 AskUserQuestion 被触发时，`canUseTool` 回调接收：
- `toolName`: `"AskUserQuestion"`
- `input`: 包含 `questions` 数组

回调必须返回：
```typescript
{
  behavior: 'allow',
  updatedInput: {
    questions: input.questions,  // 原样传回
    answers: { "问题文本": "选项label" }  // 用户答案
  }
}
```

**tool_result 内容格式**：
```
User has answered your questions: "问题文本"="选项label". You can now continue with the user's answers in mind.
```

### 4. LLM 可能产生格式错误的 tool_use 调用

观察到一个重要行为：LLM 有时会生成格式错误的 AskUserQuestion 调用：
- **正确格式**: `{ questions: [{ question, header, options, multiSelect }] }`
- **错误格式**: `{ head, question, options (string), multiSelect (string) }` — 扁平化、类型错误

SDK 会返回 InputValidationError，LLM 会重试。这可能导致间歇性的 "Content block not found" 错误。

### 5. previewFormat 对 tool description 的影响（非 schema）

`toolConfig.askUserQuestion.previewFormat` 的作用：
- **不改变 schema 结构**: `preview` 字段在所有模式下都存在于 options 的 schema 中
- **改变 tool description 内容**: 不同模式生成不同长度的说明文本

| previewFormat | description 长度 | 包含关键字 |
|---------------|-----------------|-----------|
| 未设置（默认） | ~1074 chars | 无 HTML/markdown 关键字 |
| `'html'` | ~1667 chars | HTML |
| `'markdown'` | ~1763 chars | markdown, ASCII |

默认模式的 description 最短，不包含预览渲染说明。设置 `previewFormat` 后，SDK 会在 description 中附加预览格式的使用指南。

### 6. 禁用 AskUserQuestion 时的 LLM 行为

当 tools 列表中不包含 AskUserQuestion 时：
- LLM 不会尝试调用 AskUserQuestion
- 对于需要用户输入的问题，LLM 直接用文本回答
- 不会产生错误或异常行为

## tool_result 实际内容示例

**成功的 tool_result**:
```
User has answered your questions: "Which testing framework would you like to use for your project?"="Jest". You can now continue with the user's answers in mind.
```

**验证失败的 tool_result**:
```
InputValidationError: AskUserQuestion failed due to the following issues:
The required parameter `questions` is missing
An unexpected parameter `head` was provided
An unexpected parameter `question` was provided
...
```

## 最佳实践建议

1. **触发策略**: 使用明确的指令（"Use the AskUserQuestion tool to..."）确保 LLM 调用工具
2. **容错处理**: SDK 可能出现间歇性错误，生产代码需要 try-catch
3. **previewFormat**: 仅在需要预览功能时设置，默认模式 description 更短（节省 token）
4. **multiSelect**: schema 中是 required，但 LLM 实际调用时可能省略（默认 false）
5. **answers 格式**: 单选用 label 文本，多选用 ", " 连接多个 label

## 相关文档

- [AskUserQuestion 工具详解](../wiki/claude-code-api/ask-user-question.md)
- [工具权限参考](../wiki/claude-code/tools-reference.md)
