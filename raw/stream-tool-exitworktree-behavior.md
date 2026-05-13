# ExitWorktree 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-exitworktree.spec.ts`
**测试用例数**: 6（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **input_schema 字段** | `action`（必填，"keep" 或 "remove"），`discard_changes`（可选，boolean） |
| **tool_result 成功结构** | `tool_use_result`: `{action, originalCwd, worktreePath, worktreeBranch?, discardedFiles?, discardedCommits?, message}` 结构化对象 |
| **tool_result 失败结构** | `tool_use_result`: `"Error: ..."` 纯错误字符串 |
| **stream_event 总数** | Case 1（keep）: 302；Case 2（remove，含重试）: 346；Case 3（no-op）: 110 |
| **input_json_delta 推送次数** | **4 次**（action only: `""` → `"{"` → `"\"action\": \"keep\""` → `"}"`）；**5 次**（含 discard_changes: `""` → `"{"` → `"\"action\": \"remove\""` → `", \"discard_changes\": true"` → `"}"`） |
| **tool_progress 推送次数** | **0 次** — ExitWorktree 是瞬时工具 |
| **tool_use_summary 推送次数** | **0 次** |
| **num_turns** | 3（enter → exit → reply），4（enter → exit 失败 → exit 重试 → reply） |
| **是否需要不断修改前端状态** | **不需要** — ExitWorktree 是瞬时工具，无持续进度 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK 类型定义 sdk-tools.d.ts）

```typescript
export interface ExitWorktreeInput {
  /**
   * "keep" leaves the worktree and branch on disk; "remove" deletes both.
   */
  action: "keep" | "remove";
  /**
   * Required true when action is "remove" and the worktree has uncommitted files
   * or unmerged commits. The tool will refuse and list them otherwise.
   */
  discard_changes?: boolean;
}
```

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**keep 场景（Case 1）**:
```json
{
  "action": "keep"
}
```

**remove 场景（Case 2，第一次尝试）**:
```json
{
  "action": "remove"
}
```

**remove + discard_changes 场景（Case 2，重试）**:
```json
{
  "action": "remove",
  "discard_changes": true
}
```

---

## 二、tool_result 返回值格式

### 2.1 成功场景 — action="keep"（Case 1）

**SDK `tool_use_result` 字段**（结构化对象）:
```json
{
  "action": "keep",
  "originalCwd": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api",
  "worktreePath": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api\\.claude\\worktrees\\exit-test-keep",
  "worktreeBranch": "worktree-exit-test-keep",
  "message": "Exited worktree. Your work is preserved at C:\\...\\.claude\\worktrees\\exit-test-keep on branch worktree-exit-test-keep. Session is now back in C:\\...\\claude-code-api."
}
```

> **注意**：action="keep" 时，`discardedFiles` 和 `discardedCommits` 字段**不存在**。

### 2.2 成功场景 — action="remove"（Case 2，第二次尝试）

**SDK `tool_use_result` 字段**（结构化对象）:
```json
{
  "action": "remove",
  "originalCwd": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api",
  "worktreePath": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api\\.claude\\worktrees\\exit-test-remove",
  "worktreeBranch": "worktree-exit-test-remove",
  "discardedFiles": 0,
  "discardedCommits": 0,
  "message": "Exited and removed worktree at C:\\...\\.claude\\worktrees\\exit-test-remove. Session is now back in C:\\...\\claude-code-api."
}
```

> **注意**：action="remove" 时，`discardedFiles` 和 `discardedCommits` 字段**存在**（即使为 0）。

### 2.3 失败场景 — remove 未设置 discard_changes（Case 2，第一次尝试）

**SDK `tool_use_result` 字段**（错误字符串）:
```
"Error: Could not verify worktree state at C:\\...\\.claude\\worktrees\\exit-test-remove. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: \"keep\" to preserve the worktree."
```

### 2.4 失败场景 — 不在 worktree 中调用（Case 3）

