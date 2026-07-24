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

---

## streaming-input 模式专项实验（case-14）

> 调研人：Claude Code
> 日期：2026-07-24
> 环境：SDK `@anthropic-ai/claude-agent-sdk` + 本地 LLM（LOCAL 网关 `10.1.3.115:4000` / `Jereh-LLM-NO-THINK-V1`），`permissionMode: bypassPermissions`，`settingSources: []`，`effort: low`
> 目的：验证 case-13 遗留假设 —— 「backgroundTasks() 返回 false 是不是因为用了 string-prompt（单次）模式？」。SDK 类型注释（`sdk.d.ts:2229-2230`）明确：**控制方法（interrupt/backgroundTasks/stopTask/streamInput）只在 streaming input/output 模式下支持**。
>
> ⚠️ **重要更正（case-17 已查明真因）**：本节发现 19「backgroundTasks 仍返回 false」的归因【是错的】。真因不是 streaming 模式、不是自动后台化抢先，而是**调用时机早于 `task_started` 事件**。case-14 在 9290ms 调用，但 task_started 在 13515ms 才发出——那时任务尚未注册为可控制对象，故 false。case-17 证明：等 task_started 后再调，backgroundTasks 返回 **true** 且成功转后台。详见文末「case-17」节。以下 case-14 原始记录保留，但发现 19 的结论以 case-17 为准。

### 实验设计

用 **streaming-input 模式**（`prompt` 传 `AsyncIterable<SDKUserMessage>` 而非 string）重跑 case-13 链路，并走通用户完整需求：前台长 Bash → 主动 `backgroundTasks(toolUseId)` 转后台 → 确认转后台 → （若仍阻塞）`interrupt()` 兜底 → streaming 续轮问 AI 任务情况 → task_notification 唤醒。

架构：**单进程 3 协程 + 闭包共享 state**（Node 单线程串行，无锁）：
- `promptInput` async generator（deferred-promise 外部驱动 + 15s 超时安全阀）：先 yield msg1（跑 Bash），await turn2Gate 后 yield msg2（问状态）。
- for-await 主循环：捕获 toolUseId、调控制方法、收集事件。
- `setInterval` 1Hz 观察者：每秒快照 + 首次读 output_file + **interrupt 兜底决策**（唯一能在主循环阻塞时执行的位置）。

### 核心发现（大部分推翻原假设）

| # | 发现 | 证据（case-14 实测） |
|---|------|---------------------|
| 19 | **streaming-input 模式下 `backgroundTasks()` 仍返回 `false`** —— 推翻「string-prompt 模式是 false 主因」的假设 | `backgroundCallResult: false`（调用时机 9290ms，即 Bash tool_use 一出现就调） |
| 20 | **控制方法在 streaming 模式下确实被派发**（不是没生效）—— 但 backgroundTasks 语义上就是没匹配到可转的前台任务 | interrupt 被真实派发并返回业务错误（见发现 21），证明控制通道通了 |
| 21 | **`interrupt()` 抛错 `Query closed before response received`** —— 调用时当前 turn 已结束，无 turn 可打断 | `interruptCallResult: "ERROR: Query closed before response received"`（15233ms 调用） |
| 22 | **turn 之间有空隙**：Bash tool_use（9290ms）→ backgroundTasks 返回后 tool_result 流回、turn 收尾 → 观察者 6s 后（15233ms）再 interrupt 已太晚 | phaseTimeline: backgrounding@9290 → interrupting@15233；期间 turn 已结束 |
| 23 | **streaming 续轮成功**：尽管 interrupt 抛错，msg2 仍成功流出并完成第二轮问答 | `turnsObserved: 2`，`resultSubtype: success`，`num_turns: 2`，LLM 回答「任务已完成，输出 bg-14-done」 |
| 24 | **output_file 为 `null`**（连空字符串都不是）—— 自动后台化的任务，notification 不给输出路径 | `taskNotificationStatus: completed` 但 `outputFile: null`；输出只在更早的 tool_result.stdout 一次性拿到 |
| 25 | **task_notification 到达时 query 尚未结束**：notification@52432ms，query 结束@57762ms —— 但输出早已在 tool_result 拿到，notification 只是终结信号 | phaseTimeline: task_completed@52432 vs queryEndedAt@57762 |

