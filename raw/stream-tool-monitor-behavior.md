# Monitor 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-monitor.spec.ts`
**测试用例数**: 6（SDK 直接调用 4 + NestJS SSE 2）
**LLM 后端**: Jereh (Qwen3.5-9B, http://10.1.3.115:4000)

---

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| **工具可用性** | ⚠️ **Monitor 工具在非 Anthropic 直连端点不可用**。使用代理端点时，CLI 不注册 Monitor 工具 |
| **SDK 类型定义** | `sdk-tools.d.ts` 中 **无 MonitorInput / MonitorOutput 类型**。Monitor 的注册逻辑在 CLI 二进制中 |
| **文档定义的 input_schema** | `{ command: string, description: string, timeout_ms?: number, persistent?: boolean }` |
| **条件性可用** | 需要 Claude Code v2.1.98+；不可用于 Bedrock/Vertex/Foundry；`DISABLE_TELEMETRY` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 时禁用 |
| **LLM 回退策略** | 当 Monitor 不可用时，LLM 尝试：① 直接使用 Bash → ② 通过 Skill 间接调用 Monitor → ③ 回退到 Bash 并解释 |
| **tool_result 结构（推断）** | 后台命令输出流，每行推送一次；可能复用 BashOutput 类型 |
| **tool_progress（推断）** | 作为长时间运行的后台工具，预期有持续的 tool_progress 推送 |

---

## 一、tool_use 调用格式

### 1.1 文档定义的 input_schema（来自 agent-sdk__typescript.md）

```typescript
type MonitorInput = {
  command: string;       // 必需：要监控的命令
  description: string;   // 必需：命令描述
  timeout_ms?: number;   // 可选：超时毫秒数
  persistent?: boolean;  // 可选：是否持久监控（会话级别，如 log tail）
};
```

### 1.2 SDK 类型定义状态

**`sdk-tools.d.ts` 中不存在 MonitorInput / MonitorOutput 类型。**

SDK 类型中的 `ToolInputSchemas` 联合类型不包含 Monitor：
```typescript
export type ToolInputSchemas =
  | AgentInput
  | BashInput
  | TaskOutputInput
  | ExitPlanModeInput
  | FileEditInput
  | FileReadInput
  | FileWriteInput
  | GlobInput
  | GrepInput
  // ... 无 MonitorInput
```

同样 `ToolOutputSchemas` 中也没有 MonitorOutput。

### 1.3 推断的实际 input 示例

基于文档描述和 Bash 工具的类比：

**简单监控**：
```json
{
  "command": "tail -f /var/log/app.log",
  "description": "Monitor application log for errors"
}
```

**带超时的监控**：
```json
{
  "command": "while true; do curl -s https://api.example.com/health; sleep 5; done",
  "description": "Poll API health endpoint every 5 seconds",
  "timeout_ms": 60000
}
```

**持久监控（会话级）**：
```json
{
  "command": "tail -f /var/log/app.log | grep --line-buffered ERROR",
  "description": "Persistent watch for error lines in app log",
  "persistent": true
}
```

### 1.4 与 Bash input 对比

| 字段 | Monitor | Bash |
|------|---------|------|
| `command` | ✅ 必需 | ✅ 必需 |
| `description` | ✅ 必需（文档定义） | ❌ 可选 |
| `timeout_ms` | ✅ 可选（Monitor 命名） | ✅ 可选（Bash 命名为 `timeout`） |
| `persistent` | ✅ 可选（Monitor 特有） | ❌ 无 |
| `run_in_background` | ❌ 无（Monitor 本身就是后台） | ✅ 可选 |
| `dangerouslyDisableSandbox` | ❌ 无 | ✅ 可选 |

**关键差异**：
- Monitor 的 `description` 是**必需**的（文档明确定义），Bash 的 `description` 是可选的
- Monitor 特有 `persistent` 字段，支持会话级持久监控
- Monitor 不需要 `run_in_background`——它本身就是后台运行的设计
- Monitor 的超时字段名为 `timeout_ms`，Bash 为 `timeout`（命名不一致）

---

## 二、tool_result 返回值格式

### 2.1 推断结构

由于 Monitor 工具在测试环境中不可用，无法获取实际 tool_result 数据。以下基于文档和 Bash 工具类比推断：

**Monitor 的 tool_result 预期特征**：

1. **逐行推送**：Monitor 的核心设计是"将每行 stdout 推送回 Claude"，因此 tool_result 可能是：
   - **增量式**：每行输出作为一个独立的更新推送
   - **或聚合式**：命令结束后推送所有收集的输出

2. **可能复用 BashOutput 结构**：
   ```typescript
   // 推断：Monitor 可能返回类似 Bash 的结构
   interface MonitorOutput {
     stdout: string;           // 收集的输出
     stderr: string;           // 错误输出
     interrupted: boolean;     // 是否被中断
     // Monitor 特有字段（推断）
     monitorId?: string;       // 监控任务 ID（用于取消）
     persistent?: boolean;     // 是否持久监控
     lineCount?: number;       // 输出行数
   }
   ```

3. **与 Bash run_in_background 的区别**：
   - Bash `run_in_background: true` 返回 `backgroundTaskId`
   - Monitor 是专门设计用于"监控并反应"的工具，有更丰富的输出推送机制

### 2.2 推测的 tool_result 格式（API 层）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "call_xxx",
        "type": "tool_result",
        "content": "Line 1 output\nLine 2 output\nLine 3 output",
        "is_error": false
      }
    ]
  },
  "tool_use_result": {
    "stdout": "Line 1 output\nLine 2 output\nLine 3 output",
    "stderr": "",
    "interrupted": false,
    "monitorId": "monitor_xxx",
    "lineCount": 3
  }
}
```

---

## 三、流式事件序列

### 3.1 推断的完整时间线

```
[  0] system init                        ← 会话初始化（工具列表包含 Monitor）
[  1] system status                      ← 状态更新
[  2] stream_event message_start         ← 第 1 轮 API 调用开始
[  3] stream_event content_block_start   ← thinking block 开始
[  4-?] stream_event thinking_delta      ← 思考内容
[  ?] stream_event content_block_stop    ← thinking block 结束
[  ?] stream_event content_block_start   ← tool_use block 开始 [Monitor]
[  ?] stream_event input_json_delta: ""  ← JSON 片段 1
[  ?] stream_event input_json_delta: "{" ← JSON 片段 2
[  ?] stream_event input_json_delta: "\"command\": \"tail -f ...\""  ← command 字段
[  ?] stream_event input_json_delta: ", \"description\": \"Monitor log...\""  ← description 字段
[  ?] stream_event input_json_delta: "}" ← JSON 片段 N
[  ?] assistant [tool_use: Monitor]      ← 完整 tool_use block
[  ?] stream_event content_block_stop    ← tool_use block 结束
[  ?] stream_event message_delta         ← stop_reason: "tool_use"
[  ?] stream_event message_stop          ← 第 1 轮 API 调用结束
     ─── Monitor 后台运行，逐行推送 stdout ───
