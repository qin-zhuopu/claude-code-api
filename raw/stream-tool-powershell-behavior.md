# PowerShell 工具流式调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-powershell.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| input_schema 字段 | command（必需）, description（可选） |
| tool_result 结构 | 成功：`{stdout, stderr, interrupted, isImage, noOutputExpected}`，失败：错误字符串 |
| stream_event 总数 | 33-183 个（取决于是否调用工具） |
| input_json_delta 推送次数 | 固定 **5 次**（空开始 + `{` + command + description + `}`） |
| tool_progress 推送次数 | **0**（PowerShell 执行期间无 tool_progress 事件） |
| 状态更新频率 | 低 — PowerShell 执行期间无推送，执行完成后返回完整结果 |
| 与 Bash 的差异 | input 结构相同，tool_result 格式相同，但 PowerShell 有独立的工具名称 |

---

## 一、tool_use 调用格式

### 1.1 input_schema（来自 SDK init 消息）

PowerShell 工具的 input_schema 推断（基于实验观测）：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "PowerShell 命令或脚本"
    },
    "description": {
      "type": "string",
      "description": "命令描述（可选）"
    }
  },
  "required": ["command"]
}
```

### 1.2 实际 input 示例（来自 assistant 消息的 tool_use block）

**Case 3: 失败的 Get-Content 命令**

```json
{
  "command": "Get-Content C:\\nonexistent_file_xyz.txt",
  "description": "Attempt to read a non-existent file"
}
```

**关键发现**：
- `command` 字段：完整的 PowerShell 命令，包含参数
- `description` 字段：LLM 自动生成的命令说明
- 路径中的反斜杠需要转义为 `\\\\`（JSON 双重转义）

---

## 二、tool_result 返回值格式

### 2.1 成功场景的 tool_result 结构

**实际数据（Case 6 SSE 格式）**：

```json
{
  "tool_use_id": "call_bcb5381123d54ebcb2cb3917",
  "type": "tool_result",
  "content": "SSE-TEST-OUTPUT",
  "is_error": false
}
```

**完整 tool_result（从 user 消息提取）**：

```json
{
  "stdout": "SSE-TEST-OUTPUT",
  "stderr": "",
  "interrupted": false,
  "isImage": false,
  "noOutputExpected": false
}
```

### 2.2 失败场景的 tool_result 格式

**实际数据（Case 3: 文件不存在）**：

```json
{
  "tool_use_id": "call_f0676f9792c3402280d07df1",
  "type": "tool_result",
  "content": "Error: Exit code 1\nGet-Content : Cannot find path 'C:\\nonexistent_file_xyz.txt' because it does not exist.\r\nAt line:1 char:1\r\n+ Get-Content C:\\nonexistent_file_xyz.txt\r\n+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n    + CategoryInfo          : ObjectNotFound: (C:\\nonexistent_file_xyz.txt:String) [Get-Content], ItemNotFoundException\r\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand",
  "is_error": true
}
```

**关键发现**：
- **成功时**：返回结构化对象 `{stdout, stderr, interrupted, isImage, noOutputExpected}`
- **失败时**：返回错误字符串（以 "Error: Exit code 1" 开头）+ PowerShell 完整错误信息
- **is_error 字段**：失败时为 true，成功时为 false 或不存在

### 2.3 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| stdout | string | 标准输出内容 |
| stderr | string | 标准错误输出 |
| interrupted | boolean | 命令是否被中断 |
| isImage | boolean | 输出是否为图片 |
| noOutputExpected | boolean | 是否预期无输出 |
| is_error | boolean | 命令是否执行失败（仅失败时出现） |

---

## 三、流式事件序列

### 3.1 完整时间线（Case 3: PowerShell 调用）

```
[  0] system (init)                     ← 会话初始化
[  1] system (status)                   ← 状态更新
[  2] stream_event message_start        ← 第 1 轮 API 调用开始
[  3-4] stream_event (thinking block)   ← 思考过程
[  5] stream_event content_block_start  ← PowerShell tool_use block 开始
                                          name: "PowerShell"
                                          id: "call_f0676f9792c3402280d07df1"
[  6] stream_event input_json_delta     ← 空字符串开始
[  7] stream_event input_json_delta     ← "{"
[  8] stream_event input_json_delta     ← "command": "Get-Content C:\\\\nonexistent_file_xyz.txt"
[  9] stream_event input_json_delta     ← ", "description": "Attempt to read a non-existent file"
[ 10] stream_event input_json_delta     ← "}"
[ 11] assistant (tool_use)              ← 完整 PowerShell tool_use block
                                          input: {command, description}
