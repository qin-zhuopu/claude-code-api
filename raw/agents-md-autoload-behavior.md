# `.claude/agents/*.md` 是否自动加载进 system prompt —— 观察性测试

## 一句话结论

**不会全量注入 system prompt。** `.claude/agents/*.md` 在会话启动时以**摘要清单**（`- <name>: <description> (Tools: ...)` 一行）的形式，注入到**对话上下文的一条 `role=system` 的 message**（Agent 工具文档所称的 `<system-reminder>`），而**不是**顶层 `system` 字段（真正的 system prompt）。**md 的正文 body 从不出现在任何请求体中**。

即：agents md 是「让模型知道有哪些 subagent 可被 Agent 工具选中」的**清单**，属于**按需/摘要式**加载，不是「启动时把整篇 agent 定义灌进 system prompt」。

## 核心发现摘要

| 维度 | 结论 | 证据 |
|---|---|---|
| agent md **正文 body** 是否进 system prompt | **否**（任何情况都不进） | `BODY_MAGIC=ZZUNIQUEBODY9X4K7` 全 5 case、system 与 messages 全字段 = False |
| agent **name/description** 是否进 system prompt | **否** | `systemHasNameMagic` 全 case = False |
| agent **name/description** 是否进对话上下文 | **是**（摘要一行） | case-1/case-5 `messagesHasNameMagic=True`，落在 `Available agent types` 清单 |
| 加载受什么门控 | `settingSources` 必须含 `'project'` | case-2 `settingSources:[]` → 摘要消失（`messagesHasNameMagic=False`） |
| 真实会话形态（preset claude_code）下是否变化 | **不变**，结论一致 | case-5 system prompt 涨到 6923 字符仍不含任何 agent magic |
| 编程式 `agents` option | 同样只以摘要进对话上下文 | case-4 `messagesHasProgName=True`、`messagesHasProgBody=False` |

## 实验矩阵

测试文件：`test/integration/agents-md-autoload.spec.ts`
fixture：`test/integration/fixtures/project-with-agents/.claude/agents/magic-agent.md`
- name/description 含 `MAGICPROBE7Q3X`（摘要标记）
- body 含 `ZZUNIQUEBODY9X4K7`（仅当正文被注入才会出现）

端点：`https://litellm.jereh.cn` + `Jereh-Qwen3.8-Flash-Next`（走 anthropic messages 协议，200 通）。

| case | 配置 | sysChars | system 含 name/body | messages 含 name/body | 裁决 |
|---|---|---|---|---|---|
| 1 | `settingSources:['project']` + cwd=含 agents | 136 | False / False | **True** / False | B（仅摘要进对话上下文） |
| 2 | `settingSources:[]` + 同 cwd | 136 | False / False | False / False | C（完全不出现，被隔离） |
| 3 | baseline 空项目 | 136 | False / False | False / False | C |
| 4 | 编程式 `agents`（独特 magic） | 136 | False / False | prog: True / False | 编程式 agent 同样只进摘要 |
| 5 | `preset:claude_code` + cwd=含 agents | **6923** | False / False | **True** / False | B（完整 prompt 下结论不变） |

## 关键机制（直接来自真实请求体）

### 1. 顶层 `system` 字段（真正的 system prompt）不含 agent

bare 模式下 `system` 只有 2 个 block、共 136 字符：
```
[block 0] x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-ts;
[block 1] You are a Claude agent, built on Anthropic's Claude Agent SDK.
```
preset claude_code 下 `system` 涨到 6923 字符（3 block），是 Claude Code 完整默认提示词——但**仍不含任何 agent 名/描述/正文**。

### 2. agent 清单落在 messages 里的 `role=system` reminder

case-1 的 `messages[1]`（role=system，7789 字符）内容开头：
```
Available agent types for the Agent tool:
- buddy: 我的小伙伴... (Tools: Read, Grep, Glob)
- greeter: A test agent... (Tools: Read)
- magic-autoload-probe: MAGICPROBE7Q3X A unique probe agent... (Tools: Read)
- researcher: SDK 行为调研员... (Tools: All tools except Agent)
...
```
——只有**每个 agent 的 name + description + tools 一行摘要**，`ZZUNIQUEBODY9X4K7`（正文）不在其中。

Agent 工具自己的 description 也印证了这个设计：
> Available agent types are listed in `<system-reminder>` messages in the conversation.

### 3. `settingSources` 门控 filesystem 发现

- 含 `'project'`：读 `.claude/`，fixture agent 出现在清单（case-1/5）。
- `[]`（SDK 隔离模式）：不读 `.claude/`，fixture agent 从清单消失（case-2）。
- 内建 agent（buddy/Explore/general-purpose/Plan 等）与用户级 `~/.claude/agents`（researcher/stream-tool-researcher 等）始终在清单里，不受 cwd 影响——所以 `agentListedAsSummary` 在所有 case 都为 True，但**唯有 magic fixture agent 只在 case-1/5 出现**，对照干净。

## 实际应用建议

1. **不要把「希望模型每次都遵守的规则」写进 `.claude/agents/*.md` 的正文** —— 主会话根本读不到正文，只读到一行 description。正文只有当该 agent 被 Agent 工具真正启动为 subagent 时才作为那个子会话的 system prompt 生效。
2. **description 要写清「何时用我」** —— 这是主会话选 subagent 的唯一依据（清单里只有它可见）。
3. 想让内容进主会话 system prompt，用 `CLAUDE.md`（需 `settingSources` 含 `'project'`）或 `systemPrompt` option，而非 agents md。
4. SDK 隔离测试用 `settingSources:[]` 会同时屏蔽 filesystem agent 清单。

## 未验证 / 边界

- 未直接观测「Agent 工具真正启动 subagent」时，正文 body 是否作为该 subagent 的 system prompt（本测试为安全起见未触发 subagent 启动）。可参考 `tool-agent.spec.ts` / `agent-shared-mechanism.spec.ts` 后续验证。
- 端点用的是 `litellm.jereh.cn`（本地网关），SDK 版本 `cc_version=2.1.263`；不同 CLI/SDK 版本清单格式可能微调，但「正文不进 system prompt」是结构性设计，预期稳定。