[  ?] tool_progress                      ← Monitor 执行中进度推送
[  ?] tool_progress                      ← 持续推送...
[  ?] user tool_result                   ← 命令输出作为 user 消息
[  ?] system status                      ← 状态更新
[  ?] stream_event message_start         ← 第 2 轮 API 调用开始
[  ?-?] stream_event text_delta × N      ← Claude 分析输出
[  ?] assistant [text]                   ← 完整文本回复
[  ?] stream_event message_stop
[  ?] result                             ← 最终结果
```

### 3.2 实验数据 — 工具不可用场景的事件序列

由于 Monitor 工具不可用，LLM 的实际行为序列如下：

**Case-1（LLM 尝试使用 Monitor）**：
```
[第 1 轮] LLM 使用 Bash 执行 echo 命令 → 获取输出
[第 2 轮] LLM 尝试通过 Skill 调用 Monitor → Skill 返回失败
[第 3 轮] LLM 使用文本回复，解释 Monitor 不可用
```

**Case-4（显式要求使用 Monitor）**：
```
[第 1 轮] LLM 尝试通过 Skill 调用 Monitor → Skill 返回失败
[第 2 轮] LLM 回退到 Bash 执行命令
[第 3 轮] LLM 使用文本回复
```

**关键发现**：当目标工具不可用时，LLM 的**三级回退策略**：
1. 直接使用替代工具（Bash）
2. 通过 Skill 间接调用目标工具
3. 纯文本解释 + 替代方案

### 3.3 实际事件数量统计

| Case | 场景 | 总事件 | stream_event | assistant | user | result | 实际使用工具 |
|------|------|--------|-------------|-----------|------|--------|-------------|
| 1 | 简单 Monitor（尝试） | ~70 | ~55 | ~6 | ~3 | 1 | Bash → Skill → 文本 |
| 3 | 纯文本基线 | ~15 | ~12 | 1-2 | 0 | 1 | 无 |
| 4 | 显式 Monitor（尝试） | 169 | ~140 | ~6 | ~4 | 1 | Skill → Bash → 文本 |

---

## 四、工具可用性机制深度分析

### 4.1 Monitor 工具的注册条件

根据文档和实验数据，Monitor 工具的注册条件：

| 条件 | 要求 | 说明 |
|------|------|------|
| **CLI 版本** | ≥ v2.1.98 | 文档明确要求 |
| **API 提供商** | Anthropic 直连 | 不可用于 Bedrock/Vertex/Foundry |
| **遥测设置** | 未禁用 | `DISABLE_TELEMETRY` 未设置 |
| **非必要流量** | 未禁用 | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 未设置 |

### 4.2 实验验证

| 环境 | BASE_URL | Monitor 可用 | 说明 |
|------|----------|-------------|------|
| 本测试（代理端点） | `http://10.1.3.115:4000` | ❌ | 被识别为非 Anthropic 端点 |
| Anthropic 直连 | `https://api.anthropic.com` | ✅（推断） | 应该可用 |