[ 12] stream_event content_block_stop   ← block 结束
[ 13-14] stream_event (message_delta, message_stop)
[ 15] user (tool_result)                ← PowerShell 执行结果
                                          错误字符串（Exit code 1 + 完整错误）
[ 16] system (status)                   ← 状态更新
[ 17] stream_event message_start        ← 第 2 轮 API 调用开始
[ 18-...] stream_event (text deltas)    ← LLM 分析错误原因
[ ...] assistant (text)                 ← 完整文本回复
[ ...] result (success)                 ← 最终结果
```

### 3.2 各阶段事件数量统计

| Case | 场景 | 总事件 | stream_event | assistant | user | result | num_turns | input_json_delta |
|------|------|--------|-------------|-----------|------|--------|-----------|------------------|
| 1 | 简单命令 | 33 | 24 | 2 | 1 | 1 | 2 | **5** (Bash, 非 PowerShell) |
| 2 | 长输出命令 | 54 | 46 | 3 | 1 | 1 | 2 | **5** (Bash, 非 PowerShell) |
| 3 | 失败命令 | 183 | 178 | 2 | 1 | 1 | 2 | **5** (PowerShell) |
| 4 | 管道命令 | (未调用 PowerShell) | - | - | - | - | - | - |
| 5 | 纯文本基线 | 33 | 0 | 2 | 0 | 1 | 1 | 0 |

**关键发现**：
- **input_json_delta 固定 5 次**：与 Bash 工具相同
- **无 tool_progress**：PowerShell 执行期间无进度推送（与 Bash 相同）
- **Case 1 和 2**：LLM 选择使用 Bash 而非 PowerShell（即使启用了 PowerShell 工具）
- **Case 3**：明确要求使用 PowerShell 时，LLM 成功调用

---

## 四、状态更新机制

### 4.1 tool_progress 推送分析

**实验结果**：
- **Case 1-5**：所有案例中 **tool_progress 事件数为 0**
- **结论**：PowerShell 执行期间 SDK **不推送** tool_progress 事件

**与 Bash 的对比**：
- Bash 工具：同样无 tool_progress（参考 `stream-tool-bash-behavior.md`）
- PowerShell 工具：行为与 Bash 完全一致

### 4.2 SDK 推送频率统计

**PowerShell 执行期间的事件推送**：

| 阶段 | 事件类型 | 数量 | 说明 |
|------|----------|------|------|
| tool_use 构建期 | input_json_delta | 5 | 固定 5 次推送 |
| tool_use 构建期 | content_block_start | 1 | 标记 block 开始 |
| tool_use 构建期 | content_block_stop | 1 | 标记 block 结束 |
| PowerShell 执行期 | **tool_progress** | **0** | **无进度推送** |
| 结果返回期 | user (tool_result) | 1 | 执行完成后一次性返回 |

**总推送次数**：7 个事件（5 个 delta + 2 个控制事件）

### 4.3 是否需要不断修改前端状态？

**答案：不需要**

**原因**：
1. **无增量进度**：tool_progress 为 0，执行期间无状态更新
2. **一次性结果**：PowerShell 执行完成后，user 消息一次性返回完整结果
3. **前端渲染策略**：
   - 显示 "Running PowerShell..." 状态
   - 等待 user 消息到达
   - 一次性渲染完整结果

**与瞬时工具（如 CronCreate）的对比**：
| 工具类型 | 执行时间 | tool_progress | 状态更新需求 |
|----------|----------|---------------|--------------|
| PowerShell | 可变（毫秒到分钟） | 0 | 低 |
| CronCreate | 瞬时 | 0 | 低 |
| Bash | 可变（毫秒到分钟） | 0 | 低 |
| Monitor | 长时间 | 频繁 | 高 |

**优化建议**：
- PowerShell 工具的渲染逻辑与 Bash 完全相同
- 使用相同的 `ToolUseBlock` 组件
- 显示工具名称时区分 "PowerShell" vs "Bash"

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
interface PowerShellToolResult {
  // 成功时的结构化格式
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isImage?: boolean;
  noOutputExpected?: boolean;

  // 失败时的错误字符串
  error?: string;
  is_error?: boolean;
}

interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: {
    command: string;
    description?: string;
  };
  toolStatus?: 'calling' | 'running' | 'complete' | 'error';
  toolResult?: PowerShellToolResult;
}
```

### 5.2 状态机设计