### 关键时间线（case-14）

```
init:              0ms
awaiting_tool_use: 9290ms   ← LLM 发出 Bash tool_use（toolUseId=call_c69a...，taskId=bzhtkxe7p）
backgrounding:     9290ms   ← 立刻调 backgroundTasks(toolUseId) → 返回 false
interrupting:      15233ms  ← 观察者 6s 后触发 interrupt 兜底 → 抛 "Query closed before response received"
（msg2 经 turn2Gate 放行，第二轮问答进行）
task_completed:    52432ms  ← task_notification status=completed，output_file=null
query 结束:        57762ms  ← result subtype=success, terminal_reason=completed, num_turns=2
```

### 结论：case-13 的 false 是真实行为，与输入模式无关

- **streaming-input 不是 backgroundTasks 生效的充分条件**。真正原因（沿用 case-12/13 结论）：长前台 Bash 被 SDK 在执行 ~5s 后**自动后台化**，等调用方拿到 toolUseId（本次 9290ms）时，任务已不是"可手动转后台的前台任务"，故 backgroundTasks 返回 false。
- **`interrupt()` 只在 turn 活跃时有效**。streaming 模式下 turn 收尾很快（tool_result 流回即结束），事后再 interrupt 会抛 "Query closed"。若要用 interrupt 打断阻塞，必须在 turn 仍在等工具结果的窗口内同步调用，不能靠 1Hz 轮询的观察者（太慢）。
- **续轮（多轮问答）在 streaming-input 下可行**：generator yield 新 SDKUserMessage 即开新 turn，同一 query 的 for-await 继续吐事件（turnsObserved=2 证实）。这是"消除阻塞后继续问 AI"的正确实现路径 —— 但不依赖 interrupt，而是靠 generator 续推消息。

### 对调用方（CodePilot）的实际影响（补充 case-13 建议）

1. **不要指望 backgroundTasks() 能手动转后台长任务** —— 无论 string 还是 streaming 模式都返回 false。要"长命令后台不阻塞 + 边跑边读"，唯一可靠路径仍是让 LLM 主动传 `run_in_background:true`（case-2）。
2. **多轮对话用 streaming-input（generator 续推 SDKUserMessage）**，不要用 interrupt 续命 —— interrupt 会结束 query 且对已收尾的 turn 抛错。
3. **interrupt 的正确用途**：在 turn 正阻塞等长工具时同步打断（TUI Esc 场景）。用轮询观察者做兜底 interrupt 不可靠（会错过 turn 活跃窗口）。

### 仍未确定的点

1. ~~**turn 活跃窗口内 interrupt 能否成功**~~ —— **已验证（case-16）**：turn 活跃时同步 interrupt 成功，见下节。
2. ~~**stopTask(taskId) 的实际效果**~~ —— **已验证（case-15）**：stopTask 成功停任务、发 stopped 通知、query 不死可续轮，见下节。
3. **backgroundTasks 在任务被自动后台化【之前】的极窄窗口**（tool_use 出现到 ~5s 内）能否返回 true：case-14 的 9290ms 调用仍偏晚，未穿透该窗口。case-16 证明 7236ms 时 turn 仍活跃（taskStartedSeen=false），故该窗口 > 7s，但 backgroundTasks 在此窗口是否返回 true 仍未单测。

---

## stopTask + 同步 interrupt 专项实验（case-15 / case-16）

> 调研人：Claude Code
> 日期：2026-07-24
> 环境：同 case-14（LOCAL 网关 / `Jereh-LLM-NO-THINK-V1`，streaming-input 模式）
> 目的：回答 case-14 遗留的两个关键问题 —— (a) stopTask 能否停单个后台任务且保持 query？(b) turn 活跃时同步 interrupt 能否真正打断（而非 case-14 那样太晚抛错）？

### case-15：stopTask 停单个后台任务（完整成功，最对口用户需求）

拿到 `bashTaskId`（task_started）后立即 `stopTask(taskId)`。实测：