### 4.3 工具注册层级

```
CLI 二进制（原生层）
├── 始终注册：Bash, Read, Edit, Write, Glob, Grep, ...
├── 条件注册：Monitor（需 Anthropic 端点 + 遥测启用）
├── 条件注册：LSP（需 language server plugin）
└── 条件注册：PowerShell（需 CLAUDE_CODE_USE_POWERSHELL_TOOL=1）

SDK（JavaScript 层）
├── 类型定义：sdk-tools.d.ts（不包含 Monitor）
└── query() 函数：启动 CLI 进程，接收工具列表
```

### 4.4 SDK 工具列表验证

实验中 system init 消息返回的工具列表（23 个）：

```
Task, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit,
EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep,
NotebookEdit, Read, ScheduleWakeup, Skill, TaskOutput, TaskStop,
TodoWrite, WebFetch, WebSearch, Write
```

**缺失的工具**：
- Monitor（本实验目标，因端点限制不可用）
- Agent（子代理，可能有独立注册逻辑）
- LSP（需 language server plugin）
- PowerShell（需 Windows + 特定配置）
- TodoWrite ✅（在列表中）
- MCP 相关工具（需 MCP 服务器配置）

---

## 五、Vue3 + Element Plus 渲染方案

### 5.1 数据模型（TypeScript interface）

```typescript
// Monitor 工具的 input（来自文档定义）
interface MonitorToolInput {
  command: string;        // 必需：要监控的命令
  description: string;    // 必需：命令描述
  timeout_ms?: number;    // 可选：超时毫秒数
  persistent?: boolean;   // 可选：是否持久监控
}

// Monitor 工具的 output（推断，基于 Bash 类比）
interface MonitorToolOutput {
  stdout: string;         // 命令输出
  stderr: string;         // 错误输出
  interrupted: boolean;   // 是否被中断
  monitorId?: string;     // 监控任务 ID
  lineCount?: number;     // 输出行数
  durationMs?: number;    // 执行时长
}

// Monitor 工具执行状态
type MonitorToolStatus = 'calling' | 'monitoring' | 'complete' | 'error';

// 渲染用的 Monitor block 数据
interface MonitorToolBlock {
  type: 'tool_use';
  toolName: 'Monitor';
  toolUseId: string;
  input: MonitorToolInput;
  output?: MonitorToolOutput | string;
  status: MonitorToolStatus;
  elapsedTime?: number;
  isPersistent?: boolean;
  isStopped?: boolean;
}
```

### 5.2 状态机设计

