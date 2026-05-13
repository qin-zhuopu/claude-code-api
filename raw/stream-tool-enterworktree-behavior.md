# EnterWorktree 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-enterworktree.spec.ts`
**测试用例数**: 6（SDK 直接调用 + NestJS SSE）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **input_schema 字段** | `name`（可选，新 worktree 名）和 `path`（可选，已有 worktree 路径），二者互斥 |
| **tool_result 成功结构** | `tool_use_result`: `{worktreePath, worktreeBranch, message}` 结构化对象 |
| **tool_result 失败结构** | `tool_use_result`: `"Error: ..."` 纯错误字符串 |
| **stream_event 总数** | Case 1（成功）: 74 个；Case 2（失败）: ~70 个；Case 4（纯文本）: 8 个 |
| **input_json_delta 推送次数** | **4 次**（`""` → `"{"` → `"\"name\": \"xxx\""` → `"}"`） |
| **tool_progress 推送次数** | **0 次** — EnterWorktree 是瞬时工具 |
| **tool_use_summary 推送次数** | **0 次** |
| **状态更新频率** | 极低 — 仅在 tool_result 注入后有 1 次 system(status) |
| **num_turns** | 2（工具调用场景），1（纯文本） |
| **是否需要不断修改前端状态** | **不需要** — EnterWorktree 是瞬时工具，无持续进度 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK 类型定义 sdk-tools.d.ts）

```typescript
export interface EnterWorktreeInput {
  /**
   * Optional name for a new worktree. Each "/"-separated segment may contain
   * only letters, digits, dots, underscores, and dashes; max 64 chars total.
   * A random name is generated if not provided. Mutually exclusive with `path`.
   */
  name?: string;
  /**
   * Path to an existing worktree of the current repository to switch into
   * instead of creating a new one. Must appear in `git worktree list` for
   * the current repo. Mutually exclusive with `name`.
   */
  path?: string;
}
```

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**创建新 worktree（name 参数，Case 1）**:
```json
{
  "name": "test-wt-001"
}
```

**进入已有 worktree（path 参数，Case 2）**:
```json
{
  "path": "/tmp/nonexistent-worktree-path-12345"
}
```

**不提供任何参数（LLM 可选择不传参数，自动生成随机名）**:
```json
{}
```

---

## 二、tool_result 返回值格式

### 2.1 成功场景（Case 1）

**SDK `tool_use_result` 字段**（结构化对象）:
```json
{
  "worktreePath": "C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api\\.claude\\worktrees\\test-wt-001",
  "worktreeBranch": "worktree-test-wt-001",
  "message": "Created worktree at C:\\Users\\14409.JEREH\\repo\\github.com\\qin-zhuopu\\claude-code-api\\.claude\\worktrees\\test-wt-001 on branch worktree-test-wt-001. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted."
}
```

**Anthropic API `tool_result` content**（纯字符串）:
```json
{
  "type": "tool_result",
  "tool_use_id": "call_c037b682a5fb405eb6a566f3",
  "content": "Created worktree at C:\\Users\\14409.JEREH\\...\\.claude\\worktrees\\test-wt-001 on branch worktree-test-wt-001. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted."
}
```

### 2.2 失败场景（Case 2 — 路径不存在）

**SDK `tool_use_result` 字段**（错误字符串，**非**结构化对象）:
```
"Error: Cannot enter worktree: /tmp/nonexistent-worktree-path-12345: ENOENT: no such file or directory, lstat 'C:\\tmp\\nonexistent-worktree-path-12345'"
```

**Anthropic API `tool_result` content**（纯字符串）:
```json
{
  "type": "tool_result",
  "tool_use_id": "call_5e67ede6309c42c48a6d4416",
  "content": "Cannot enter worktree: /tmp/nonexistent-worktree-path-12345: ENOENT: no such file or directory, lstat 'C:\\tmp\\nonexistent-worktree-path-12345'"
}
```

