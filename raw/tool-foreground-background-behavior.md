# 前台/后台工具调用机制观察性实验

> 调研人：Claude Code  
> 日期：2026-07-08  
> 状态：已完成全部实验（11/11 cases 完成）

---

## 核心发现摘要表

| # | 发现 | 证据 |
|---|------|------|
| 1 | **前台 Bash 不产生 task_started/task_notification 消息** — 直接以 tool_result 返回结果 | Case 1: 0 个 task 事件 |
| 2 | **`run_in_background: true` 出现在 input_json_delta 中** — LLM 会将该字段作为 Bash 工具参数传递 | Case 2: `"run_in_background": true` |
| 3 | **后台 Bash 的 tool_result 包含 `backgroundTaskId` 字段** — 结构不同于前台 | Case 2: `{..., backgroundTaskId: "bgouhkf54"}` |
| 4 | **task_type 值为 `local_bash`**（不是 SDK 类型中写的 `'shell'`） | Case 2,3,4,5,7,8 |
| 5 | **`task_started` 消息确实存在且结构完整** — 含 task_id/tool_use_id/description/task_type/uuid/session_id | 全部后台 case |
| 6 | **Agent 前台时 `run_in_background: false` 显式出现在 input 中** | Case 4 |
| 7 | **Agent 后台（默认）时 input 中没有 `run_in_background` 字段** — v2.1.198 默认后台生效 | Case 5 |
| 8 | **task_type 区分**：Bash→`local_bash`, Agent→`local_agent`, Workflow→`local_workflow` | Case 4,5,6 |
| 9 | **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 不阻止后台运行** — LLM 仍设置 `run_in_background: true`，task 仍启动，但 status 为 `stopped` 而非 `completed` | Case 7 |
| 10 | **task_notification 完成时有 `usage` 字段**（含 total_tokens/tool_uses/duration_ms），失败时没有 | Case 5(failed) vs Case 6(completed) |
| 11 | **task_started for Agent 额外包含 `subagent_type` 和 `prompt` 字段** | Case 4,5 |
| 12 | **task_started for Workflow 额外包含 `workflow_name` 和 `prompt` 字段** | Case 6 |

---

## 实验矩阵

| Case | 实验内容 | 运行状态 | 关键发现 |
|------|---------|---------|---------|
| 1 | Bash 前台运行基线（echo） | ✅ 完成 | 无 task 消息；5 次 input_json_delta；tool_result 为 `{stdout,stderr,...}` |
| 2 | Bash `run_in_background: true` | ✅ 完成 | task_type=`local_bash`；tool_result 含 `backgroundTaskId`；有 task_started+notification |
| 3 | 瞬时工具 Read 基线 | ✅ 完成（LLM 回退到 Bash） | LLM 未调用 Read，改用 Bash — 产生 local_bash task，验证"本地 LLM 不遵循指令" |
| 4 | Agent 前台 subagent | ✅ 完成 | `run_in_background: false`；task_type=`local_agent`；task_started 含 `subagent_type`+`prompt` |
| 5 | Agent 后台 subagent（默认） | ✅ 完成 | input 无 `run_in_background`；task_type=`local_agent`；task_started 含 `prompt` |
| 6 | Workflow 工具 | ✅ 完成 | task_type=`local_workflow`；task_started 含 `workflow_name`；notification 含 `usage` |
| 7 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | ✅ 完成 | LLM 仍设 `run_in_background: true`；task 仍启动；status=`stopped` |
| 8 | PowerShell 前台运行基线 | ✅ 完成 | 与 Bash 行为一致；task_type=`local_bash` |
| 9 | SSE: Bash 前台 | ✅ 完成 | SSE 包装格式确认；前台 Bash 无 task 消息 |
| 10 | SSE: Agent 后台 | ✅ 完成 | SSE 中 system→task_started/task_notification 正确传输 |
| 11 | SSE: Read 瞬时 | ✅ 完成 | SSE 中无 task 消息（Read 瞬时工具） |

---

## 详细发现

