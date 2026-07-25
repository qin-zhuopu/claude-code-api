# Subagent（Agent 工具子代理）全生命周期 + 实时增量 观察性研究

研究 `@anthropic-ai/claude-agent-sdk` 中 subagent 的工具调用机制、前后台、生命周期、实时增量。
测试见 `test/integration/tool-foreground-background.spec.ts`（case-30 起）。

本文覆盖**阶段一（是不是工具调用机制）+ 阶段二（前后台）**，即 case-30~33。
阶段三（生命周期事件 case-34/35）、阶段四（实时增量 case-36~39）为后续研究。

## 环境说明

- **主用智谱 GLM**（`BIGMODEL_ENV`，glm-5.2）——能稳定触发真实 subagent。
- 关键 case 用本地 Jereh-LLM（`BASE_ENV`）对照。本轮 case-32 本地也成功触发 subagent。
- 统一：`permissionMode:'bypassPermissions'`、`settingSources:[]`、`effort:'low'`、`includePartialMessages:true`。

## 核心发现摘要表

| # | 观察目标 | 结论 |
|---|---------|------|
| case-30 | subagent 是不是工具调用机制 | **是**。Agent 与 Bash 走完全相同的 `content_block_start(tool_use)→input_json_delta→content_block_stop→tool_result` 骨架。唯一差异：Agent 伴随 `task_started(task_type=local_agent)` + subagent 内部 assistant 展开（parent_tool_use_id 非 null） |
| case-31 | 前台 vs 后台 subagent | prompt 显式要求时，`input.run_in_background` 分别为 `false` / `true`。两者都产生 `task_started(local_agent)` + 内层 `task_started(local_bash)` + 2 条 task_notification。前台阻塞主 turn（等 subagent 完成），后台异步 |
| case-32 | 默认 run_in_background | **默认省略该字段**（GLM 与本地 Jereh-LLM 一致，`hasField=false`），复验 case-5「默认后台」结论成立 |
| case-33A | stopTask 对 local_agent | **生效**，与 Bash（case-15/26）完全一致：`task_updated.status=killed` + `task_notification.status=stopped`，sleep 30 被中断（task_started 后 ~1-3s 内结束） |
| case-33B | backgroundTasks 对 local_agent | **返回 `false`**（与 Bash case-17 的 `true` 相反）。subagent 无法被 backgroundTasks「转后台」，任务照常跑到 completed（~44s） |

## 详细发现

### case-30：Agent 与 Bash 共享 tool_use 骨架（子问题1 = 是）

同一批 prompt 各触发一次 Bash / Agent（均 GLM）：

| 指标 | Bash | Agent |
|------|------|-------|
| content_block_start(tool_use) | 1 | 1 |
| input_json_delta 次数 | 17 | 43 |
| content_block_stop | 2 | 4 |
| user tool_result | 有 | 有 |
| input 字段 | `command`, `description` | `description`, `prompt`, `subagent_type`, `run_in_background` |
| task_started | **无**（echo 短命令，同 case-1） | **有，task_type=`local_agent`** |
| subagent 内部 assistant（parent_tool_use_id≠null） | — | 1 条 |

结论：subagent **就是一次 Agent 工具调用**，走与 Bash 完全相同的流式 tool_use 骨架。
input_json_delta 逐步拼出 Agent 的 6 字段中的实际字段（本轮 GLM 只填了 4 个：description/prompt/subagent_type/run_in_background；`model`/`isolation` 未填，由 SDK 取默认）。
差异仅在：**Agent 额外伴随 `task_started(local_agent)`，并展开一层带 `parent_tool_use_id` 的子会话消息**。

`task_started(local_agent)` 的完整字段：`type, subtype, task_id, tool_use_id, description, subagent_type, task_type, prompt, uuid, session_id`（比 local_bash 多 `subagent_type` 和 `prompt`）。

### case-31：前台 vs 后台 subagent（子问题2）

prompt 显式要求前台 / 后台，跑 `sleep 5 && echo ...` 的子任务（GLM）：

| | 前台 | 后台 |
|--|------|------|
| `input.run_in_background` | `false` | `true` |
| task_started 数 | 2 | 2 |
| task_notification 数 | 2 | 2 |
| 耗时 | 29.8s | 34.7s |

两种情况都产生**两个 task_started**：外层 `local_agent`（subagent 本身）+ 内层 `local_bash`（subagent 内部执行的 Bash）。
即 subagent 是嵌套 task：subagent 是一个 task，它内部的 Bash 又是一个 task。

关键：**无论前台还是后台，subagent 都会走完整的 task 生命周期（task_started + task_notification）**——这与短前台 Bash（case-1/case-30 的 Bash，无任何 task 消息）不同。subagent 天生是 task。

### case-32：默认 run_in_background（复验 case-5）

不给任何前后台指示，读 Agent input：