**SDK `tool_use_result` 字段**（错误字符串）:
```
"Error: No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made."
```

### 2.5 失败场景 — EnterWorktree 收到错误参数（Case 6）

**SDK `tool_use_result` 字段**（验证错误字符串）:
```
"InputValidationError: [
  {
    \"code\": \"unrecognized_keys\",
    \"keys\": [\"action\", \"discard_changes\"],
    \"path\": [],
    \"message\": \"Unrecognized keys: \\\"action\\\", \\\"discard_changes\\\"\"
  }
]"
```

> **发现**：LLM 有时混淆 EnterWorktree 和 ExitWorktree 的参数，将 ExitWorktree 的 `action` 和 `discard_changes` 传给了 EnterWorktree，导致 InputValidationError。

### 2.6 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | `"keep" \| "remove"` | 执行的操作类型 |
| `originalCwd` | `string` | 原始工作目录（回到的目录） |
| `worktreePath` | `string` | worktree 的绝对路径 |
| `worktreeBranch` | `string?` | worktree 的 git 分支名 |
| `tmuxSessionName` | `string?` | 如果有 tmux 会话关联则返回（实验中未出现） |
| `discardedFiles` | `number?` | 丢弃的未提交文件数（仅 action="remove"） |
| `discardedCommits` | `number?` | 丢弃的未合并提交数（仅 action="remove"） |
| `message` | `string` | 人类可读的退出结果描述 |

> **关键发现**：
> - 成功时 `tool_use_result` 是结构化对象（`ExitWorktreeOutput`）
> - 失败时是 `string`（以 `"Error: "` 或 `"InputValidationError: "` 开头）
> - `action="keep"` 时无 `discardedFiles`/`discardedCommits` 字段
> - `action="remove"` 时必有 `discardedFiles`/`discardedCommits` 字段（即使为 0）

---

## 三、流式事件序列

### 3.1 完整时间线（Case 1 成功场景，EnterWorktree → ExitWorktree(keep)，302 个事件）

```
[  0] system (init)                          ← 会话初始化
[  1] system (status)                        ← 状态更新 "requesting"
[  2] stream_event → message_start           ← 第 1 轮 API 调用开始
[  3] stream_event → content_block_start     ← thinking block 开始
[  4-8] stream_event → content_block_delta [thinking_delta] × 5
[  9] stream_event → content_block_stop      ← thinking block 结束
[ 10] stream_event → content_block_start     ← tool_use block 开始 [EnterWorktree]
[ 11] stream_event → content_block_delta [input_json_delta] ""
[ 12] stream_event → content_block_delta [input_json_delta] "{"
[ 13] stream_event → content_block_delta [input_json_delta] "\"name\": \"exit-test-keep\""
[ 14] stream_event → content_block_delta [input_json_delta] "}"
[ 15] assistant [tool_use: EnterWorktree]    ← 完整 tool_use block
[ 16] stream_event → content_block_stop      ← tool_use block 结束
[ 17] stream_event → message_delta           ← stop_reason: "tool_use"
[ 18] stream_event → message_stop            ← 消息结束
[ 19] user (tool_result)                     ← EnterWorktree 成功结果
[ 20] system (status)                        ← 状态更新 "requesting"
[ 21] stream_event → message_start           ← 第 2 轮 API 调用开始
[ 22] stream_event → content_block_start     ← thinking block
[ 23-40] stream_event → content_block_delta [thinking_delta] × 18
[ 41] stream_event → content_block_stop      ← thinking block 结束
[ 42] stream_event → content_block_start     ← tool_use block 开始 [ExitWorktree]
[ 43] stream_event → content_block_delta [input_json_delta] ""
[ 44] stream_event → content_block_delta [input_json_delta] "{"
[ 45] stream_event → content_block_delta [input_json_delta] "\"action\": \"keep\""
[ 46] stream_event → content_block_delta [input_json_delta] "}"
[ 47] assistant [tool_use: ExitWorktree]     ← 完整 tool_use block
[ 48] stream_event → content_block_stop      ← tool_use block 结束
[ 49] stream_event → message_delta           ← stop_reason: "tool_use"
[ 50] stream_event → message_stop            ← 消息结束
[ 51] user (tool_result)                     ← ExitWorktree 成功结果
[ 52] system (status)                        ← 状态更新 "requesting"
[ 53] stream_event → message_start           ← 第 3 轮 API 调用开始
[ 54-297] stream_event → content_block_delta [text_delta] × ~244  ← 文本流式输出
[ 53-297] assistant [text]                   ← 完整回复 block
[ 298-301] stream_event → content_block_stop / message_delta / message_stop
[ 302] result (success)                      ← 最终结果（num_turns: 3）
```