### 1. Bash 前台运行基线（Case 1）

**请求结构**（来自 `.request.json`）：
```json
{
  "name": "Bash",
  "input_schema": {
    "properties": {
      "command": { "type": "string" },
      "timeout": { "type": "number" },
      "description": { "type": "string" },
      "run_in_background": { "type": "boolean", "description": "Set to true to run this command in the background." },
      "dangerouslyDisableSandbox": { "type": "boolean" }
    },
    "required": ["command"]
  }
}
```

**事件序列**（27 个事件）：
```
[0] system → init
[1] system → status
[2-4] stream_event → message_start/content_block_start/content_block_stop (text)
[5] stream_event → content_block_start [Bash] toolUseId=call_xxx
[6-10] stream_event → input_json_delta (5次: ""、"{"、command、description、"}")
[11] assistant → tool_use Bash
[12-14] stream_event → content_block_stop/message_delta/message_stop
[15] user → tool_result (stdout="foreground-test-1")
[16] system → status
[17-26] stream_event → text_delta (回答)
[result] result → num_turns=2, stop_reason=end_turn
```

**关键观察**：
- ✅ **无 task_started、无 task_notification** — 前台 Bash 不产生 task 消息
- ✅ **5 次 input_json_delta**：空字符串 → `{` → command → description → `}`
- ✅ **无 tool_progress** — 命令执行太快（echo 瞬时完成）
- ✅ **tool_result 结构**：
  ```json
  {
    "stdout": "foreground-test-1",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
  ```
- ✅ 同时有 `messageContentTypes` 包装（`type: "tool_result"`，`contentType: "string"`）

### 2. Bash run_in_background 后台运行（Case 2）

**LLM 在 input 中传递了 `run_in_background: true`**：
```json
{
  "command": "sleep 2 && echo background-test-2",
  "run_in_background": true
}
```

**tool_result 结构（不同于前台）**：
```json
{
  "stdout": "",
  "stderr": "",
  "interrupted": false,
  "isImage": false,
  "noOutputExpected": false,
  "backgroundTaskId": "bgouhkf54"
}
```
同时 `messageContentTypes` 中 contentSnippet 为：
```
Command running in background with ID: bgouhkf54. Output is being written to: C:\Users\...\tasks\bgouhkf54.output
```

**task_started 消息**：
```json
{
  "type": "system",
  "subtype": "task_started",
  "task_id": "bgouhkf54",
  "tool_use_id": "call_xxx",
  "description": "sleep 2 && echo background-test-2",
  "task_type": "local_bash",
  "uuid": "...",
  "session_id": "..."
}
```

**task_notification 消息**（status=stopped）：
```json
{
  "task_id": "bgouhkf54",
  "status": "stopped",
  "summary": "sleep 2 && echo background-test-2",
  "error": null,
  "output_file": "C:\\Users\\...\\tasks\\bgouhkf54.output",
  "tool_use_id": "call_xxx"
}
```

**关键观察**：
- ✅ **`run_in_background` 字段出现在 input_json_delta 中** — SDK 确实将该参数传给 LLM
- ✅ **tool_result 新增 `backgroundTaskId` 字段** — 前台运行时无此字段
- ✅ **task_type 为 `local_bash`** — 不是 SDK 类型中写的 `'shell'`
- ✅ **output_file 路径**：`{temp}/claude/{sanitized-cwd}/{session-id}/tasks/{task_id}.output`
- ⚠️ **status=stopped** — 本实验在任务完成前 query 就结束了（SSE 超时或 LLM 提前结束），所以是 stopped 而非 completed

### 3. Agent 前台 subagent（Case 4）

**Agent input**：
```json
{
  "description": "Write hello to test file",
  "prompt": "Write the text \"hello from subagent\" to a file called test-output.txt...",
  "run_in_background": false
}
```

