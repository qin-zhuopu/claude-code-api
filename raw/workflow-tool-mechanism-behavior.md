# Workflow 工具行为观察

> 12 组实验，验证 SDK 中 `Workflow` 工具的 API 请求结构、参数传递、禁用机制和消息类型。

## 核心发现摘要表

| # | 实验内容 | 结果 |
|---|---------|------|
| 1 | Workflow 工具是否出现在 API tools 列表 | ✅ 是，26 个工具之一 |
| 2 | 内联脚本模式请求结构 | ✅ 工具存在，maxLength=524288 (512KB) |
| 3 | scriptPath 参数结构 | ✅ string 类型，在 input_schema.properties 中 |
| 4 | args 参数结构 | ✅ 无 type 约束，接受任意 JSON 值 |
| 5 | disableWorkflows 通过 settings 传入 | ✅ 工具从 26→25 消失 |
| 6 | name 参数结构 | ✅ string 类型，在 input_schema.properties 中 |
| 7 | SDK 消息类型 | ✅ system, stream_event, assistant, user, result |
| 8 | input_schema 完整性 | ✅ 7 个参数：script/name/description/title/args/scriptPath/resumeFromRunId |
| 9 | resumeFromRunId 参数 | ✅ string 类型，在 input_schema.properties 中 |
| 10 | 基线对照（简单 prompt） | ✅ Workflow 工具始终存在，单轮对话 |
| 11 | Workflow description 内容 | ✅ 18997 字符，含 ultracode/pipeline/parallel 等关键词 |
| 12 | tools=[] 效果 | ✅ 工具列表清空为 0，Workflow 也消失 |

## 实验矩阵

| Case | 变量 | 预期 | 实际 | 状态 |
|------|------|------|------|------|
| 1 | 基线请求 | Workflow 在 tools 中 | ✅ 26 tools, hasWorkflow=true | ✅ |
| 2 | 简单 prompt | 单轮完成 | ✅ 1 request | ✅ |
| 3 | scriptPath 参数 | 在 input_schema 中 | ✅ string 类型 | ✅ |
| 4 | args 参数 | 无 type 约束 | ✅ 无 type 字段 | ✅ |
| 5 | disableWorkflows: true | 工具消失 | ✅ 25 tools, hasWorkflow=false | ✅ |
| 6 | name 参数 | 在 input_schema 中 | ✅ string 类型 | ✅ |
| 7 | SDK 消息类型 | system/result 存在 | ✅ 包含 | ✅ |
| 8 | input_schema 完整性 | 7 个参数 | ✅ 全部确认 | ✅ |
| 9 | resumeFromRunId | 在 input_schema 中 | ✅ string 类型 | ✅ |
| 10 | 基线对照 | 工具存在但未被调用 | ✅ 单轮对话 | ✅ |
| 11 | description 内容 | 含关键约束词 | ✅ 18997 字符 | ✅ |
| 12 | tools=[] | 完全清空 | ✅ 0 tools | ✅ |

## 详细发现

### 1. Workflow 工具的 API 请求结构

Workflow 工具始终出现在初始请求的 `tools` 数组中（除非被 `disableWorkflows` 或 `tools=[]` 禁用）。

**工具定义：**
- **name**: `"Workflow"`
- **description**: 18997 字符的超长文本，包含完整的 workflow 使用说明
- **input_schema**: JSON Schema Draft 2020-12，包含 7 个属性

**完整 input_schema.properties：**

```json
{
  "script": {
    "type": "string",
    "maxLength": 524288,
    "description": "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }`..."
  },
  "name": {
    "type": "string",
    "description": "Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script."
  },
  "description": {
    "type": "string",
    "description": "Ignored — set the workflow description in the script's `meta` block."
  },
  "title": {
    "type": "string",
    "description": "Ignored — set the workflow title in the script's `meta` block."
  },
  "args": {
    "description": "Optional input value exposed to the script as the global `args`..."
    // 注意：没有 type 字段！可以传任意 JSON 值
  },
  "scriptPath": {
    "type": "string",
    "description": "Path to a workflow script file on disk..."
  },
  "resumeFromRunId": {
    "type": "string",
    "description": "Run ID of a prior Workflow invocation to resume from..."
  }
}
```

### 2. description 字段极大（18997 字符）

Workflow 工具的 description 字段是所有工具中最大的，包含：
- 完整的 workflow 使用说明
- `ultracode` 关键词触发机制说明
- `agent()`/`parallel()`/`pipeline()`/`phase()` 函数签名
- 质量模式示例（adversarial verify, judge panel, loop-until-dry 等）
- `budget` 对象的用法
- Resume 机制说明

这占据了 API 请求中大量的 token。

### 3. `disableWorkflows` 的行为

**关键发现：`disableWorkflows` 必须通过 `settings` 字段传入，不能作为 Options 的顶层属性。**

```typescript
// ✅ 正确方式
{ settings: { disableWorkflows: true } }

