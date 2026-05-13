# Agent 共享机制行为洞察

**实验来源**: `test/integration/agent-shared-mechanism.spec.ts`（6 组观察性测试）  
**SDK 版本**: `@anthropic-ai/claude-agent-sdk` v0.2.133  
**测试日期**: 2026-05-13

## 核心发现摘要

| # | 发现 | 影响 |
|---|------|------|
| 1 | CLI 和 SDK 共享同一套 agent 发现机制（`.claude/agents/` 目录） | 两种调用方式使用相同的 agent 定义文件 |
| 2 | SDK 的 filesystem agent 只应用 `tools` 限制，**不注入 prompt** | filesystem agent 的 prompt body 在 SDK 中无效 |
| 3 | SDK 的 programmatic agent 完整生效（prompt + tools） | programmatic 是 SDK 中唯一可靠的 agent 定义方式 |
| 4 | `settingSources: []` 完全阻止 filesystem agent 发现 | 隔离测试时 agent 定义必须通过 `agents` 选项传入 |
| 5 | programmatic agent 覆盖同名 filesystem agent | 优先级：programmatic > filesystem（与文档一致） |
| 6 | agent 会话模式下 Agent 工具不可用 | 子代理不能再生成子代理（防止递归） |

---

## 实验矩阵

| Case | 配置 | 观察目标 | 关键结论 |
|------|------|----------|----------|
| 1 | SDK programmatic agent + settingSources=[] | 基线：programmatic agent 行为 | ✅ prompt 注入 + tools 限制 + Agent 工具移除 |
| 2 | SDK filesystem agent + settingSources=[] | settingSources 对发现的影响 | ❌ agent 完全不被发现，使用默认 23 工具 |
| 3 | SDK filesystem agent + 默认 settingSources | filesystem agent 的实际行为 | ⚠️ tools 限制生效，prompt 不注入 |
| 4 | SDK filesystem agent + settingSources=['project'] | project 级别发现 | ⚠️ 与 case-3 一致：tools 生效，prompt 不注入 |
| 5 | SDK programmatic + filesystem（同名） | 优先级覆盖 | ✅ programmatic 完全覆盖 filesystem |
| 6 | CLI --agent flag | CLI 行为（需要 CLI 可用） | 🔲 未测试（环境无 claude CLI） |

---

## 详细发现

### 1. Agent 会话模式的请求结构

当 `agent` 选项生效时，请求结构发生根本性变化：

**Programmatic agent（完整生效）**：
```
system: [
  { text: "x-anthropic-billing-header: ..." },           // billing header
  { text: "You are a Claude agent, built on ..." },      // generic SDK prompt
  { text: "You are a greeter agent. Your ONLY job..." }  // ← agent prompt（第 3 个 block）
]
tools: [{ name: "Read" }]  // 只有 agent 定义的工具
```

**Filesystem agent（部分生效）**：
```
system: [
  { text: "x-anthropic-billing-header: ..." },           // billing header
  { text: "You are a Claude agent, built on ..." },      // generic SDK prompt
  // ← 没有第 3 个 block！agent prompt 未注入
]
tools: [{ name: "Read" }]  // tools 限制生效 ✅
```

**Agent 未发现（settingSources=[]）**：
```
system: [
  { text: "x-anthropic-billing-header: ..." },           // billing header
  { text: "" }                                           // 空的 generic prompt
]
tools: [23 个默认工具]  // 完整默认工具集
```

### 2. settingSources 对 Agent 发现的影响

| settingSources 值 | filesystem agent 发现 | tools 限制 | prompt 注入 | CLAUDE.md 加载 |
|---|---|---|---|---|
| `[]`（空数组） | ❌ 不发现 | ❌ 不生效 | ❌ 不注入 | ❌ 不加载 |
| `['project']` | ✅ 发现 | ✅ 生效 | ❌ 不注入 | ❌ 不加载 |
| 不传（默认） | ✅ 发现 | ✅ 生效 | ❌ 不注入 | ✅ 加载 |

**关键结论**：无论 `settingSources` 如何配置，filesystem agent 的 prompt body 都不会被注入到 system prompt 中。这是 SDK 的当前行为限制。

### 3. Programmatic vs Filesystem Agent 对比

| 维度 | Programmatic Agent | Filesystem Agent |
|------|-------------------|-----------------|
| 定义方式 | `agents: { name: { prompt, tools, ... } }` | `.claude/agents/name.md`（YAML frontmatter + markdown body） |
| prompt 注入 | ✅ 作为 system prompt 第 3 个 block | ❌ 不注入 |
| tools 限制 | ✅ 生效 | ✅ 生效 |
| Agent 工具移除 | ✅ 自动移除 | ✅ 自动移除 |
| settingSources 依赖 | ❌ 不依赖（直接传入） | ✅ 依赖（需要 project 或默认） |
| 优先级 | 高（覆盖同名 filesystem agent） | 低 |
| 适用场景 | SDK 编程调用 | CLI 交互式使用 |