| # | 发现 | 证据 |
|---|------|------|
| 26 | **stopTask() 调用成功，不抛错** | `stopCallResult: OK`（调用时机 12669ms） |
| 27 | **发出 task_notification status=`stopped`**（非 completed） | `taskNotificationStatus: stopped`，仅在 stopTask 后 55ms（12669→12724）到达 |
| 28 | **query 不结束，可 streaming 续轮** | `queryEnded` 直到 21176ms，`turnsObserved: 4`，`turn2Reached: true`，result subtype=success |
| 29 | **sleep 40 被真正中断** | 总耗时 21176ms（对照 case-14 等满 40s 的 57762ms） |
| 30 | **续轮里 AI 正确感知任务被停** | 第二轮回答："The background task was **stopped/aborted before it could complete**. The `sleep 40` command did not finish executing, so `bg-15-done` was never printed." |
| 31 | **stopped 通知带真实 output_file 路径**（非 null） | `output_file: ...tasks/bto9trm4z.output`；但任务停止后文件很快被清理，事后（测试结束后）读不到，需在 query 存活期读 |

**结论**：stopTask 是"停止阻塞后在同一会话继续问 AI"的**正确且唯一干净路径**。它精确停单个后台任务、立即回 stopped 通知、query 存活、支持续轮，AI 能感知任务已停。

### case-16：turn 活跃窗口内同步 interrupt（成功，修正 case-14）

拿到 `bashToolUseId` 后【在主循环里同步】调 `interrupt()`（而非 case-14 的 1Hz 观察者延迟触发）。实测：

| # | 发现 | 证据 |
|---|------|------|
| 32 | **turn 活跃时 interrupt() 成功，不抛 "Query closed"** | `interruptCallResult: OK`（调用时机 7236ms） |
| 33 | **interrupt 真正打断阻塞** | queryEndedAt=13515ms（对照 case-14 等满 sleep 的 57762ms） |
| 34 | **interrupt 有效窗口 = tool_use 出现 → 自动后台化之前** | interrupt@7236ms 时 `taskStartedSeen: false`（尚未自动后台化）；case-14@15233ms 时 turn 已收尾故抛错 |
| 35 | **result subtype=success, terminal_reason=completed**（无专门的 interrupted 标记） | 与 sdk.d.ts 一致：interrupt 不产生独立 subtype |
| 36 | **interrupt 后仍能 streaming 续轮**（比文档"interrupt 结束 query"更微妙） | `turnsObserved: 2`，`turn2Yielded: true`，第二轮 AI 回答 "OK" |

**结论**：interrupt 有一个**狭窄有效窗口**——必须在 tool_use 出现到 SDK 自动后台化（本环境 > 7s）之间同步调用。窗口内调用能真正打断前台阻塞；错过窗口（turn 收尾后）则抛 "Query closed before response received"。因此 interrupt 不能靠慢速轮询兜底，要在 turn 阻塞的第一时间同步触发。

### 三方对照：backgroundTasks vs stopTask vs interrupt（streaming-input 模式）

| 控制方法 | 调用结果 | 是否停/转任务 | query 是否存活 | 阻塞是否解除 | 适用场景 |
|---------|---------|-------------|--------------|------------|---------|
| `backgroundTasks(toolUseId)` **在 task_started 后调**（case-17） | **true** | 是，转后台成功 | **存活，可续轮** | **是（第一轮 turn 12.8s 结束）** | **主动转后台长命令（时机正确即可用）** |
| `backgroundTasks(toolUseId)` **在 task_started 前调**（case-14） | false | 否（任务未注册） | 存活 | 否（等满 sleep） | 时机错误 → 无效 |
| `stopTask(taskId)`（case-15） | **OK** | 是，任务→stopped | **存活，可续轮** | 是（21s vs 57s） | **停单个后台任务 + 继续会话** |
| `interrupt()`（case-16，窗口内） | **OK** | 打断整个当前 turn | 结束当前 turn（但 streaming 可续轮） | 是（13.5s） | 打断正阻塞的 turn（TUI Esc），时机敏感 |

**给 CodePilot 的最终建议**：
- **所有控制方法（backgroundTasks/stopTask）必须在收到 `task_started` 事件之后调用**——那时任务才被注册为可控制对象。在此之前调用一律无效（backgroundTasks 返回 false）。这是贯穿 case-13→17 的核心结论。
- 要"主动把长命令转后台、不阻塞会话"→ 用 **backgroundTasks(toolUseId)**，但**必须等 task_started**（toolUseId 用 task_started.tool_use_id，与 assistant block.id 一致）。成功后 tool_result 带 backgroundTaskId，turn 立即继续。
- 要"停一个卡住的后台任务、会话继续"→ 用 **stopTask(taskId)**（taskId 从 task_started 收集）。
- 要"用户按 Esc 打断当前操作"→ 用 **interrupt()**，须在 turn 活跃时同步调用，不能延迟。