```
                    input_json_delta 拼接
  calling ──────────────────────────────→ waiting_start
      │                                       │
      │ (content_block_stop)                  │ (Monitor 开始后台运行)
      ↓                                       ↓
  monitoring ────────────────────────────→ monitoring (逐行输出)
      │                                       │
      │ (tool_progress, 持续更新)              │ (user tool_result)
      ↓                                       ↓
  monitoring (更新 elapsedTime)          complete / error
```

**与 Bash 状态机的关键差异**：
- Bash：`running` → `complete`（一次性执行）
- Monitor：`monitoring` → 可持续推送输出（持久监控场景）

### 5.3 组件模板

```vue
<template>
  <el-card class="monitor-tool-card" :class="statusClass">
    <template #header>
      <div class="monitor-header">
        <div class="monitor-title">
          <el-icon><Monitor /></el-icon>
          <el-tag :type="statusTagType" size="small">Monitor</el-tag>
          <el-tag v-if="input?.persistent" type="" size="small" effect="plain">
            持久监控
          </el-tag>
          <code class="command-preview">{{ input?.command }}</code>
        </div>
        <div class="monitor-status">
          <el-tag v-if="status === 'monitoring'" type="warning" size="small">
            <el-icon class="is-loading"><Loading /></el-icon>
            监控中 {{ elapsedTime }}s
          </el-tag>
          <el-tag v-else-if="status === 'complete'" type="success" size="small">
            <el-icon><CircleCheck /></el-icon> 完成
          </el-tag>
          <el-tag v-else-if="status === 'error'" type="danger" size="small">
            <el-icon><CircleClose /></el-icon> 失败
          </el-tag>
        </div>
      </div>
    </template>

    <!-- 工具参数（可折叠） -->
    <el-collapse v-model="showDetails">
      <el-collapse-item title="监控详情" name="input">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="command">
            <code>{{ input?.command }}</code>
          </el-descriptions-item>
          <el-descriptions-item label="description">
            {{ input?.description }}
          </el-descriptions-item>
          <el-descriptions-item v-if="input?.timeout_ms" label="timeout">
            {{ input.timeout_ms }}ms ({{ (input.timeout_ms / 1000).toFixed(1) }}s)
          </el-descriptions-item>
          <el-descriptions-item v-if="input?.persistent" label="persistent">
            <el-tag type="" size="small">是</el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-collapse-item>
    </el-collapse>

    <!-- 监控输出 — 实时终端风格 -->
    <div v-if="output" class="monitor-output">
      <template v-if="typeof output === 'object' && !isError">
        <div class="output-header">
          <span class="output-label">实时输出：</span>
          <el-tag v-if="output.lineCount" size="small" type="info">
            {{ output.lineCount }} 行
          </el-tag>
        </div>
        <pre class="terminal-output live"><code>{{ output.stdout }}</code></pre>
        <div v-if="output.stderr" class="stderr-block">
          <div class="output-label">stderr:</div>
          <pre class="terminal-output stderr"><code>{{ output.stderr }}</code></pre>
        </div>
      </template>
      <template v-else>
        <pre class="terminal-output error"><code>{{ typeof output === 'string' ? output : 'Unknown error' }}</code></pre>
      </template>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Monitor, Loading, CircleCheck, CircleClose } from '@element-plus/icons-vue'

const props = defineProps<{
  input?: MonitorToolInput
  output?: MonitorToolOutput | string
  status: MonitorToolStatus
  elapsedTime?: number
}>()

const showDetails = ref<string[]>([])
const isError = computed(() => props.status === 'error')
const statusClass = computed(() => `status-${props.status}`)
const statusTagType = computed(() => {
  switch (props.status) {
    case 'calling': return 'info'
    case 'monitoring': return 'warning'
    case 'complete': return 'success'
    case 'error': return 'danger'
    default: return 'info'
  }
})
</script>

<style scoped>
.monitor-tool-card { margin: 8px 0; border-radius: 8px; }
.monitor-header { display: flex; justify-content: space-between; align-items: center; }
.command-preview {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  color: #606266;
  margin-left: 8px;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-output {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: 6px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.terminal-output.live { border-left: 3px solid #e6a23c; }
.terminal-output.stderr { color: #f48771; }
.terminal-output.error { color: #f48771; border: 1px solid #f56c6c; }
.output-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.output-label { font-size: 12px; color: #909399; }
.status-calling { border-left: 3px solid #409eff; }
.status-monitoring { border-left: 3px solid #e6a23c; animation: pulse 2s infinite; }
.status-complete { border-left: 3px solid #67c23a; }
.status-error { border-left: 3px solid #f56c6c; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
</style>
```

