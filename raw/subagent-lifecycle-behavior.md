# Subagent（Agent 工具子代理）全生命周期 + 实时增量 观察性研究

研究 `@anthropic-ai/claude-agent-sdk` 中 subagent 的工具调用机制、前后台、生命周期、实时增量。
测试见 `test/integration/tool-foreground-background.spec.ts`（case-30 起）。

本文覆盖全部四个阶段：
- **阶段一（是不是工具调用机制）** case-30
- **阶段二（前后台）** case-31~33
- **阶段三（全生命周期阶段与事件）** case-34~35
- **阶段四（实时增量信息）** case-36~39

> 阶段三/四的关键前置条件（本轮踩坑得出）：
> 1. **必须让 subagent 跑前台**（prompt 显式要求 run_in_background:false 并等其完成）。否则默认后台语义下主 turn 不阻塞，query 在 subagent 完成前就 result 结束，拿不到完整生命周期 / SubagentStop / 长任务 summary。
> 2. **getSubagentMessages / listSubagents / transcript 文件读依赖 `persistSession:true`**。persistSession:false 时 subagent transcript 不落盘，三者全程返回空/路径失效（case-38 首跑即因此全 0）。

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
| case-34 | subagent 完整生命周期时间线 | **前台 subagent 走完整嵌套生命周期**：外层 `task_started(local_agent)` → 多条 `task_progress`(心跳，带 last_tool_name) → 内层每步 `task_started(local_bash)`+`task_notification(completed)` → 最后外层 `task_updated(completed)` + `task_notification(completed)`。内外层交错，靠 task_id 区分层级 |
| case-35 | SubagentStart/Stop hook | **两 hook 均触发**。`agent_id` === `task_started(local_agent).task_id`（完全相等）。SubagentStart 与 task_started 近乎同时（相差十几 ms）。SubagentStop 携带 `agent_transcript_path`+`last_assistant_message`+`background_tasks:[]`，字段比 Start 丰富（多 permission_mode/effort/stop_hook_active/session_crons）。**注意：后台 subagent 只触发 Start 不触发 Stop**（query 提前结束） |
| case-36 | forwardSubagentText true vs false | **是转发子会话 text/thinking 的核心开关**。纯文本子任务下：false → 0 条 subagent assistant 消息；true → 转发子会话 assistant 消息（带 `subagent_type`/`task_description`/`parent_tool_use_id`，`hasText=true`）。这是「实时看 subagent 在说什么」的主通道 |
| case-37 | agentProgressSummaries=true | **生效，验证 ~30s fork 摘要**。前台长任务（>55s）下 ON 推送 2 条 `task_progress.summary`（首条@42.6s，次条@76.3s，间隔~34s），OFF 全程 0 条。summary 内容是子任务当前动作的自然语言描述（如 "Running phase1 sleep command"）。**需 subagent 真跑够 >30s 才有** |
| case-38 | getSubagentMessages 主动拉取 | **可用，但依赖 `persistSession:true`**。persistSession:false 时全程返回空数组（transcript 不落盘）。开启后 `listSubagents` 0→1、`getSubagentMessages` 单调增长 1→8，随 subagent 进展递增。agentId 来自 SubagentStart hook 或 listSubagents |
| case-39 | 三通道横向对照 | 三条实时增量通道均可用：**A forwardSubagentText**（流式，最实时，subagent 一产出即到）；**B getSubagentMessages**（1Hz 拉取，随 persist 落盘单调增长 1→10）；**C transcript 文件读**（落盘最晚，路径要等 SubagentStop 才拿到，本轮仅在收尾时读到 12 行）。CodePilot 首选 A，B 作为对账/补拉，C 仅事后审计 |

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

### case-34：subagent 完整生命周期时间线（阶段三核心）

前台多步骤子任务（subagent 依次跑 3 个 `echo && sleep 3` 的 Bash），GLM，重建的完整序列（相对 query 启动时刻）：