### 4. CLI 与 SDK 的共享机制

根据文档和实验推断：

**共享的部分**：
- Agent 定义格式（name, description, prompt, tools 等字段）
- Agent 发现路径（`.claude/agents/` 目录）
- Agent 优先级规则（managed > CLI flag > project > user > plugin）
- Agent 会话模式的工具限制逻辑

**不共享的部分（SDK 限制）**：
- Filesystem agent 的 prompt 注入：CLI 完整注入，SDK 不注入
- 这意味着 SDK 中 filesystem agent 实际上只是一个"工具限制器"，不是完整的 agent

### 5. Agent 会话模式的通用行为

无论 agent 来源如何，agent 会话模式都有以下共同行为：

1. **Agent 工具被移除**：防止子代理递归生成子代理
2. **Tools 被限制**：只保留 agent 定义中指定的工具
3. **System prompt 被简化**：不使用完整的 Claude Code system prompt（~77KB），而是使用简短的 SDK generic prompt
4. **CLAUDE.md 加载取决于 settingSources**：不传时加载到 user message 中

---

## 实际应用建议

### SDK 中使用 Agent 的正确方式

```typescript
// ✅ 推荐：programmatic agent（prompt + tools 都生效）
const result = await query({
  prompt: 'Review this code',
  options: {
    agent: 'code-reviewer',
    agents: {
      'code-reviewer': {
        description: 'Reviews code for quality',
        prompt: 'You are a code reviewer. Focus on security and performance.',
        tools: ['Read', 'Grep', 'Glob'],
      },
    },
  },
});

// ⚠️ 不推荐：filesystem agent（只有 tools 生效，prompt 不注入）
const result = await query({
  prompt: 'Review this code',
  options: {
    cwd: '/path/to/project-with-agents',
    agent: 'code-reviewer',
    // 依赖 .claude/agents/code-reviewer.md
    // tools 会生效，但 prompt 不会注入到 system prompt
  },
});
```

### 如果需要 filesystem agent 的 prompt 生效

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

// 手动读取 filesystem agent 并转为 programmatic agent
const agentFile = readFileSync(
  join(projectDir, '.claude/agents/code-reviewer.md'),
  'utf-8'
);
const { data: frontmatter, content: prompt } = matter(agentFile);

const result = await query({
  prompt: 'Review this code',
  options: {
    agent: frontmatter.name,
    agents: {
      [frontmatter.name]: {
        description: frontmatter.description,
        prompt: prompt.trim(),
        tools: frontmatter.tools?.split(',').map(t => t.trim()),
      },
    },
  },
});
```

### CLI 中使用 Agent

```bash
# CLI 完整支持 filesystem agent（prompt + tools 都生效）
cd /path/to/project-with-agents
claude -p "Review this code" --agent code-reviewer

# CLI 也支持 --agents JSON（等价于 SDK 的 programmatic agent）
claude -p "Review this code" --agent greeter --agents '{"greeter":{"description":"...","prompt":"...","tools":["Read"]}}'
```

---

## 未验证的行为（待后续实验）

- [ ] CLI `--agent` flag 是否完整注入 filesystem agent 的 prompt（需要 claude CLI 环境）
- [ ] `--bare` 模式下 `--agent` 是否仍然发现 filesystem agent
- [ ] filesystem agent 的 `model` 字段是否在 SDK 中生效
- [ ] filesystem agent 的 `permissionMode` 字段是否在 SDK 中生效
- [ ] filesystem agent 的 `hooks` 字段是否在 SDK 中生效
- [ ] filesystem agent 的 `mcpServers` 字段是否在 SDK 中生效
- [ ] 多个 filesystem agent 同时存在时的 `supportedAgents()` 返回值
- [ ] `initialPrompt` 字段在 SDK agent 会话模式下的行为

---

## 测试环境说明

- **LLM Proxy**: 本地 LLM proxy（`http://10.1.3.115:4000`），模型 `Jereh-LLM-NO-THINK-V1`
- **CLI 可用性**: 当前环境无 `claude` CLI，CLI 相关测试已 skip
- **SDK 版本**: `@anthropic-ai/claude-agent-sdk` v0.2.133（`cc_version=2.1.133.b40`）
- **Fixture**: `test/integration/fixtures/project-with-agents/.claude/agents/greeter.md`

---

## 相关文档

- [Agent 工具行为洞察](./tool-agent-behavior.md)
- [SDK Subagents 文档](./claude-code-docs/docs/agent-sdk__subagents.md)
- [CLI Sub-agents 文档](./claude-code-docs/docs/sub-agents.md)
- [CLI Reference](./claude-code-docs/docs/cli-reference.md)