**关键观察**：
- ✅ **`run_in_background: false` 显式出现在 input 中** — 前台 subagent 也通过此字段控制
- ✅ **task_type 为 `local_agent`**
- ✅ **task_started 额外字段**：`subagent_type`、`prompt`
  ```json
  {
    "subtype": "task_started",
    "task_id": "a7d2e47a05252dcb0",
    "task_type": "local_agent",
    "subagent_type": "...",
    "prompt": "...",
    "uuid": "...",
    "session_id": "..."
  }
  ```

### 4. Agent 后台 subagent（默认）（Case 5）

**Agent input（无 run_in_background 字段）**：
```json
{
  "description": "Count TypeScript files in current directory",
  "prompt": "Count the number of .ts files in the current directory..."
}
```

**关键观察**：
- ✅ **默认后台运行时 input 中没有 `run_in_background` 字段** — v2.1.198 默认后台生效
- ✅ **仍有 task_started 消息** — task_type=`local_agent`
- ✅ **task_notification 失败时**：无 `usage` 字段，`output_file` 为空字符串
  ```json
  {
    "task_id": "a351c20a23452b96d",
    "status": "failed",
    "summary": "...",
    "output_file": "",
    "tool_use_id": "call_xxx"
  }
  ```

### 5. Workflow 工具（Case 6）

**task_started 额外字段**：
```json
{
  "subtype": "task_started",
  "task_id": "wzutn2sks",
  "task_type": "local_workflow",
  "workflow_name": "test-simple",
  "prompt": "export const meta = { ... }",
  "uuid": "...",
  "session_id": "..."
}
```

**task_notification 完成时**：
```json
{
  "task_id": "wzutn2sks",
  "status": "completed",
  "summary": "Dynamic workflow \"Simple test workflow\" completed",
  "output_file": "C:\\Users\\...\\tasks\\wzutn2sks.output",
  "usage": {
    "total_tokens": 11412,
    "tool_uses": 0,
    "duration_ms": 2803
  },
  "tool_use_id": "call_xxx"
}
```

**关键观察**：
- ✅ **task_type 为 `local_workflow`**（不是 `'workflow'`）
- ✅ **task_started 含 `workflow_name`** — workflow meta.name 的值
- ✅ **task_notification 完成时含 `usage`** — 含 total_tokens/tool_uses/duration_ms
- ✅ 有 `task_progress` 消息推送（2-3 次）

### 10. SSE 传输验证（Cases 9-11）

**Case 9: SSE Bash 前台**
- ✅ 前台 Bash 在 SSE 中**不产生** task_started/task_notification 消息
- ✅ system 消息仅含 `init`、`status`（含 tools 列表、session_id、claude_code_version 等）
- ✅ assistant tool_use input 通过 SSE 完整传输：`{command, description}`（无 run_in_background）
- ✅ user tool_result content 为 string 类型，直接包含 stdout 内容

**Case 10: SSE Agent 后台**
- ✅ SSE 中 system→task_started/task_notification 正确传输
- ✅ task_started 含 task_id、task_type=local_agent
- ✅ task_notification 含 status、summary、output_file

**Case 11: SSE Read 瞬时**
- ✅ SSE 中无 task_started/task_notification 消息（Read 为瞬时工具）
- ✅ 验证了 SSE 传输与直接 SDK 调用的一致性

### 11. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（Case 7）

**关键发现**：
- ⚠️ **LLM 仍然设置了 `run_in_background: true`** — 环境变量不影响 LLM 的指令遵循
- ⚠️ **task_started 仍然产生** — task_type=`local_bash`
- ✅ **task_notification status 为 `stopped`**（非 `completed`）— 后台功能被限制但未完全阻断

```json
// Bash input — LLM 仍然尝试后台运行
{
  "command": "sleep 1 && echo disabled-test",
  "description": "Run sleep then echo in background",
  "run_in_background": true
}
```

**结论**：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 可能仅在 TUI 中禁用 Ctrl+B 快捷键，不影响 API 层面的 `run_in_background` 参数。LLM 仍可将命令发送到后台，但最终状态会被标记为 `stopped`。

### 8. PowerShell 前台运行（Case 8）