| relMs | 事件 | task_type | task_id | 说明 |
|-------|------|-----------|---------|------|
| 4969 | task_started | local_agent | a97d…（外层） | subagent 启动，subagent_type=general-purpose |
| 9738 | task_progress | local_agent | a97d… | 外层心跳，last_tool_name=Bash |
| 16151 | task_started | local_bash | bxay…（内层1） | subagent 内部第 1 个 Bash |
| 16451 | task_notification | local_bash | bxay… | 内层1 completed（+300ms） |
| 20598 | task_progress | local_agent | a97d… | 外层心跳 |
| 23766 | task_started | local_bash | bj13…（内层2） | 内部第 2 个 Bash |
| 23983 | task_notification | local_bash | bj13… | 内层2 completed |
| 29328 | task_progress | local_agent | a97d… | 外层心跳 |
| 32471 | task_started | local_bash | bw40…（内层3） | 内部第 3 个 Bash |
| 32727 | task_notification | local_bash | bw40… | 内层3 completed |
| 37310 | **task_updated** | local_agent | a97d… | 外层 status=completed（patchKeys=[status,end_time]）|
| 37310 | **task_notification** | local_agent | a97d… | 外层 completed（收尾，带 usage）|

**关键结构**：
- **嵌套 + 交错**：外层 `local_agent` 全程存活（4969→37310ms），内部每个 Bash 步骤各自是一个独立的 `local_bash` task（started→notification 成对，仅相差 ~300ms）。外层 task_progress 心跳穿插在内层 task 之间。
- **task_id 格式区分层级**：外层 `a...`（17 位十六进制），内层 `local_bash` 是短随机串（`bxay12p05` 等）。
- **收尾**：外层的 `task_updated(completed)` 与 `task_notification(completed)` **同时**到达（37310ms），是整个生命周期的最后两条 system 消息。
- **各消息字段**：
  - `task_started(local_agent)`：`type,subtype,task_id,tool_use_id,description,subagent_type,task_type,prompt,uuid,session_id`（比 local_bash 多 subagent_type+prompt，复验 case-30）
  - `task_progress(local_agent)`：`…,subagent_type,usage,last_tool_name,…`（心跳带累加 usage + 最近工具名）
  - `task_notification`：`…,tool_use_id,status,output_file,summary,[usage],…`（外层收尾那条额外带 usage）

**对照 Bash 生命周期**：Bash 的 4 种 task 消息（task_started/progress/notification/updated）subagent **全部覆盖**，且 subagent 因内含 Bash 而天然是**两层嵌套** task 树，比单层 Bash 复杂一层。

### case-35：SubagentStart/Stop hook（阶段三）

通过 `Options.hooks` 注册两个 hook，前台子任务（GLM）：

| hook | relMs | agent_id | 关键字段 |
|------|-------|----------|---------|
| SubagentStart | 4708 | a0de…9 | session_id,transcript_path,cwd,prompt_id,agent_id,agent_type,hook_event_name |
| SubagentStop | 22938 | a0de…9 | 上述 + permission_mode,effort,stop_hook_active,**agent_transcript_path**,**last_assistant_message**,**background_tasks**,session_crons |

**关键发现**：
- **`agent_id` === `task_started(local_agent).task_id`**（a0de27acb68c44fa9，完全相等）。这是 hook 与 task 消息的核心关联键。
- **时机对齐**：SubagentStart@4708ms 与 task_started(local_agent)@4695ms 几乎同时（相差 13ms，hook 略晚）。
- **SubagentStop 字段更丰富**：携带 `agent_transcript_path`（subagent JSONL 落盘路径）、`last_assistant_message`（最后一条 assistant 文本，省去解析 transcript）、`background_tasks:[]`（本例为空）。
- **后台 subagent 只触发 Start 不触发 Stop**：case-35 首跑（未强制前台）只命中 SubagentStart，因 subagent 后台化后主 query 在其完成前就 result 结束。要拿 SubagentStop 必须让 subagent 前台跑完。
- `agent_transcript_path` 指向 `~/.claude/projects/{项目}/{sessionId}/subagents/agent-{agentId}.jsonl`，但 **persistSession:false 时该文件运行结束后即不存在**（见 case-38/39）。