### 2.3 失败场景（Case 3 — 非 git 仓库）

**SDK `tool_use_result` 字段**（错误字符串）:
```
"Error: Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems."
```

### 2.4 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `worktreePath` | `string` | 新 worktree 的绝对路径（通常在 `.claude/worktrees/` 下） |
| `worktreeBranch` | `string` | 新创建的 git 分支名（格式 `worktree-{name}`） |
| `message` | `string` | 人类可读的创建结果描述 |

> **关键发现**：成功时 `tool_use_result` 是结构化对象（`EnterWorktreeOutput`），失败时是 `string`（以 `"Error: "` 开头）。这与 Bash 工具不同（Bash 成功/失败都是 `BashOutput` 对象），更接近 Edit 工具的模式。

---

## 三、流式事件序列

### 3.1 完整时间线（Case 1 成功场景，77 个事件）

```
[  0] system (init)                          ← 会话初始化
[  1] system (status)                        ← 状态更新 "requesting"
[  2] stream_event → message_start           ← 第 1 轮 API 调用开始
[  3] stream_event → content_block_start     ← text block 开始
[  4] stream_event → content_block_stop      ← text block 结束（空文本，被 LLM 放弃）
[  5] stream_event → content_block_start     ← tool_use block 开始 [EnterWorktree]
[  6] stream_event → content_block_delta [input_json_delta] ""
[  7] stream_event → content_block_delta [input_json_delta] "{"
[  8] stream_event → content_block_delta [input_json_delta] "\"name\": \"test-wt-001\""
[  9] stream_event → content_block_delta [input_json_delta] "}"
[ 10] assistant [tool_use: EnterWorktree]     ← 完整 tool_use block {name: "test-wt-001"}
[ 11] stream_event → content_block_stop      ← tool_use block 结束
[ 12] stream_event → message_delta           ← stop_reason: "tool_use"
[ 13] stream_event → message_stop            ← 消息结束
[ 14] user (tool_result)                     ← SDK 自动执行工具，结果作为 user 消息
[ 15] system (status)                        ← 状态更新 "requesting"
[ 16] stream_event → message_start           ← 第 2 轮 API 调用开始
[ 17] stream_event → content_block_start     ← text block 开始
[ 18-71] stream_event → content_block_delta [text_delta] × 54  ← 文本流式输出
[ 72] assistant [text]                       ← 完整回复 block
[ 73] stream_event → content_block_stop      ← text block 结束
[ 74] stream_event → message_delta           ← stop_reason: "end_turn"
[ 75] stream_event → message_stop            ← 消息结束
[ 76] result (success)                       ← 最终结果
```

### 3.2 各阶段事件数量统计

| Case | 总事件 | stream_event | assistant | user | result | system | tool_progress |
|------|--------|-------------|-----------|------|--------|--------|--------------|
| 1 (成功) | 77 | 66 | 2 | 1 | 1 | 2 | 0 |
| 2 (路径不存在) | ~70 | ~60 | 2 | 1 | 1 | 2 | 0 |
| 3 (非 git) | ~75 | ~65 | 2 | 1 | 1 | 2 | 0 |
| 4 (纯文本) | 11 | 8 | 1 | 0 | 1 | 2 | 0 |

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**实验数据**：Case 1/2/3/4 均为 **0 次 tool_progress 事件**。

**原因**：EnterWorktree 是瞬时工具（执行 git worktree add + checkout），耗时极短（<500ms），SDK 不会为瞬时工具推送 tool_progress。

### 4.2 SDK 推送频率统计

| 事件类型 | 推送次数 | 推送时机 |
|---------|---------|---------|
| system(init) | 1 | 会话开始 |
| system(status) | 2 | 每轮 API 调用前 |
| stream_event (text_delta) | 54-60 | 第 2 轮文本回复期间 |
| stream_event (input_json_delta) | 4 | 工具参数构建期间 |
| stream_event (控制事件) | 8-10 | message/block 生命周期 |
| assistant | 2 | 每个 content block 完成时 |
| user | 1 | 工具执行结果回传 |
| tool_progress | 0 | — |
| tool_use_summary | 0 | — |
| result | 1 | 会话结束 |