// ❌ 错误方式（无效）
{ disableWorkflows: true }
```

**效果：**
- 正常情况：26 个工具（含 Workflow）
- disableWorkflows 后：25 个工具（Workflow 消失）

**注意**：旧的历史请求中 26 工具的情况是之前的测试残留，新请求中 disableWorkflows 确实生效。

### 4. Subagent 请求中 Workflow 工具不存在

通过 case-1 的多轮请求分析，发现两种 subagent 请求模式：

| 工具数 | 特征 | 说明 |
|--------|------|------|
| 26 | 含 Agent, Workflow | 主会话请求 |
| 23 | 无 Agent, 无 Workflow | Subagent 内部请求 |
| 15 | 无 Agent, 无 Workflow, 无 Cron | 另一种受限 Subagent |

**23 工具 subagent 缺少的工具：** Agent, Workflow, 以及部分 cron/task 工具
**15 工具 subagent 缺少的工具：** CronCreate, CronDelete, CronList, Workflow, 以及更多

这表明：
- **Workflow 工具不暴露给 subagent** — subagent 不能嵌套调用 workflow
- **Agent 工具也不暴露给某些 subagent** — 防止无限嵌套
- 工具裁剪是 CLI 自动管理的，SDK 使用者无法控制

### 5. `tools=[]` 完全清除所有工具

当设置 `tools: []` 时，API 请求中的 `tools` 数组为 `[]`（长度 0），所有内置工具包括 Workflow 全部消失。

### 6. `args` 参数无 type 约束

`args` 在 input_schema 中**没有 `type` 字段**，这意味着它可以接受任意 JSON 值（对象、数组、字符串、数字等）。这与 SDK 文档中 "verbatim" 的描述一致。

### 7. `description` 和 `title` 参数被标记为 Ignored

`input_schema.properties` 中 `description` 和 `title` 的描述明确写着 `"Ignored — set the workflow description in the script's meta block."` 和 `"Ignored — set the workflow title in the script's meta block."` 这两个参数是 `WorkflowInput` 接口的一部分但实际被忽略。

### 8. SDK 消息类型

Workflow 测试期间观察到的 SDK 消息类型：
- `system` (subtype: `init`)
- `stream_event` (各种内部事件)
- `assistant` (最终回复)
- `result` (结束消息)

在简单 prompt 下（不实际触发 workflow 执行），没有观察到 `task_started`/`task_notification` 等 workflow 专属消息类型。

## 实际应用建议

### 何时使用 Workflow 工具

1. **通过 prompt 触发** — 用户说 "use a workflow" 或在 prompt 中包含 `ultracode` 关键词
2. **通过 effort 设置** — `effort: 'xhigh'` 时 Claude 自动判断是否使用
3. **直接调用** — 明确告诉 Claude 使用 Workflow 工具并传入脚本

### 禁用方式

```typescript
// 方式 1: 通过 settings
query({
  prompt: "...",
  options: {
    settings: { disableWorkflows: true },
    // 其他选项...
  }
});

// 方式 2: 通过 tools=[] 清空所有工具
query({
  prompt: "...",
  options: {
    tools: [],
    // 其他选项...
  }
});
```

### 脚本大小限制

`script` 参数的 `maxLength` 为 **524288**（512KB），但实际受限于 API 的总 token 限制。

## 未验证行为

| 行为 | 原因 |
|------|------|
| Workflow 工具实际调用时的 tool_result 结构（runId/scriptPath） | 本地 LLM 不遵循指令执行 workflow 脚本 |
| resumeFromRunId 恢复机制 | 需要两次连续运行，本地 LLM 无法保证第一次成功 |
| name 参数调用内置工作流（如 deep-research） | 内置工作流需要 WebSearch 工具，本地环境不可用 |
| parallel vs pipeline 编排模式差异 | 需要实际执行才能观察 API 调用差异 |
| Workflow 运行期间产生的 task_started/task_notification 消息 | 需要 workflow 实际运行 |
| budget 参数在脚本中的行为 | 需要实际执行 |
| scriptPath 模式持久化脚本的重用 | 需要实际执行 |

## OTEL 日志目录

```
test/integration/tmp/workflow/
├── case-1-tool-in-api/
├── case-2-inline-script/
├── case-3-script-path/
├── case-4-args/
├── case-5-disable/
├── case-6-name/
├── case-7-message-types/
├── case-8-input-schema/
├── case-9-resume/
├── case-10-baseline/
├── case-11-description/
└── case-12-tools-empty/
```

每个 case 目录下含带时间戳的子目录，包含 `.request.json` 和 `.response.json` 文件。