### 5.4 事件处理逻辑（在 useClaudeStream composable 中）

```typescript
// 在 processStreamEvent 中处理 Monitor 相关的 input_json_delta
function processMonitorInput(delta: string, block: ContentBlock) {
  inputJsonBuffer += delta
  try {
    const parsed = JSON.parse(inputJsonBuffer)
    block.toolInput = parsed as MonitorToolInput
  } catch { /* JSON 不完整 */ }
}

// 在 processToolResult 中处理 Monitor 结果
function processMonitorResult(msg: SDKUserMessage, block: ContentBlock) {
  const result = msg.tool_use_result

  if (typeof result === 'string') {
    // 失败：错误信息字符串
    block.toolResult = result
    block.toolStatus = 'error'
  } else if (typeof result === 'object' && result !== null) {
    // 成功：MonitorOutput 对象（推断）
    const monitorOutput = result as MonitorToolOutput
    block.toolResult = monitorOutput
    block.toolStatus = 'complete'
  }
}
```

### 5.5 关键交互处理

Monitor 工具的**独特交互特征**：

| 交互场景 | 处理方式 |
|----------|----------|
| 权限确认 | 与 Bash 相同的权限规则，`canUseTool` 回调或 `bypassPermissions` |
| 持久监控 | `persistent: true` 时，Monitor 在整个会话期间持续运行 |
| 取消监控 | 用户请求 Claude 取消，或会话结束时自动停止 |
| 实时输出 | **逐行推送** stdout，前端需要增量追加显示 |
| tool_progress | 预期有持续的 `elapsed_time_seconds` 更新 |

---

## 六、实验数据

### 6.1 实验矩阵

| Case | 场景 | 总事件 | 实际工具 | Monitor 可用 | 耗时 |
|------|------|--------|----------|-------------|------|
| 1 | 简单 Monitor（尝试） | ~70 | Bash → Skill → 文本 | ❌ | ~57s |
| 2 | 输出密集 Monitor（尝试） | — | Bash | ❌ | — |
| 3 | 纯文本基线 | ~15 | 无 | ❌ | ~5s |
| 4 | 显式 Monitor（尝试） | 169 | Skill → Bash → 文本 | ❌ | ~32s |
| 5 | SSE（尝试） | — | — | ❌ | — |
| 6 | SSE 关闭流式 | — | — | ❌ | — |

### 6.2 LLM 回退行为详情

**Case-1 API 请求/响应序列**：
```
Request 1: user → "Use the Monitor tool..."
Response 1: tool_use(Bash, {command: "echo Monitor-Test-Output"})   ← LLM 选择 Bash
Request 2: tool_result → "Monitor-Test-Output"
Response 2: tool_use(Skill, {skill: "Monitor", args: "..."})       ← LLM 尝试 Skill 间接调用
Request 3: tool_result → (Skill 返回失败/空)
Response 3: text("Monitor is unavailable...")                       ← 纯文本解释
```

**Case-4 API 请求/响应序列**：
```
Request 1: user → "Use the Monitor tool (not Bash)..."
Response 1: tool_use(Skill, {skill: "Monitor", args: "..."})       ← LLM 直接尝试 Skill
Request 2: tool_result → (Skill 返回失败/空)
Response 2: tool_use(Bash, {command: "echo test-monitor-output..."})  ← 回退 Bash
Request 3: tool_result → 输出
Response 3: text(解释输出)
```

### 6.3 工具列表对比

| 测试环境 | 工具数量 | 包含 Monitor | BASE_URL |
|----------|---------|-------------|----------|
| 本测试 | 23 | ❌ | http://10.1.3.115:4000 |
| Bash 测试 | 23+ | 未记录 | http://10.1.3.115:4000 |
| Anthropic 直连（推断） | 24+ | ✅ | https://api.anthropic.com |