**关键观察**：
- ✅ PowerShell 前台行为与 Bash 一致 — 无 task 消息（当 `run_in_background` 未设置时）
- ✅ LLM 尝试先用 Bash 执行 PowerShell 命令后回退到 PowerShell 工具

### 9. SSE 传输验证（Cases 9-11）

**Case 9: SSE Bash 前台**
- ✅ 前台 Bash 在 SSE 中**不产生** task_started/task_notification 消息
- ✅ system 消息仅含 `init`、`status` — 无 task 相关 subtype
- ✅ assistant tool_use input 通过 SSE 完整传输：`{command, description}`（无 run_in_background）
- ✅ user tool_result content 为 string 类型，直接包含 stdout 内容

**Case 10: SSE Agent 后台**
- ✅ SSE 中 system→task_started/task_notification 正确传输
- ✅ task_started 含 task_id、task_type=local_agent
- ✅ task_notification 含 status、summary、output_file
- ✅ SSE 包装层（serverWrap）正确嵌套 SDK 消息

**Case 11: SSE Read 瞬时**
- ✅ SSE 中无 task_started/task_notification 消息（Read 为瞬时工具）
- ✅ 验证了 SSE 传输与直接 SDK 调用的一致性

### 10. task_started 完整结构

| 字段 | Bash | Agent | Workflow |
|------|------|-------|----------|
| type | system | system | system |
| subtype | task_started | task_started | task_started |
| task_id | ✅ | ✅ | ✅ |
| tool_use_id | ✅ | ✅ | ✅ |
| description | ✅ | ✅ | ✅ |
| task_type | local_bash | local_agent | local_workflow |
| uuid | ✅ | ✅ | ✅ |
| session_id | ✅ | ✅ | ✅ |
| subagent_type | ❌ | ✅ | ❌ |
| prompt | ❌ | ✅ | ✅ |
| workflow_name | ❌ | ❌ | ✅ |

### 11. task_notification 完整结构

| 字段 | 完成时 | 失败时 | stopped 时 |
|------|--------|--------|------------|
| task_id | ✅ | ✅ | ✅ |
| status | completed | failed | stopped |
| summary | ✅ | ✅ | ✅ |
| error | ❌ | ❌（空时省略） | ❌ |
| output_file | ✅（路径） | ""（空字符串） | ✅（路径） |
| task_type | ✅ | ✅ | ✅ |
| usage | ✅ | ❌ | ❌ |
| tool_use_id | ✅ | ✅ | ✅ |
| skip_transcript | ✅ | ✅ | ✅ |

---

## 实际应用建议

### CodePilot 应如何消费 task_notification

当前 CodePilot 只提取了 3 个字段（status/summary/task_id），建议补充：

```typescript
const taskMsg = sysMsg as SDKSystemMessage & {
  status: string; summary: string; task_id: string;
  error?: string; output_file?: string; task_type?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  tool_use_id?: string; skip_transcript?: boolean;
};

// 新增处理逻辑：
// 1. 根据 task_type 分发不同 UI 组件
//    - local_bash → 终端输出组件
//    - local_agent → subagent 状态卡片
//    - local_workflow → 工作流进度面板
// 2. 用 output_file 读取后台任务完整输出（用 Read 工具）
// 3. status=failed 时展示 error 字段
// 4. status=completed 且含 usage 时展示 token 消耗
```

### `run_in_background` 参数传递规则

| 场景 | LLM 是否传递 | 值 |
|------|-------------|-----|
| Bash 前台 | 不传递（默认） | undefined |
| Bash 后台 | ✅ | `true` |
| Agent 前台 | ✅（显式） | `false` |
| Agent 后台（默认） | 不传递 | undefined |
| Workflow | 不适用 | — |

### task_type 完整映射

| task_type | 来源工具 |
|-----------|---------|
| `local_bash` | Bash, PowerShell |
| `local_agent` | Agent（subagent） |
| `local_workflow` | Workflow |
| `shell` | ❌ 未观察到（SDK 类型定义中写了，但实际未使用） |
| `monitor` | 未验证 |