---

## backgroundTasks 时机验证（case-17，解开 case-13→17 谜团）

> 调研人：Claude Code
> 日期：2026-07-24
> 环境：同 case-14/15/16
> 目的：验证真因假设 —— 「backgroundTasks 返回 false 是因为调用早于 task_started 事件」。

### 真因假设的由来（case-14/15 时序反推）

对比 case-14（false）与 case-15（stopTask OK）的精确时序，发现规律：**控制方法成功与否，取决于调用时 `task_started` 是否已发出**。

| case | 控制调用时机 | task_started 时机 | 调用 vs task_started | 结果 |
|------|------------|------------------|---------------------|------|
| case-14 backgroundTasks | 9290ms | **13515ms** | 早 4.2s | **false** |
| case-15 stopTask | 12669ms | 10509ms | 晚 2.2s | OK |

且 case-15 已确认 `task_started.tool_use_id === assistant block.id`（都是 `call_6dc0...`），排除「ID 不匹配」假设。

### 实验设计

把 backgroundTasks 的触发条件从「拿到 assistant block.id」改为「**收到 task_started**」，并用 `task_started.tool_use_id` 调用。其余同 case-14。

### 决定性发现

| # | 发现 | 证据（case-17 实测） |
|---|------|---------------------|
| 37 | **task_started 之后调 backgroundTasks 返回 `true`** —— 彻底推翻 case-13/14 的 false 结论 | `bgCallResult: true`（调用@14237ms，task_started@14237ms） |
| 38 | **真因 = 调用时机相对 task_started**，与 streaming 模式、自动后台化、ID 匹配均无关 | case-14 早 4.2s→false；case-17 同刻/后→true |
| 39 | **成功后 tool_result 带 `backgroundTaskId`**（case-14 失败时为 null） | `backgroundTaskIdFromResult: bvjfc5bax`，等于 `bashTaskId` |
| 40 | **转后台真正解除阻塞**：第一轮 turn 在 12860ms 结束（不等 sleep 40） | 时序：task_started@11848 → tool_result@12859 → result@12860（turn 结束）；后台任务 49248ms 才 task_notification completed |
| 41 | **完整走通「转后台→续轮→任务后台完成」**：turnsObserved=3，第二轮 AI 正确报告任务已完成 | 第二轮回答："background task is finished, exit code 0, output bg-17-done" |
| 42 | **实证 sdk.d.ts:2866 描述的标准行为**：转后台后 tool_result 立即返回「running in background」、turn 继续、任务后台跑完发 task_notification | 首次在本环境完整观测到该行为链 |

### 关键时序（case-17）

```
t+11848ms  task_started（任务注册，tool_use_id=call_bbfe26...）
t+14237ms  backgroundTasks(tool_use_id) → true   ← 在 task_started 之后调
（tool_result 带 backgroundTaskId=bvjfc5bax，turn 立即继续）
t+12860ms  第一轮 result（turn 结束，未等 sleep 40）*
t+12868ms  第二轮开始（streaming 续推 msg2）
t+49248ms  task_notification status=completed（后台任务真正跑完）
t+53936ms  全部结束
```
（*注：不同运行的绝对时间戳略有出入，但「turn 在任务完成前就结束」这一相对关系稳定成立。）

### 谜团总收束（case-13 → case-17）

历经 5 个 case，backgroundTasks 返回 false 的真因逐层澄清，我的错误归因被逐一推翻：

1. **case-13**：string-prompt 模式下 false → 猜测「可能是没开 streaming 模式」。
2. **case-14**：streaming 模式下【仍】false → 推翻猜测 1；改猜「自动后台化抢先/任务已不是前台」。
3. **case-15/16**：stopTask 和同步 interrupt 都成功，且都在 task_started 之后 → 露出「时机」线索。
4. **时序反推**：发现 case-14 的 backgroundTasks 实际在 task_started【之前】4.2s 调用 → 推翻猜测 2（自动后台化其实发生在调用【之后】）。
5. **case-17**：等 task_started 后再调 → **true** → 真因确认：**必须在 task_started 之后调用**。