---

## 七、与已有工具对比

| 维度 | Monitor | Bash | Agent |
|------|---------|------|-------|
| 需要权限 | ✅ Yes | ✅ Yes | ❌ No |
| 执行模式 | 后台持续监控 | 前台/后台一次性 | 前台/后台子代理 |
| 输出推送 | **逐行实时推送** | 执行完毕后一次返回 | 完成后一次返回 |
| tool_progress | 预期持续推送 | 可能（>2s 时） | 可能 |
| SDK 类型 | ❌ 无独立类型 | ✅ BashInput/BashOutput | ✅ AgentInput/AgentOutput |
| 条件性可用 | ✅ 需 Anthropic 端点 | ❌ 始终可用 | ❌ 始终可用 |
| 持久运行 | ✅ persistent 模式 | ❌ 无 | ❌ 无 |
| Input 字段差异 | timeout_ms, persistent | timeout, run_in_background | prompt, tools |
| API 轮数 | ≥2（可能更多，随输出推送） | 2（调用+结果） | 2（调用+结果） |

---

## 八、工具不可用场景的前端处理

### 8.1 检测 Monitor 不可用

```typescript
// 在 system init 事件中检查
function checkMonitorAvailability(initMessage: SDKSystemMessage) {
  const tools = initMessage.tools || []
  return tools.some(t => t.name === 'Monitor')
}

// 如果不可用，前端可以：
// 1. 隐藏 Monitor 相关 UI
// 2. 显示提示："Monitor 工具不可用（需要 Anthropic 直连端点）"
// 3. 提供替代方案提示
```

### 8.2 降级渲染

当 Monitor 不可用但 LLM 尝试使用时，前端可能收到：
- `tool_use(Skill, {skill: "Monitor"})` → Skill 工具调用
- `tool_use(Bash, {command: "..."})` → Bash 替代

前端应统一处理这两种降级场景：

```typescript
// 在 ToolUseBlock 渲染时检查降级
function getEffectiveToolDisplay(block: ContentBlock) {
  if (block.toolName === 'Monitor') {
    return { icon: 'Monitor', label: '监控', color: '#e6a23c' }
  }
  if (block.toolName === 'Skill' && block.toolInput?.skill === 'Monitor') {
    return { icon: 'Warning', label: '监控（降级为 Skill）', color: '#f56c6c' }
  }
  if (block.toolName === 'Bash' && isMonitorFallback(block)) {
    return { icon: 'Monitor', label: '监控（降级为 Bash）', color: '#e6a23c' }
  }
}
```

---

## 九、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| Monitor tool_result 实际格式 | ⚠️ 未验证 | 需 Anthropic 直连端点 |
| tool_progress 推送频率 | ⚠️ 未验证 | 推断：持续推送，间隔约 1-2s |
| persistent 模式的会话级持久化 | ⚠️ 未验证 | 需 Anthropic 直连端点 |
| input_json_delta 推送次数 | ⚠️ 未验证 | 推断：4-6 次（类比 Bash） |
| 逐行输出推送机制 | ⚠️ 未验证 | Monitor 的核心特性 |
| 多 Monitor 并行 | ⚠️ 未验证 | 是否支持同时运行多个 Monitor |
| Monitor 取消机制 | ⚠️ 未验证 | 用户如何取消正在运行的 Monitor |
| tool_use_summary 出现条件 | ⚠️ 未验证 | 长时间 Monitor 后是否生成摘要 |
| MonitorOutput 完整字段 | ⚠️ 未验证 | SDK 类型中无定义 |
| 插件声明的自动 Monitor | ⚠️ 未验证 | 需要 plugin 支持 |

---

## 十、后续实验建议

1. **使用 Anthropic 直连端点**重跑测试，获取 Monitor 工具的实际流式数据
2. **对比 `persistent: true` 和 `persistent: false`** 的行为差异
3. **长时间运行 Monitor**（如 tail -f），观察 tool_progress 推送频率
4. **多行输出推送**：Monitor 逐行推送时，每次推送是一个独立事件还是增量更新？
5. **取消操作**：用户取消 Monitor 时的事件序列