---

## backgroundTasks() 前台转后台专项实验（case-12 / case-13）

> 调研人：Claude Code
> 日期：2026-07-23
> 环境：SDK `@anthropic-ai/claude-agent-sdk` + 本地 LLM（Jereh litellm 网关 / `Jereh-Kimi-K2.6`），`permissionMode: bypassPermissions`，`settingSources: []`，`effort: low`
> 目的：验证文档原来标注的最大未验证项 —— 「query 运行期间调用 `backgroundTasks(toolUseId)` 把前台阻塞中的工具调用转为后台，其实际效果」。

### 实验设计（控制变量）

| Case | 命令 | 是否调用 `backgroundTasks()` | 观察目标 |
|------|------|----------------------------|---------|
| 12（基线） | `sleep 40 && echo bg-conversion-done`（LLM 明确 `run_in_background:false`） | **否** | 长前台 Bash 是否产生 task 事件、是否阻塞 |
| 13（核心） | 同上 | **是**（拿到 toolUseId 后立即调用） | 调用返回值、是否改变事件序列/阻塞行为 |

两组除「是否调用 backgroundTasks」外，prompt / env / options 完全一致。

### 核心发现

| # | 发现 | 证据 |
|---|------|------|
| 13 | **长前台 Bash 被 SDK 自动后台化，与是否调用 `backgroundTasks()` 无关** | case-12（不调用）与 case-13（调用）产生**完全相同**的事件序列：`task_started`(local_bash) → `task_notification`(completed) |
| 14 | **`backgroundTasks(toolUseId)` 在本环境下始终返回 `false`** | case-13 两轮：t+27.7s 调用 → false；t+46s 调用 → false |
| 15 | **自动后台化不改变阻塞语义** | 即便出现 task_started/notification，query 仍阻塞到命令跑完（case-12/13 总耗时均 ≈ sleep 时长 + 两轮 LLM 开销，88–103s） |
| 16 | **自动后台化的 tool_result 不含 `backgroundTaskId`** | case-12/13 的 user tool_result 均未提取到 backgroundTaskId；与 case-2（LLM 主动 `run_in_background:true`）的 tool_result 结构不同 |
| 17 | **`content_block_start` 事件不含 tool_use 身份信息** | stream_event `content_block_start` 时 `toolName`/`toolUseId` 均为空；最早只能在 `assistant` 消息（完整 content）到达时才拿到 toolUseId |
| 18 | **自动后台化的触发点**：Bash 任务开始执行后约 5s | 时间线：`assistant [Bash]`（t+44s）→ `task_started`（t+50s），间隔稳定 ~5s；两轮一致 |

### 关键时间线（case-13 第二轮，sleep 40）

```
[idx=0] t+     0ms  system init
[idx=1] t+     0ms  system status
[idx=2] t+  7034ms  stream_event message_start
[idx=3] t+  7036ms  stream_event content_block_start   ← tool_use 块开始，但无工具名/id
[idx=4] t+ 44635ms  assistant [Bash] id=functions.Bash:0  ← 37s 后才拿到 toolUseId
[idx=5] t+ 50155ms  system task_started  task_id=btl7wv7ij  ← SDK 自动后台化（任务执行 ~5s 后）
[idx=6] t+ 87370ms  system task_notification  status=completed
[idx=7] t+ 87378ms  user tool_result                ← 无 backgroundTaskId
...
[idx=15] result num_turns=2                          ← query 阻塞到任务结束
```

`backgroundTasks()` 在 idx=4 拿到 toolUseId 后立即调用（t+46s），返回 `false` —— 此时任务已被自动后台化（idx=5 在 t+50s，但 SDK 内部可能在更早就标记为后台），无可转换的"前台任务"。

### `backgroundTasks()` 返回 false 的原因推断

SDK 注释（`sdk.d.ts:2496`）说返回 `false` 仅当「给了 toolUseId 但没匹配到前台任务」。结合 case-12/13 的对照：