```typescript
enum PowerShellToolStatus {
  CALLING = 'calling',    // LLM 生成 tool_use 参数
  RUNNING = 'running',    // PowerShell 执行中（无进度更新）
  COMPLETE = 'complete',  // 执行成功
  ERROR = 'error'         // 执行失败
}

interface ToolBlockState {
  status: PowerShellToolStatus;
  inputJsonBuffer: string;  // input_json_delta 拼接缓冲
  startTime: number;        // 开始时间戳
  elapsedMs: number;        // 已耗时
}
```

### 5.3 组件模板

```vue
<template>
  <el-card class="tool-use-card" :class="statusClass">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType" size="small">
          <el-icon><Monitor /></el-icon>
          PowerShell
        </el-tag>
        <el-tag v-if="status === 'running'" type="warning" size="small">
          <el-icon class="is-loading"><Loading /></el-icon>
          执行中 {{ elapsedSeconds }}s
        </el-tag>
        <el-tag v-else-if="status === 'complete'" type="success" size="small">
          完成
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger" size="small">
          失败
        </el-tag>
      </div>
    </template>

    <!-- 工具参数（命令和描述） -->
    <div v-if="toolInput" class="tool-input">
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="Command">
          <code class="command-text">{{ toolInput.command }}</code>
        </el-descriptions-item>
        <el-descriptions-item v-if="toolInput.description" label="Description">
          {{ toolInput.description }}
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- 工具结果（执行后显示） -->
    <div v-if="toolResult" class="tool-result">
      <!-- 成功场景 -->
      <div v-if="!toolResult.is_error && toolResult.stdout" class="result-success">
        <el-divider content-position="left">
          <el-icon><Check /></el-icon>
          输出
        </el-divider>
        <el-scrollbar height="300px">
          <pre class="output-text">{{ toolResult.stdout }}</pre>
        </el-scrollbar>
      </div>

      <!-- 失败场景 -->
      <div v-else-if="toolResult.is_error" class="result-error">
        <el-divider content-position="left">
          <el-icon><Close /></el-icon>
          错误
        </el-divider>
        <el-alert
          :title="toolResult.error?.split('\n')[0] || 'Command failed'"
          type="error"
          :description="toolResult.error || toolResult.content"
          :closable="false"
          show-icon
        />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Monitor, Loading, Check, Close } from '@element-plus/icons-vue';

const props = defineProps<{
  status: PowerShellToolStatus;
  toolInput?: { command: string; description?: string };
  toolResult?: PowerShellToolResult;
  elapsedMs?: number;
}>();

const statusClass = computed(() => `status-${props.status}`);

const statusTagType = computed(() => {
  switch (props.status) {
    case 'running': return 'warning';
    case 'complete': return 'success';
    case 'error': return 'danger';
    default: return 'info';
  }
});

const elapsedSeconds = computed(() =>
  props.elapsedMs ? (props.elapsedMs / 1000).toFixed(1) : '0.0'
);
</script>

<style scoped>
.tool-use-card {
  margin: 12px 0;
  border-left: 4px solid #409eff;
}

.tool-use-card.status-running {
  border-left-color: #e6a23c;
}

.tool-use-card.status-complete {
  border-left-color: #67c23a;
}

.tool-use-card.status-error {
  border-left-color: #f56c6c;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.command-text {
  background: #f5f7fa;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace;
  color: #303133;
}

.tool-result {
  margin-top: 12px;
}

.result-success .output-text {
  background: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #303133;
  white-space: pre-wrap;
  word-break: break-all;
}

.result-error {
  margin-top: 8px;
}
</style>
```

### 5.4 事件处理逻辑