### 3.2 Case 2 多轮交互（EnterWorktree → ExitWorktree(remove 失败) → ExitWorktree(remove 成功)，346 个事件）

```
Turn 1: EnterWorktree → 成功
Turn 2: ExitWorktree(remove) → 失败（未设置 discard_changes）
Turn 3: ExitWorktree(remove, discard_changes: true) → 成功
Turn 4: 最终文本回复
```

num_turns: **4**（比正常多 1 轮，因为 remove 第一次被拒绝）

### 3.3 各阶段事件数量统计

| Case | 总事件 | stream_event | assistant | user | result | system | tool_progress |
|------|--------|-------------|-----------|------|--------|--------|--------------|
| 1 (keep) | 302 | 292 | 5 | 2 | 1 | 4 | 0 |
| 2 (remove, 含重试) | 346 | 333 | 7 | 3 | 1 | 5 | 0 |
| 3 (no-op) | 110 | 102 | 3 | 1 | 1 | 3 | 0 |
| 4 (baseline) | ~11 | ~8 | 1 | 0 | 1 | 2 | 0 |
| 5 (SSE, keep) | ~263 | 251 | 4 | 2 | 1 | 4 | 0 |
| 6 (no partial) | 13 | 0 | 7 | 3 | 1 | 1 | 0 |

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**实验数据**：Case 1/2/3/4/5/6 均为 **0 次 tool_progress 事件**。

**原因**：ExitWorktree 是瞬时工具（执行 git worktree remove 或恢复 CWD），耗时极短（<500ms），SDK 不会为瞬时工具推送 tool_progress。

### 4.2 SDK 推送频率统计

| 事件类型 | 推送次数 | 推送时机 |
|---------|---------|---------|
| system(init) | 1 | 会话开始 |
| system(status) | 2-5 | 每轮 API 调用前 |
| stream_event (text_delta) | 244-291 | 最终文本回复期间 |
| stream_event (input_json_delta) | 4-5 | ExitWorktree 参数构建期间 |
| stream_event (控制事件) | 15-25 | message/block 生命周期 |
| assistant | 3-7 | 每个 content block 完成时 |
| user | 1-3 | 工具执行结果回传 |
| tool_progress | 0 | — |
| tool_use_summary | 0 | — |
| result | 1 | 会话结束 |

### 4.3 是否需要不断修改前端状态？

**不需要**。ExitWorktree 是瞬时工具：
- **工具执行阶段**：只有 4-5 次 `input_json_delta`，拼接完即完成，无持续进度
- **无 tool_progress**：不像 Bash 等长耗时工具那样推送执行进度
- **前端只需 2 次状态更新**：① 收到 tool_use → 显示"退出 worktree 中"；② 收到 tool_result → 显示结果
- **多轮重试场景**：如果 remove 被拒绝（需要 discard_changes），SDK 会在 user 消息中返回错误，LLM 自动重试。前端只需正常处理每个 user 消息即可。

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
/** ExitWorktree 工具的 input */
interface ExitWorktreeInput {
  action: 'keep' | 'remove';
  discard_changes?: boolean;
}

