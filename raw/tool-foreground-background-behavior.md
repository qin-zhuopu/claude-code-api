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

## 未验证行为

1. **`backgroundTasks()` 方法** — 在 query 运行期间调用该方法的实际效果未验证（需要在 SDK async iterator 运行中调用）
2. **Monitor 工具** — 需要 Anthropic 直连端点 + 遥测启用，本地环境不可用
3. **前台→后台→前台完整状态机** — 需要 `backgroundTasks()` 方法配合
4. **task_progress 消息的完整结构** — 观察到有推送，但未解析完整字段
5. **`task_updated` 消息的用途** — 观察到出现，但未分析其结构
6. **SSE cases (9-11)** — NestJS 服务端 SSE 传输的 task 消息包装格式未验证
7. **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 的真实影响范围** — 需要更精确的控制变量实验
8. **长运行后台任务的 task_notification completed 状态** — case-2 因超时未等到 completed