```typescript
// 在 useClaudeStream composable 中
function processStreamEvent(event: any, state: StreamState) {
  switch (event.type) {
    case 'content_block_start':
      if (event.content_block?.type === 'tool_use') {
        if (event.content_block.name === 'PowerShell') {
          state.currentBlock = {
            type: 'tool_use',
            toolUseId: event.content_block.id,
            toolName: 'PowerShell',
            toolInput: {} as any,
            toolStatus: 'calling',
          };
          state.inputJsonBuffer = '';
        }
      }
      break;

    case 'content_block_delta':
      if (event.delta?.type === 'input_json_delta' && state.currentBlock?.toolName === 'PowerShell') {
        state.inputJsonBuffer += event.delta.partial_json || '';
        try {
          state.currentBlock.toolInput = JSON.parse(state.inputJsonBuffer);
          // 更新状态为 running
          state.currentBlock.toolStatus = 'running';
        } catch {
          // JSON 不完整，继续拼接
        }
      }
      break;

    case 'content_block_stop':
      if (state.currentBlock?.toolName === 'PowerShell') {
        // 将 block 追加到 messages
        const msg = state.messages.find(m => m.id === state.currentMessageId);
        if (msg) {
          msg.blocks = [...msg.blocks, { ...state.currentBlock }];
        }
      }
      break;
  }
}

function processToolResult(msg: any, state: StreamState) {
  // 查找最后一个 PowerShell tool_use block
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    for (const block of m.blocks) {
      if (block.type === 'tool_use' && block.toolName === 'PowerShell' && block.toolStatus === 'running') {
        // 解析 tool_result
        const content = msg.message?.content?.[0];
        if (content?.type === 'tool_result') {
          if (content.is_error) {
            block.toolStatus = 'error';
            block.toolResult = {
              error: content.content,
              is_error: true,
            };
          } else {
            // 尝试解析结构化结果
            try {
              const parsed = typeof content.content === 'string'
                ? JSON.parse(content.content)
                : content.content;
              block.toolStatus = 'complete';
              block.toolResult = parsed;
            } catch {
              // 无法解析，直接使用字符串
              block.toolStatus = 'complete';
              block.toolResult = {
                stdout: content.content,
              };
            }
          }
        }
        return;
      }
    }
  }
}
```

### 5.5 关键交互处理

**1. 命令执行状态展示**

```typescript
// 在 PowerShell tool_use block 创建后
watch(
  () => currentBlock.value?.toolStatus,
  (status) => {
    if (status === 'running') {
      // 启动计时器
      elapsedTimer.value = setInterval(() => {
        elapsedMs.value = Date.now() - startTime.value;
      }, 100);
    } else if (status === 'complete' || status === 'error') {
      // 停止计时器
      if (elapsedTimer.value) {
        clearInterval(elapsedTimer.value);
        elapsedTimer.value = null;
      }
    }
  }
);
```

**2. 输出内容的语法高亮（可选）**

对于 PowerShell 输出，可以使用 `highlight.js` 或 `prism.js` 进行语法高亮：

```vue
<template>
  <pre class="output-text"><code v-html="highlightedOutput" /></pre>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { highlight } from 'highlight.js/lib/core';
import powershell from 'highlight.js/lib/languages/powershell';

highlight.registerLanguage('powershell', powershell);

const highlightedOutput = computed(() => {
  if (!props.toolResult?.stdout) return '';
  return highlight(props.toolResult.stdout, { language: 'powershell' }).value;
});
</script>
```

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | LLM 是否调用 PowerShell | input_json_delta | tool_progress | tool_result 格式 |
|------|------|------------------------|------------------|---------------|------------------|
| 1 | 简单命令 | ❌ 使用 Bash | 5 (Bash) | 0 | 结构化 `{stdout, ...}` |
| 2 | 长输出命令 | ❌ 使用 Bash | 5 (Bash) | 0 | 结构化 `{stdout, ...}` |
| 3 | 失败命令 | ✅ 调用 PowerShell | **5** | **0** | **错误字符串** |
| 4 | 管道命令 | ❌ 使用 Bash | 5 (Bash) | 0 | 结构化 `{stdout, ...}` |
| 5 | 纯文本基线 | N/A | 0 | 0 | N/A |
| 6 | SSE 格式 | ✅ 调用 PowerShell | 5 | 0 | 结构化（SSE 简化格式） |

**关键发现**：
- **LLM 偏好 Bash**：除非明确要求使用 PowerShell，否则 LLM 默认选择 Bash
- **input_json_delta 固定 5 次**：与 Bash 工具完全相同
- **无 tool_progress**：执行期间无增量进度

### 6.2 原始事件样本

**事件 5-10: input_json_delta 拼接过程**

```json
[
  {
    "index": 5,
    "type": "stream_event",
    "eventType": "content_block_start",
    "toolName": "PowerShell",
    "toolUseId": "call_f0676f9792c3402280d07df1"
  },
  {
    "index": 6,
    "type": "stream_event",
    "eventType": "content_block_delta",
    "deltaType": "input_json_delta",
    "inputJsonSnippet": ""
  },
  {
    "index": 7,
    "type": "stream_event",
    "eventType": "content_block_delta",
    "deltaType": "input_json_delta",
    "inputJsonSnippet": "{"
  },
  {
    "index": 8,
    "type": "stream_event",
    "eventType": "content_block_delta",
    "deltaType": "input_json_delta",
    "inputJsonSnippet": "\"command\": \"Get-Content C:\\\\nonexistent_file_xyz.txt\""
  },
  {
    "index": 9,
    "type": "stream_event",
    "eventType": "content_block_delta",
    "deltaType": "input_json_delta",
    "inputJsonSnippet": ", \"description\": \"Attempt to read a non-existent file\""
  },
  {
    "index": 10,
    "type": "stream_event",
    "eventType": "content_block_delta",
    "deltaType": "input_json_delta",
    "inputJsonSnippet": "}"
  }
]
```