/** ExitWorktree 成功时的 tool_use_result */
interface ExitWorktreeSuccessResult {
  action: 'keep' | 'remove';
  originalCwd: string;
  worktreePath: string;
  worktreeBranch?: string;
  tmuxSessionName?: string;
  /** 仅 action="remove" 时存在 */
  discardedFiles?: number;
  /** 仅 action="remove" 时存在 */
  discardedCommits?: number;
  message: string;
}

/** ExitWorktree 失败时的 tool_use_result */
type ExitWorktreeErrorResult = string;  // "Error: ..." 或 "InputValidationError: ..."

/** ExitWorktree 的 tool_use_result 联合类型 */
type ExitWorktreeResult = ExitWorktreeSuccessResult | ExitWorktreeErrorResult;

/** 前端组件的完整数据模型 */
interface ExitWorktreeBlock {
  type: 'tool_use';
  toolName: 'ExitWorktree';
  toolUseId: string;
  toolInput: ExitWorktreeInput;
  toolStatus: 'calling' | 'success' | 'error';
  toolResult?: ExitWorktreeResult;
}
```

### 5.2 状态机设计

```
calling ──→ success  （tool_use_result 是对象，包含 action + originalCwd）
    │
    └──→ error    （tool_use_result 是字符串，以 "Error:" 或 "InputValidationError:" 开头）