### 4.3 是否需要不断修改前端状态？

**不需要**。EnterWorktree 是瞬时工具：
- **工具执行阶段**：只有 4 次 `input_json_delta`，拼接完即完成，无持续进度
- **无 tool_progress**：不像 Bash 等长耗时工具那样推送执行进度
- **前端只需 2 次状态更新**：① 收到 tool_use → 显示"创建 worktree 中"；② 收到 tool_result → 显示结果

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
/** EnterWorktree 工具的 input */
interface EnterWorktreeInput {
  name?: string;   // 新 worktree 名称（与 path 互斥）
  path?: string;   // 已有 worktree 路径（与 name 互斥）
}

/** EnterWorktree 成功时的 tool_use_result */
interface EnterWorktreeSuccessResult {
  worktreePath: string;      // 新 worktree 绝对路径
  worktreeBranch: string;    // 新 git 分支名
  message: string;           // 人类可读描述
}

/** EnterWorktree 失败时的 tool_use_result */
type EnterWorktreeErrorResult = string;  // "Error: ..."

/** EnterWorktree 的 tool_use_result 联合类型 */
type EnterWorktreeResult = EnterWorktreeSuccessResult | EnterWorktreeErrorResult;

/** 前端组件的完整数据模型 */
interface EnterWorktreeBlock {
  type: 'tool_use';
  toolName: 'EnterWorktree';
  toolUseId: string;
  toolInput: EnterWorktreeInput;
  toolStatus: 'calling' | 'success' | 'error';
  toolResult?: EnterWorktreeResult;
}
```

### 5.2 状态机设计

```
calling ──→ success  （tool_use_result 是对象，包含 worktreePath）
    │
    └──→ error    （tool_use_result 是字符串，以 "Error:" 开头）