| 模型 | run_in_background 字段 | task_type |
|------|----------------------|-----------|
| GLM (glm-5.2) | **缺省**（`hasField=false`） | local_agent |
| 本地 Jereh-LLM | **缺省**（`hasField=false`） | local_agent |

两个模型一致：默认不填 `run_in_background` 字段。复验 case-5「v2.1.198 默认后台（input 无该字段）」结论成立，且**不是模型行为差异**——GLM 和本地 LLM 都省略。本地 Jereh-LLM 本轮也成功触发了真实 subagent（task_type=local_agent）。

### case-33：控制方法对 local_agent 是否生效（关键补白）

现有终止/转后台（case-15/17/26）**只测过 Bash（local_bash）**。本 case 首次验证控制方法对 subagent（local_agent）。
streaming-input 模式，subagent 跑 `sleep 30 && echo ...`，等 `task_started(task_type=local_agent)` 后调控制方法（遵循 case-17 铁律）。

**case-33A — stopTask(taskId)**（2 次运行一致）：
- `controlResult=OK`
- `task_updated.patch.status=killed`（patchKeys=[status, end_time]）
- `task_notification.status=stopped`
- `killedInterrupted=true`：sleep 30 被中断，task_started 后仅 ~30ms 内即 killed，总耗时 15-19s（远小于自然完成）
- **结论：stopTask 对 local_agent 完全生效，行为与 Bash（case-15/26）一致——killed patch + stopped notification**

**case-33B — backgroundTasks(toolUseId)**（2 次运行一致）：
- `controlResult=false`（对照：Bash 在 case-17 同样时机返回 `true`）
- 用的 id：`task_started.tool_use_id` === 顶层 Agent block.id（`call_xxx` 格式），两者一致
- subagent 照常跑到 `task_notification.status=completed`（task_started 后 ~37s），总耗时 ~49s
- `task_updated` 只有一条 `status=completed`
- **结论：backgroundTasks 对 local_agent 返回 false，无法把 subagent「转后台」**

**id 关联链**（对照 case-24）：
- `task_started.tool_use_id` === 顶层 Agent tool_use `block.id`（`call_...` 格式）
- `task_started.task_id`（`a...` 格式）= stopTask 使用的 id = `tool_result` 里的 `backgroundTaskId`

## 关键差异：subagent vs Bash 的控制方法

| 控制方法 | Bash (local_bash) | Subagent (local_agent) |
|---------|-------------------|------------------------|
| stopTask(taskId) | 生效（case-15/26）：killed + stopped | **生效，行为一致**：killed + stopped |
| backgroundTasks(toolUseId)（task_started 后调） | 返回 `true`（case-17），转后台解阻塞 | **返回 `false`，不能转后台** |

推断：backgroundTasks 的语义是「把一个正阻塞主 turn 的**前台命令**移到后台」。subagent 本身已是独立 task（默认后台语义），SDK 不再为其提供「转后台」操作，故返回 false。但 stopTask 是通用的「停止某个 task」，对任何 task_type 都生效。

## 实际应用建议（CodePilot）

1. **识别 subagent**：监听 `task_started` 且 `task_type==='local_agent'`。它带 `subagent_type` 和 `prompt` 字段（local_bash 没有）。
2. **前后台判定**：读 Agent tool_use 的 `input.run_in_background`；缺省即默认（后台语义）。
3. **终止 subagent**：用 `stopTask(task_started.task_id)`——可靠，产生 killed + stopped，与 Bash 一致。
4. **不要用 backgroundTasks 处理 subagent**：对 local_agent 返回 false，无效。subagent 若需异步，靠 `run_in_background:true` 在启动时决定，而非运行中转后台。
5. **嵌套 task**：subagent 内部的 Bash 会产生自己的 `local_bash` task_started/notification，注意用 `parent_tool_use_id` / id 链区分层级。

## 未验证行为（后续研究）

- **实时增量三通道**（阶段四 case-36~39）：`forwardSubagentText`、`agentProgressSummaries`、`getSubagentMessages`/`listSubagents`、transcript 文件——全部未测。
- **生命周期事件**（阶段三 case-34/35）：subagent 版 task_progress 完整时间线、SubagentStart/Stop hook（agent_id / agent_transcript_path / background_tasks）。
- **paused 状态**：subagent 的 task_updated 是否会出现 paused（Bash 场景 case-28 从未触发）。
- **interrupt 对 subagent**：本轮未测 interrupt() 对 local_agent 的影响。
- **`isolation` 字段**：GLM 未填该字段，其取值与效果未观测。
- **backgroundTasks 无参**对含 subagent 的批量场景未测。

## 相关文档

- Bash 前后台生命周期：`raw/tool-foreground-background-behavior.md`（case-1~29）
- 研究计划：`~/.claude/plans/async-dancing-piglet.md`