```

判断成功/失败的逻辑：
```typescript
function parseExitWorktreeResult(result: ExitWorktreeResult): {
  success: boolean;
  data?: ExitWorktreeSuccessResult;
  error?: string;
} {
  if (typeof result === 'string') {
    // 失败：错误字符串
    return {
      success: false,
      error: result.startsWith('Error: ') ? result.slice(7) : result,
    };
  }
  // 成功：结构化对象
  return { success: true, data: result };
}
```

### 5.3 组件模板

```vue
<template>
  <el-card class="exit-worktree-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="input.action === 'remove' ? 'danger' : 'primary'">
          <el-icon>
            <FolderRemove v-if="input.action === 'remove'" />
            <FolderChecked v-else />
          </el-icon>
          ExitWorktree ({{ input.action }})
        </el-tag>
        <el-tag v-if="status === 'calling'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          退出 worktree...
        </el-tag>
        <el-tag v-else-if="status === 'success'" type="success">
          <el-icon><Check /></el-icon>
          已退出
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger">
          <el-icon><Close /></el-icon>
          失败
        </el-tag>
      </div>
    </template>

    <!-- 工具参数 -->
    <el-descriptions :column="1" border size="small">
      <el-descriptions-item label="操作">
        <el-tag :type="input.action === 'remove' ? 'danger' : 'success'" size="small">
          {{ input.action === 'remove' ? '删除 worktree' : '保留 worktree' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item v-if="input.discard_changes" label="丢弃更改">
        <el-tag type="warning" size="small">是</el-tag>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 成功结果 -->
    <template v-if="parsedResult?.success && parsedResult.data">
      <el-divider />
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="返回目录">
          <code class="path-text">{{ parsedResult.data.originalCwd }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="Worktree 路径">
          <code class="path-text">{{ parsedResult.data.worktreePath }}</code>
        </el-descriptions-item>
        <el-descriptions-item v-if="parsedResult.data.worktreeBranch" label="分支">
          <el-tag type="info" size="small">{{ parsedResult.data.worktreeBranch }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="parsedResult.data.discardedFiles !== undefined" label="丢弃文件">
          <el-tag :type="parsedResult.data.discardedFiles > 0 ? 'danger' : 'success'" size="small">
            {{ parsedResult.data.discardedFiles }} 个
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="parsedResult.data.discardedCommits !== undefined" label="丢弃提交">
          <el-tag :type="parsedResult.data.discardedCommits > 0 ? 'danger' : 'success'" size="small">
            {{ parsedResult.data.discardedCommits }} 个
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </template>

    <!-- 失败结果 -->
    <template v-if="parsedResult && !parsedResult.success">
      <el-divider />
      <el-alert
        :title="parsedResult.error"
        type="error"
        :closable="false"
        show-icon
      />
      <!-- 如果是 discard_changes 错误，提示用户 -->
      <el-alert
        v-if="parsedResult.error?.includes('discard_changes')"
        title="提示：需要在请求中设置 discard_changes: true 来确认删除"
        type="warning"
        :closable="false"
        show-icon
        style="margin-top: 8px"
      />
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { FolderRemove, FolderChecked, Loading, Check, Close } from '@element-plus/icons-vue';

const props = defineProps<{
  input: ExitWorktreeInput;
  status: 'calling' | 'success' | 'error';
  result?: ExitWorktreeResult;
}>();

const statusClass = computed(() => `status-${props.status}`);

const parsedResult = computed(() => {
  if (!props.result) return null;
  if (typeof props.result === 'string') {
    return {
      success: false,
      error: props.result.startsWith('Error: ')
        ? props.result.slice(7)
        : props.result,
    };
  }
  return { success: true, data: props.result };
});
</script>

<style scoped>
.exit-worktree-card {
  margin: 8px 0;
  border-left: 3px solid #409eff;
}
.exit-worktree-card.status-success {
  border-left-color: #67c23a;
}
.exit-worktree-card.status-error {
  border-left-color: #f56c6c;
}
.path-text {
  font-size: 12px;
  word-break: break-all;
}
</style>
```

### 5.4 与 EnterWorktree 的联合渲染

由于 ExitWorktree 总是紧跟 EnterWorktree，前端建议将两步工作流合并显示为一个过程卡片：

```vue
<template>
  <el-card class="worktree-lifecycle-card">
    <template #header>
      <span>Worktree 生命周期</span>
    </template>

    <el-steps :active="currentStep" align-center>
      <el-step title="创建 Worktree" :description="enterStatus" />
      <el-step title="退出 Worktree" :description="exitStatus" />
    </el-steps>

    <EnterWorktreeBlock v-if="enterBlock" v-bind="enterBlock" />
    <ExitWorktreeBlock v-if="exitBlock" v-bind="exitBlock" />
  </el-card>
</template>
```

### 5.5 关键交互处理

ExitWorktree 工具**不需要用户直接交互**：
- 不需要权限确认（`tools-reference.md` 标记为 "No" 权限）
- 不需要 `canUseTool` 回调
- 但 `action="remove"` 时如果 worktree 有未提交更改，SDK 会返回错误字符串，需要 LLM 自动重试（添加 `discard_changes: true`）
- **前端需要处理的重试场景**：一次 ExitWorktree 调用可能失败，紧接着 LLM 会再次调用。前端只需正常处理每个 tool_use/tool_result 对即可。

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | input_json_delta | tool_result 格式 | num_turns |
|------|------|--------|-----------------|-----------------|-----------|
| 1 | EnterWorktree → ExitWorktree(keep) | 302 | 4 | 结构化对象（action=keep） | 3 |
| 2 | EnterWorktree → ExitWorktree(remove, 含重试) | 346 | 4+5 | 第 1 次失败（字符串），第 2 次成功（对象） | 4 |
| 3 | ExitWorktree 不在 worktree 中 | 110 | 4 | 错误字符串（"Error: No-op"） | 2 |
| 4 | 纯文本基线 | ~11 | 0 | — | 1 |
| 5 | SSE + keep | ~263 | 4+4 | 2 个结构化对象 | 3 |
| 6 | SSE + no partial + remove | 13 | 0 | 2 个成功对象 + 1 个验证错误 | 4 |

### 6.2 原始事件样本

#### input_json_delta 推送序列 — ExitWorktree(action=keep)

```
[1] ""                                 ← 空 JSON（初始化）
[2] "{"                                ← 开括号
[3] "\"action\": \"keep\""             ← 字段键值对
[4] "}"                                ← 闭括号
```

拼接结果: `{"action": "keep"}`

#### input_json_delta 推送序列 — ExitWorktree(action=remove, discard_changes=true)

```
[1] ""                                        ← 空 JSON（初始化）
[2] "{"                                       ← 开括号
[3] "\"action\": \"remove\""                  ← 第一个字段
[4] ", \"discard_changes\": true"             ← 第二个字段（追加）
[5] "}"                                       ← 闭括号
```

拼接结果: `{"action": "remove", "discard_changes": true}`

#### 成功 tool_result（SSE 格式，Case 5 — action=keep）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "content": "Exited worktree. Your work is preserved at ...",
      "tool_use_id": "call_d8eb35a0a6514f34bd02d9a5"
    }]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-05-14T...",
  "tool_use_result": {
    "action": "keep",
    "originalCwd": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api",
    "worktreePath": "C:\\Users\\...\\.claude\\worktrees\\sse-exit-test",
    "worktreeBranch": "worktree-sse-exit-test",
    "message": "Exited worktree. Your work is preserved at ... Session is now back in ..."
  }
}
```

#### 成功 tool_result（Case 2 — action=remove, discard_changes=true）

```json
{
  "tool_use_result": {
    "action": "remove",
    "originalCwd": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api",
    "worktreePath": "C:\\Users\\...\\.claude\\worktrees\\exit-test-remove",
    "worktreeBranch": "worktree-exit-test-remove",
    "discardedFiles": 0,
    "discardedCommits": 0,
    "message": "Exited and removed worktree at ... Session is now back in ..."
  }
}
```

#### 失败 tool_result（Case 2 — remove 未设 discard_changes）

```json
{
  "tool_use_result": "Error: Could not verify worktree state at ...\\.claude\\worktrees\\exit-test-remove. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: \"keep\" to preserve the worktree."
}
```

#### 失败 tool_result（Case 3 — 不在 worktree 中）

```json
{
  "tool_use_result": "Error: No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made."
}
```

---

## 七、与 EnterWorktree 的对比

| 维度 | EnterWorktree | ExitWorktree |
|------|--------------|--------------|
| **input 参数** | `name?` 或 `path?`（互斥） | `action`（必填）+ `discard_changes?` |
| **成功 tool_result 字段** | `{worktreePath, worktreeBranch, message}` | `{action, originalCwd, worktreePath, worktreeBranch?, discardedFiles?, discardedCommits?, message}` |
| **失败 tool_result** | 错误字符串 `"Error: ..."` | 错误字符串 `"Error: ..."` 或 `"InputValidationError: ..."` |
| **input_json_delta** | 4 次 | 4 次（无 discard_changes）或 5 次（含 discard_changes） |
| **tool_progress** | 0 | 0 |
| **需要权限** | No | No |
| **独立调用** | 可以 | **必须先 EnterWorktree**（否则返回 no-op 错误） |
| **多轮重试** | 无 | remove 可能需要重试（添加 discard_changes） |

---

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 有未提交文件时 action="remove" + discard_changes=false 的具体错误格式 | Case 2 触发但工作区干净，discardedFiles=0 | 需要 worktree 内有实际未提交更改的场景 |
| 有未合并 commits 时 action="remove" 的行为 | 未测试 | discardedCommits 应 > 0 |
| tmuxSessionName 字段 | 未出现 | 仅在 tmux 会话关联时返回 |
| ExitWorktree 在子代理中调用 | 未测试 | tools-reference 说"不可用于子代理" |
| action="remove" + discard_changes=true + 有实际更改 | 未测试 | 应返回非零的 discardedFiles/discardedCommits |
| ExitWorktree 后再次 EnterWorktree 的联合事件流 | 未测试 | 完整生命周期场景 |