### case-36：forwardSubagentText true vs false（阶段四核心开关）

纯文本子任务（要求 subagent 不用任何工具，只写一段 REST API 解释），同 prompt 两跑（GLM）：

| 指标 | false | true |
|------|-------|------|
| subagent assistant 消息数（带 subagent_type/parent_tool_use_id）| **0** | **1**（hasText=true）|
| thinking_delta 总数 | 35 | 39 |
| text_delta 总数 | 282 | 252 |

**结论**：`forwardSubagentText` 是**转发 subagent 子会话 text/thinking 块的开关**。
- **false**：主流上**看不到 subagent 的独立 assistant text 消息**（subagentAssistantMsgs=0），只有主 agent 转述。SDK 文档说 false 时只发 subagent 的 tool_use/tool_result（心跳级别）。
- **true**：SDK 额外转发 subagent 的完整 assistant 消息，每条带 `subagent_type`（general-purpose）、`task_description`（"Explain REST API from knowledge"）、`parent_tool_use_id`（call_…，指向外层 Agent tool_use）。
- 注意 text_delta 总数两跑相近（都有几百条），因为主 agent 自己也在输出文本——**区分子会话 text 的关键不是 delta 计数，而是带 `parent_tool_use_id`/`subagent_type` 的 assistant 消息**。这是「实时看 subagent 在说什么/想什么」的主通道。

### case-37：agentProgressSummaries=true（阶段四，~30s fork 摘要）

前台长任务（subagent 依次跑 4 个 `sleep 15`，累计 >55s），ON/OFF 对照（GLM）：

| | ON | OFF |
|--|----|----|
| task_progress 总数 | 6 | （未统计 summary）|
| 带 summary 的 task_progress | **2** | **0** |
| 首个 summary 到达 | 42568ms | — |
| 次个 summary 到达 | 76331ms | — |
| 间隔 | ~33.8s | — |

**结论**：`agentProgressSummaries=true` 生效，**每 ~30s fork 一次生成子任务进度摘要**，经 `task_progress.summary` 字段推送。
- summary 内容是子任务当前动作的自然语言（首条 "Running phase1 sleep command"，次条 "Running phase3 sleep command"）。
- OFF 时 task_progress 心跳照常发（case-34 证实），但**无 summary 字段**。
- **强前置条件**：subagent 必须真跑够 >30s（前台长任务）。case-37 首跑因子任务只 ~14s（且后台化提前结束）→ 0 summary。这不是功能失效，是没跑够时长。
- 带 summary 的 task_progress 字段：`…,subagent_type,usage,**summary**,…`（比普通心跳多 summary，少 last_tool_name）。

### case-38：getSubagentMessages / listSubagents 主动拉取（阶段四）

1Hz poller 在 subagent 运行中拉取。**首跑 persistSession:false 全程返回空（listCount 恒 0、getSubagentMessages 恒 0）**——推断 transcript 未落盘。改前台 + `persistSession:true` 复跑：

| API | 序列（去重）|
|-----|------|
| listSubagents(sessionId) | 0 → 1 |
| getSubagentMessages(sessionId, agentId).length | -（agentId 未到）→ 1 → 2 → 3 → … → 8（**单调增长**）|

**结论**：
- 两个 API **可用，但强依赖 `persistSession:true`**。它们读的是 subagent JSONL transcript 文件；persistSession:false 时不落盘，全程返回空数组（**否定发现 → 定位根因**）。
- 开启后 `getSubagentMessages` 返回条数**随 subagent 对话推进单调增长**（每完成一步 Bash + 报告，transcript 追加消息），可作为拉取式进度指标。
- `agentId` 来源：SubagentStart hook 的 `agent_id`，或 `listSubagents()` 返回数组（两者一致）。
- 时序：agentId 在 subagent 启动后 ~8-9s 才可得（先要 task_started/SubagentStart），此后每秒拉取都能反映最新落盘条数。

