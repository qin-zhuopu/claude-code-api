# systemPrompt 配置选项详解

通过 7 组变量控制实验，验证了 Claude Code SDK 中 `systemPrompt` 各种配置对 API 请求中 system 字段的实际影响。

## 配置方式总览

| 配置 | system 大小 | 结构 | 适用场景 |
|------|------------|------|---------|
| 不设置 | ~146 chars | billing + 精简身份 | 最轻量，自定义 agent |
| `string` | ~200 chars | billing + 精简身份 + 自定义内容 | 追加简短指令 |
| `string[]` | ~210 chars | billing + 精简身份 + 合并后的自定义内容 | 追加多段指令 |
| `{ preset: 'claude_code' }` | ~26000 chars | billing + 精简身份 + 完整行为指令 | 需要完整 Claude Code 能力 |
| `{ preset: 'claude_code', append }` | ~26000+ chars | 同上 + 追加内容（在动态段之前） | 在 Claude Code 基础上加指令 |
| `{ preset: 'claude_code', excludeDynamicSections }` | ~24500 chars | 同上但动态段移到 user message | 多用户共享缓存 |

## 请求结构详解

### 不设置 systemPrompt（默认）

```
system[0]: "x-anthropic-billing-header: cc_version=2.1.133..."     (84 chars)
system[1]: "You are a Claude agent, built on Anthropic's Claude Agent SDK."  (62 chars, cached)
```

总计 ~146 chars，2 个 block。这是 SDK 的最小 system prompt。

### 自定义 string

```
system[0]: "x-anthropic-billing-header: ..."                       (84 chars)
system[1]: "You are a Claude agent, built on Anthropic's Claude Agent SDK."  (62 chars, cached)
system[2]: "You are a test bot. [自定义内容]. Reply briefly."       (自定义, cached)
```

**关键发现**：自定义 string **不会替换**默认的 billing header 和基础身份声明，而是作为第 3 个 block 追加在后面。

### 自定义 string[]

与 string 相同的结构。多段内容被合并为一个 block（用 `\n\n` 连接），追加在基础身份之后。

### preset: 'claude_code'

```
system[0]: "x-anthropic-billing-header: ..."                       (84 chars)
system[1]: "You are a Claude agent, built on Anthropic's Claude Agent SDK."  (62 chars, cached)
system[2]: "You are an interactive agent that helps users with..."  (~25800 chars, cached)
           包含：
           - 完整的工具使用指南
           - 代码编辑规范
           - 文件操作规则
           - 安全约束
           - 动态段（gitStatus、工作目录等）
```

总计 ~26000 chars。这是完整的 Claude Code system prompt，与 CLI 直接调用时的 prompt 一致。

### preset + append

```
system[0]: billing header
system[1]: 身份声明（注意：使用 append 时身份变为 "You are Claude Code, Anthropic's official CLI..."）
system[2]: 完整行为指令 + [append 内容] + 动态段(gitStatus)
```

**关键发现**：`append` 内容插入在**动态段（gitStatus）之前**，不是在最末尾。这意味着 append 的指令优先级高于动态上下文。

### preset + excludeDynamicSections

```
system[0]: billing header
system[1]: 身份声明
system[2]: 完整行为指令（不含动态段）                              (~24500 chars)

messages[0].content[0]: "<system-reminder>...gitStatus...工作目录..."  (~1700 chars)
messages[0].content[1]: "say hello"                                    (用户输入)
```

**关键发现**：动态段（gitStatus、工作目录、git 用户等）从 system prompt 移到了 user message 的第一个 text block 中。system prompt 变为纯静态内容，可跨用户共享 prompt cache。

## 始终存在的固定结构

无论如何配置 `systemPrompt`，以下两个 block 始终存在：

1. **billing header**（system[0]）：`x-anthropic-billing-header: cc_version=2.1.133.c13; cc_entrypoint=sdk-ts; cch=00000;`
2. **基础身份声明**（system[1]）：`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`

这两个 block 无法通过 `systemPrompt` 选项移除或替换。

## 对 Agent 封装的影响

### 如果你想要最轻量的 agent（自定义 prompt）

```typescript
systemPrompt: 'You are a specialized assistant for [domain]. Follow these rules: ...'
```

实际效果：billing + "You are a Claude agent..." + 你的自定义内容。总共 ~200-500 chars。模型不会有 Claude Code 的工具使用指南，需要你自己在 prompt 中说明。

### 如果你想要完整的 Claude Code 能力 + 额外指令

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: 'Additional rules: always respond in Chinese, use formal tone.',
}
```

实际效果：完整的 Claude Code prompt（~26000 chars）+ 你的追加内容。模型有完整的工具使用指南、代码规范等。

### 如果你想要跨用户共享 prompt cache

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  excludeDynamicSections: true,
}
```

system prompt 变为纯静态（~24500 chars），动态内容移到 user message。多用户共享同一个 system prompt 时可以命中 prompt cache。

## 与其他参数的交互

| 参数 | 对 system prompt 的影响 |
|------|----------------------|
| `settingSources` | 不影响 system prompt 结构，但影响动态段中是否包含 CLAUDE.md 内容 |
| `tools` | 不影响 system prompt，工具定义在 `tools` 字段中独立传递 |
| `skills` | 不影响 system prompt，skill 列表在 user message 的 `<system-reminder>` 中 |
| `effort` | 不影响 system prompt，通过 `output_config.effort` 传递 |

## 测试文件

- `test/integration/system-prompt-matrix.spec.ts` — 7 组变量控制实验
- 日志输出：`test/integration/tmp/system-prompt/case-{1..7}-*/`