```

判断成功/失败的逻辑：
```typescript
function parseWorktreeResult(result: EnterWorktreeResult): {
  success: boolean;
  data?: EnterWorktreeSuccessResult;
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
  <el-card class="enter-worktree-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag type="primary">
          <el-icon><FolderAdd /></el-icon>
          EnterWorktree
        </el-tag>
        <el-tag v-if="status === 'calling'" type="warning">
          <el-icon class="is-loading"><Loading /></el-icon>
          创建 worktree...
        </el-tag>
        <el-tag v-else-if="status === 'success'" type="success">
          <el-icon><Check /></el-icon>
          已创建
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger">
          <el-icon><Close /></el-icon>
          失败
        </el-tag>
      </div>
    </template>

    <!-- 工具参数 -->
    <el-descriptions v-if="input" :column="1" border size="small">
      <el-descriptions-item
        v-if="input.name"
        label="名称">
        <el-tag>{{ input.name }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item
        v-if="input.path"
        label="路径">
        <code>{{ input.path }}</code>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 成功结果 -->
    <template v-if="parsedResult?.success && parsedResult.data">
      <el-divider />
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="路径">
          <code class="worktree-path">{{ parsedResult.data.worktreePath }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="分支">
          <el-tag type="info">{{ parsedResult.data.worktreeBranch }}</el-tag>
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
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { FolderAdd, Loading, Check, Close } from '@element-plus/icons-vue';

const props = defineProps<{
  input: EnterWorktreeInput;
  status: 'calling' | 'success' | 'error';
  result?: EnterWorktreeResult;
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
.enter-worktree-card {
  margin: 8px 0;
  border-left: 3px solid #409eff;
}
.enter-worktree-card.status-success {
  border-left-color: #67c23a;
}
.enter-worktree-card.status-error {
  border-left-color: #f56c6c;
}
.worktree-path {
  font-size: 12px;
  word-break: break-all;
}
</style>
```

### 5.4 关键交互处理

EnterWorktree 工具**不需要用户交互**（与 AskUserQuestion 不同）：
- 不需要权限确认（`tools-reference.md` 标记为 "No" 权限）
- 不需要 `canUseTool` 回调
- SDK 自动执行 `git worktree add` 和 `git checkout`

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | input_json_delta | tool_result 格式 | num_turns |
|------|------|--------|-----------------|-----------------|-----------|
| 1 | 创建新 worktree (name) | 77 | 4 | 结构化对象 | 2 |
| 2 | 进入已有 worktree (path, 不存在) | ~70 | 4 | 错误字符串 | 2 |
| 3 | 非 git 仓库中创建 | ~75 | 4 | 错误字符串 | 2 |
| 4 | 纯文本基线 | 11 | 0 | — | 1 |
| 5 | SSE 前端视角 (创建成功) | ~60 | 4 | 结构化对象 | 2 |
| 6 | 关闭 includePartialMessages | ~5 | 0 | — | 2 |

### 6.2 原始事件样本

#### input_json_delta 推送序列（4 次，所有 case 一致）

```
[1] ""                                 ← 空 JSON（初始化）
[2] "{"                                ← 开括号
[3] "\"name\": \"test-wt-001\""        ← 字段键值对
[4] "}"                                ← 闭括号
```

拼接结果: `{"name": "test-wt-001"}`

#### 成功 tool_result（SSE 格式，Case 5）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "content": "Created worktree at ...\\.claude\\worktrees\\sse-test-wt on branch worktree-sse-test-wt. ...",
      "tool_use_id": "call_d8eb35a0a6514f34bd02d9a5"
    }]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-05-13T17:44:54.132Z",
  "tool_use_result": {
    "worktreePath": "C:\\Users\\...\\.claude\\worktrees\\sse-test-wt",
    "worktreeBranch": "worktree-sse-test-wt",
    "message": "Created worktree at ...\\.claude\\worktrees\\sse-test-wt on branch worktree-sse-test-wt. ..."
  }
}
```

#### content_block_start(tool_use) 的完整结构

```json
{
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "tool_use",
    "id": "call_d8eb35a0a6514f34bd02d9a5",
    "name": "EnterWorktree",
    "input": {}
  }
}
```

> **注意**：`content_block_start` 时 `input` 始终为空对象 `{}`，实际参数通过后续 `input_json_delta` 推送。

---

## 七、与其他瞬时工具的对比

| 维度 | EnterWorktree | CronCreate | CronList | Edit |
|------|--------------|-----------|----------|------|
| **成功 tool_result** | 结构化对象 | 结构化对象 | 结构化对象 | 结构化对象（含 diff） |
| **失败 tool_result** | 错误字符串 `"Error: ..."` | 未测试 | 未测试 | 错误字符串 |
| **input_json_delta** | 4 次 | 6-7 次 | 3 次 | 6 次 |
| **tool_progress** | 0 | 0 | 0 | 0 |
| **需要权限** | No | No | No | Yes |
| **需要 read-before-X** | No | No | No | Yes (read-before-edit) |
| **num_turns** | 2 | 2 | 2 | 3 (read→edit→reply) |

---

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 已在 worktree 中再调用 EnterWorktree | 未测试 | 可能被拒绝或创建嵌套 worktree |
| 不提供 name 和 path 时的行为 | 未测试 | SDK 文档说会生成随机名 |
| EnterWorktree 后 ExitWorktree 的联合事件流 | 未测试 | 两步工作流场景 |
| worktree.baseRef = 'head' 时的分支来源 | 未测试 | 从当前 HEAD vs origin/default-branch |
| WorktreeCreate hooks（非 git VCS） | 未测试 | 仅在非 git 仓库时需要 |
| EnterWorktree 在子代理中调用 | 未测试 | tools-reference 说"不可用于子代理" |