### case-39：三通道横向对照（阶段四总结）

前台 + persistSession:true + forwardSubagentText:true，同时开三通道观测（GLM）：

| 通道 | 机制 | 本轮实测 | 时延特性 |
|------|------|---------|---------|
| **A** forwardSubagentText | 流式推送子会话 assistant 消息 | subagentAssistantMsgs=7，首个带 text@23204ms | **最实时**：subagent 一产出即随 stream 到达 |
| **B** getSubagentMessages | 1Hz 主动拉 JSONL | 单调增长 1→10（9072ms 起每秒可拉）| 落盘后即可拉，~1s 粒度，依赖 persist |
| **C** transcript 文件读 | 直接读 agent JSONL | 仅在 41371ms（SubagentStop 附近）读到 12 行 | **最晚**：`agent_transcript_path` 要等 SubagentStop 才拿到 |

**结论**：三通道均可用，但特性差异明显——A 实时推送（无需轮询、无需 persist）、B 拉取式（需 persist、可对账/补拉历史）、C 仅事后审计（路径晚、需 persist、要自己解析 JSONL）。

## 实时增量三通道选型（CodePilot 建议）

| 维度 | A forwardSubagentText | B getSubagentMessages | C transcript 文件读 |
|------|----------------------|----------------------|---------------------|
| 实时性 | **最高**（流式即时）| 中（1Hz 轮询）| 低（路径晚到）|
| 完整度 | 高（含 text/thinking，带 subagent_type/parent_tool_use_id）| 高（结构化 user/assistant）| 高（原始 JSONL 全量）|
| 是否需 persistSession | **否** | **是**（否则空）| **是**（否则文件不存在）|
| 是否需轮询 | 否 | 是 | 是 |
| 获取成本 | 开 1 个 Option 即可 | 需 sessionId + agentId + 轮询 | 需解析 JSONL + 等 SubagentStop 拿路径 |
| 适用场景 | **主通道**：实时渲染 subagent 嵌套 transcript | 对账/断线补拉/分页历史 | 事后审计/离线分析 |

**推荐**：CodePilot 实时展示 subagent 用 **A（forwardSubagentText:true）为主**——无需 persist、无需轮询、随 stream 即时到达，且每条带 `parent_tool_use_id`/`subagent_type` 便于按层级渲染嵌套会话。**B 作为补充**（需要断线重连补拉或分页查历史时用，但必须 persistSession:true）。**C 一般不用**（路径晚、要自己解析，仅离线审计场景考虑）。

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
6. **完整生命周期监听**（case-34）：要拿到 subagent 收尾的 `task_notification(completed)`，需让 subagent 前台跑完（否则 query 提前 result 结束）。生命周期最后两条是同时到达的外层 `task_updated(completed)` + `task_notification(completed)`。
7. **hook 关联键**（case-35）：`SubagentStart/Stop.agent_id` === `task_started(local_agent).task_id`。SubagentStop 的 `last_assistant_message` 可直接拿 subagent 最终输出，免解析 transcript。
8. **实时展示 subagent 说什么**（case-36）：开 `forwardSubagentText:true`，按 assistant 消息的 `parent_tool_use_id`/`subagent_type` 归类渲染嵌套会话——首选通道，无需 persist/轮询。
9. **进度摘要**（case-37）：长任务想要 ~30s 粒度的自然语言进度，开 `agentProgressSummaries:true`，读 `task_progress.summary`。
10. **拉取式历史**（case-38）：`getSubagentMessages`/`listSubagents`/transcript 文件读**必须 `persistSession:true`**，否则全程空——CodePilot 若关闭持久化，这三条通道不可用，只能靠 A。

## subagent 完整生命周期图（对照 Bash）