1. **长前台 Bash 一旦执行超过阈值（~5s），就被 SDK 内部转为后台任务**（产生 task_started）。
2. 转后台后，该任务在 `backgroundTasks()` 的视角里**不再是"前台任务"**，故匹配不到。
3. 因此在本环境下，`backgroundTasks()` 对长任务**几乎总是返回 false** —— 等你能拿到 toolUseId 时（assistant 消息，往往已数秒~数十秒后），任务早已被自动后台化。

> ⚠️ 这并不意味着 `backgroundTasks()` 无用。它的设计语义对应 TUI 的 Ctrl+B：在任务**仍处于前台阻塞**时主动转后台。但 SDK 的"长任务自动后台化"机制抢在了前面，使本环境下手动调用窗口极窄/不存在。

### 与既有发现的关系

- **case-2（LLM 主动 `run_in_background:true`）**：task_started 立即出现，tool_result **含** `backgroundTaskId`，query **不阻塞**。
- **case-12/13（LLM `run_in_background:false`，长命令）**：task_started 延迟 ~5s 出现（自动后台化），tool_result **不含** `backgroundTaskId`，query **仍阻塞**。
- **case-1（短命令 echo）**：命令瞬时完成，来不及触发自动后台化，无 task 事件。

三者说明：**"是否产生 task 事件" ≠ "是否后台执行（非阻塞）"**。自动后台化产生了 task 事件，但保留了阻塞语义；只有 LLM 主动 `run_in_background:true`（或成功的 `backgroundTasks()` 调用）才会产生 backgroundTaskId 并解除阻塞。

### 对调用方（CodePilot）的实际影响

1. **不能依赖 `backgroundTasks()` 在长任务上生效** —— 本环境下它返回 false。若产品需要"长命令转后台不阻塞"，应让 LLM 直接传 `run_in_background:true`（即 case-2 路径），而非靠 SDK 控制方法。
2. **task_notification.output_file 在自动后台化场景下为空字符串** —— case-12/13 的 notification `output_file:""`。自动后台化的输出**不写** `.output` 文件，只能从 tool_result 的 stdout 拿（而 tool_result 又不含 backgroundTaskId）。这意味着：自动后台化的长任务，其输出**只在 query 结束时通过 tool_result.stdout 一次性获得**，无法边跑边读。
3. **若需要"边跑边读实时输出"**，唯一可靠路径是 case-2（LLM 主动后台）—— 此时 output_file 有值，可 Read。

### 仍未完全确定的点

1. **自动后台化的精确阈值** —— 观察到 ~5s，但未做扫描实验确认是固定值还是可配置。
2. **`backgroundTasks()` 是否在「任务刚启动、自动后台化之前」的极窄窗口内能成功** —— 本环境下该窗口被 LLM 的 assistant 消息延迟（~44s）淹没，无法触达。需更快的 LLM 或 Anthropic 直连端点才能验证。
3. **自动后台化是否受 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 抑制** —— case-7 显示该变量不阻止 LLM 主动后台，但对"自动后台化"的影响未单独验证。

---

## 未验证行为

1. ~~**`backgroundTasks()` 方法**~~ — **已验证（case-12/13，2026-07-23）**：方法存在且可调用，但本环境下对长任务返回 false（见上节）。剩余不确定点：极窄窗口内是否可成功。
2. **Monitor 工具** — 需要 Anthropic 直连端点 + 遥测启用，本地环境不可用
3. **前台→后台→前台完整状态机** — 部分验证（自动后台化已确认，但"手动转后台成功"未观测到）
4. **task_progress 消息的完整结构** — 观察到有推送，但未解析完整字段
5. **`task_updated` 消息的用途** — 观察到出现，但未分析其结构
6. **SSE cases (9-11)** — NestJS 服务端 SSE 传输的 task 消息包装格式未验证
7. **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 的真实影响范围** — 需要更精确的控制变量实验
8. **长运行后台任务的 task_notification completed 状态** — case-2 因超时未等到 completed；case-12/13 已观测到 completed（但 output_file 为空）