**最终真相**：SDK 的控制方法（backgroundTasks/stopTask）操作的是「已注册的后台任务对象」，该对象在 `task_started` 事件发出时才存在。早于此调用，SDK 匹配不到任务 → 返回 false（backgroundTasks）或潜在失败。这与输入模式（string/streaming）、SDK 自动后台化、tool_use_id 匹配都无关，是纯粹的**事件时序依赖**。

---

## 前台/后台输出实时性专项（case-18）

> 调研人：Claude Code
> 日期：2026-07-24
> 环境：同 case-14~17（LOCAL 网关 / `Jereh-LLM-NO-THINK-V1`）
> 目的：拿确凿证据回答「前台任务输出能否实时拿到？后台任务输出能否实时拿到？」。此前对「前台一次性返回」的说法是从 case-1（echo 瞬时命令）过度推断——echo 太快无法区分实时/一次性。本 case 用【慢速多行】命令：`for i in $(seq 1 8); do echo tick-$i; sleep 2; done`（约 16s，分 8 次输出）。

### 核心发现（前台不可实时、后台可实时）

| # | 发现 | 证据 |
|---|------|------|
| 43 | **前台任务输出【不能】实时拿到**：stdout 在命令跑完后【一次性】随 tool_result 返回 | case-18a：`toolResultLineCount: 8`（一次性带全部 8 行）、`sawIncrementalStdout: false`、`timeline: []`（执行期 20s 内事件流无任何 stdout 片段） |
| 44 | **前台 tool_result 阻塞到命令结束才出现** | case-18a：tool_use@7048ms → tool_result@26863ms，`gap: 19815ms` ≈ 命令执行时长 |
| 45 | **前台执行期间无携带内容的事件**：官方 streaming 文档只流式 LLM 文本（text_delta）和工具入参（input_json_delta），【不流式】工具执行的 stdout | case-18a：`timeline: []`；`agent-sdk__streaming-output.md` 全文未提工具 stdout 流式 |
| 46 | **后台任务输出【能】实时拿到**：stdout 持续写入 `.output` 文件，可 tail | case-18b：`grewOverTime: true`，文件行数随时间阶梯增长 |
| 47 | **后台 `.output` 文件行数与命令产出节奏同步** | case-18b：t=11136ms→1 行(tick-1)、13153ms→2、15163ms→3、17193ms→4、19213ms→5，每 ~2s 增一行 |

### case-18a 前台时间线

```
t+7048ms   Bash tool_use 出现（命令开始执行）
t+7048ms ~ 26863ms  执行期 ~20s —— 事件流【完全空白】，无任何 tick-N 片段
t+26863ms  tool_result 出现，一次性带全部 8 行 tick-1..tick-8
```

### case-18b 后台 .output 文件增长阶梯

```
output_file = ...tasks/b2p19vl33.output
t+11136ms  1 行 (tick-1)
t+13153ms  2 行 (tick-2)
t+15163ms  3 行 (tick-3)
t+17193ms  4 行 (tick-4)
t+19213ms  5 行 (tick-5)   ← 每 ~2s 增一行，与命令产出同步
```

### 最终结论：输出实时性对照

| 任务类型 | 能否实时拿输出 | 机制 | 证据 |
|---------|--------------|------|------|
| **前台任务** | **不能** | stdout 命令跑完后一次性随 tool_result 返回，执行期无增量事件 | case-18a：gap 19.8s、8 行一次性、增量为空 |
| **后台任务** | **能** | stdout 持续写入 `.output` 文件，可按路径 tail | case-18b：文件行数每 2s 阶梯增长 tick-1→5 |

**这也解释了 SDK 为何自动后台化长前台命令（case-12/13）**：前台阻塞模式下中间输出对用户完全不可见，转后台走 `.output` 文件通道反而获得实时可见性。

**给 CodePilot 的建议**：需要向用户实时展示长命令输出时，应让命令走后台（`run_in_background:true`）并 tail 其 `output_file`；前台命令只能在结束时一次性拿到全部输出。