前台 subagent（内含 3 步 Bash）的完整生命周期，横轴为相对时刻，展示嵌套 task 树 + hook + 三条实时增量通道：

```
主 query turn
  │
  ├─[t=4.7s] Agent tool_use (block.id=call_xxx)
  │            ├── task_started(local_agent, task_id=a97d…)   ← 外层 subagent task 起点
  │            └── SubagentStart hook (agent_id==a97d… == task_id)  ← 与 task_started 差 ~13ms
  │
  │  ┌─────────────────── 外层 local_agent 全程存活 ───────────────────┐
  │  │ [t~10s] task_progress(local_agent, last_tool_name=Bash)  ← 心跳（默认）
  │  │         · agentProgressSummaries:true → task_progress.summary（每~30s，t=42s/76s…）
  │  │         · forwardSubagentText:true → 转发子会话 assistant（带 parent_tool_use_id）  ← 通道A 实时
  │  │         · getSubagentMessages 1Hz 拉取 → 条数单调增长（需 persistSession）        ← 通道B
  │  │                                                                   │
  │  │   ├─[t=16s] task_started(local_bash, id=bxay…)  ┐                 │
  │  │   │        task_notification(local_bash,completed)┘ 内层步骤1（+300ms 成对）
  │  │   ├─[t=20s] task_progress(local_agent) 心跳                       │
  │  │   ├─[t=24s] task_started/notification(local_bash) 内层步骤2       │
  │  │   ├─[t=29s] task_progress(local_agent) 心跳                       │
  │  │   ├─[t=32s] task_started/notification(local_bash) 内层步骤3       │
  │  └──┴──────────────────────────────────────────────────────────────┘
  │
  ├─[t=37s] task_updated(local_agent, status=completed)  ┐ 同时到达
  │         task_notification(local_agent, completed, +usage) ┘ ← 外层收尾（生命周期最后两条 system 消息）
  │         SubagentStop hook (带 agent_transcript_path / last_assistant_message / background_tasks:[])
  │         · transcript 文件此刻可读（通道C，需 persistSession）
  │
  └─ 主 turn 继续 / result
```

**与 Bash 生命周期的对照**：
- Bash（local_bash）：单层 task，4 种消息（started/progress/notification/updated）。
- Subagent（local_agent）：**两层嵌套** task 树——外层 local_agent 存活期间，内部每个工具调用（如 Bash）各自是独立 local_bash task。外层同样有全部 4 种 task 消息，额外有 SubagentStart/Stop hook 和三条实时增量通道。
- 控制方法差异（case-33）：stopTask 对两者一致生效；backgroundTasks 对 local_bash 返回 true（可转后台），对 local_agent 返回 false。

## 未验证行为（后续研究）

- **paused 状态**：subagent 的 task_updated 是否会出现 paused（Bash 场景 case-28 从未触发；case-34 只见 completed）。
- **interrupt 对 subagent**：本轮未测 interrupt() 对 local_agent 的影响。
- **`isolation` 字段**：GLM 未填该字段，其取值与效果未观测。
- **backgroundTasks 无参**对含 subagent 的批量场景未测。
- **本地 Jereh-LLM 对照**：阶段三/四以 GLM 为主（稳定触发前台长任务 subagent）。本地 LLM 未逐 case 对照——本地触发真实 subagent + 遵循「前台跑完」指令不稳定，留作后续。
- **forwardSubagentText 的 thinking 转发**：case-36 纯文本子任务 thinking_delta 两跑相近，未单独隔离验证 true 是否额外转发子会话 thinking 块（当前只确证 text 侧的 assistant 消息差异）。
- **多 subagent 并发**：listSubagents 返回数组，本轮只测单 subagent（返回 1），并发多 subagent 时 agentId 区分与拉取未测。

## 相关文档

- Bash 前后台生命周期：`raw/tool-foreground-background-behavior.md`（case-1~29）
- 研究计划：`~/.claude/plans/async-dancing-piglet.md`