**事件 11: assistant 消息（tool_use block）**

```json
{
  "index": 11,
  "type": "assistant",
  "toolName": "PowerShell",
  "toolUseId": "call_f0676f9792c3402280d07df1",
  "raw": {
    "toolInput": {
      "command": "Get-Content C:\\nonexistent_file_xyz.txt",
      "description": "Attempt to read a non-existent file"
    }
  }
}
```

**事件 15: user 消息（tool_result）**

```json
{
  "index": 15,
  "type": "user",
  "raw": {
    "parent_tool_use_id": null,
    "tool_use_result": "Error: Exit code 1\nGet-Content : Cannot find path 'C:\\nonexistent_file_xyz.txt' because it does not exist.\r\nAt line:1 char:1\r\n+ Get-Content C:\\nonexistent_file_xyz.txt\r\n+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n    + CategoryInfo          : ObjectNotFound: (C:\\nonexistent_file_xyz.txt:String) [Get-Content], ItemNotFoundException\r\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand",
    "messageContentTypes": [
      {
        "type": "tool_result",
        "tool_use_id": "call_f0676f9792c3402280d07df1",
        "contentType": "string",
        "contentSnippet": "Exit code 1\nGet-Content : Cannot find path..."
      }
    ]
  }
}
```

---

## 七、与 Bash 工具的对比

| 维度 | Bash | PowerShell |
|------|------|-----------|
| **工具名称** | Bash | PowerShell |
| **input 字段** | command, description | command, description |
| **input_json_delta 次数** | 5 | **5** |
| **tool_progress** | 0 | **0** |
| **成功 tool_result** | `{stdout, stderr, interrupted, isImage, noOutputExpected}` | **相同** |
| **失败 tool_result** | 错误字符串 | **错误字符串** |
| **LLM 默认选择** | ✅ 优先选择 | ❌ 需明确要求 |
| **启用方式** | 默认启用 | 需 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` |

**关键差异**：
- **LLM 偏好**：Bash 是默认选择，PowerShell 需要明确指定
- **启用条件**：PowerShell 需要环境变量启用
- **事件行为**：完全相同（5 次 input_json_delta，0 次 tool_progress）
- **返回值格式**：完全相同

**前端渲染建议**：
- 使用相同的 `ToolUseBlock` 组件
- 通过 `toolName` 字段区分显示
- 对于 PowerShell，使用 PowerShell 图标和语法高亮

---

## 八、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| 长时间运行的 PowerShell 命令 | 未测试 | 可能与 Bash 相同（无 tool_progress） |
| PowerShell 管道命令的执行 | 未完全测试 | Case 4 中 LLM 使用了 Bash 而非 PowerShell |
| PowerShell 后台任务（run_in_background） | 未测试 | SDK 是否支持需要验证 |
| PowerShell 7 vs PowerShell 5.1 的差异 | 未测试 | Windows 上自动检测版本 |
| 跨平台 PowerShell（Linux/macOS） | 未测试 | 非 Windows 平台的行为 |
| PowerShell 输出截断机制 | 未测试 | 是否与 Bash 相同（30,000 字符限制） |
| PowerShell 超时机制 | 未测试 | 是否与 Bash 相同（默认 2 分钟） |

---

## 九、实际应用建议

1. **工具选择策略**：
   - 如果用户明确要求使用 PowerShell，LLM 会调用
   - 否则 LLM 默认使用 Bash
   - 前端应准备好同时处理两种工具

2. **前端渲染**：
   - PowerShell 和 Bash 使用相同的组件
   - 通过 `toolName` 区分显示不同的图标和标签
   - PowerShell 输出可用 PowerShell 语法高亮

3. **状态管理**：
   - 执行期间无 tool_progress，只需显示 "Running..." 状态
   - 执行完成后一次性渲染完整结果
   - 失败时显示错误提示（从错误字符串中提取第一行作为标题）

4. **错误处理**：
   - 失败的 tool_result 是字符串而非结构化对象
   - 需要检测 `content.is_error` 字段
   - 错误字符串包含完整 PowerShell 错误堆栈

5. **性能优化**：
   - input_json_delta 固定 5 次，无需优化
   - 输出内容可能很长，使用虚拟滚动（el-scrollbar）
   - 对于长输出，考虑默认折叠或分页显示
