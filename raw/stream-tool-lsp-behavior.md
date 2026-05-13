# LSP 流式工具调用行为观察报告

**日期**: 2026-05-14
**测试文件**: `test/integration/stream-tool-lsp.spec.ts`

## 核心发现摘要

| 维度 | 发现 |
|------|------|
| 工具可用性 | **条件性可用**：需要安装 LSP plugin + language server binary |
| input_schema 字段 | 未直接观测到（LSP 不可用），根据文档推断：action + file_path + line? + character? |
| tool_result 结构 | 未直接观测到，根据文档推断：LSP 操作结果（定义位置/引用列表/类型信息/符号列表） |
| stream_event 总数 | N/A（LSP 不可用时 Claude 回退到 Grep + Read） |
| tool_progress 推送次数 | 预计 **0 次**（LSP 操作是瞬时查询） |
| 状态更新频率 | 预计极低（与 Glob 类似） |
| 回退行为 | **Claude 自动回退到 Grep + Read 组合**，功能等价但效率较低 |

---

## 一、LSP 工具条件性可用机制

### 关键发现：LSP 是条件性工具

LSP 工具**不在默认工具列表中**。它在以下条件满足时才会出现在 Claude 的工具列表中：

1. **安装 LSP plugin**：通过 Claude Code 的 plugin 系统安装对应语言的 LSP plugin
2. **安装 language server binary**：单独安装语言服务器可执行文件
3. **plugin 成功加载**：plugin 在 Claude Code 启动时成功注册

### 实验验证

在我们的测试环境（Windows, Node.js v22.22.0, typescript-language-server 5.2.0 已安装）中：

```
SDK init tools 列表（23 个工具）:
Agent, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit,
EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep,
NotebookEdit, Read, ScheduleWakeup, Skill, TaskOutput, TaskStop, TodoWrite,
WebFetch, WebSearch, Write

→ LSP 不在列表中！
```

**原因**：虽然 `typescript-language-server` binary 已全局安装，但 TypeScript LSP **plugin 没有在 Claude Code 中启用**。Plugin 目录 `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/typescript-lsp/` 中只有 README.md 和 LICENSE，没有 plugin.json 配置。

### LSP Plugin 安装要求

根据文档和 marketplace 目录，TypeScript LSP plugin 需要：

```bash
# 1. 安装 language server binary（已满足）
npm install -g typescript-language-server typescript

# 2. 通过 Claude Code plugin 系统启用（未满足）
# 在 Claude Code CLI 中: /plugin → 搜索 "typescript-lsp" → 启用
```

### 支持的 LSP Plugins（marketplace 中可选）

| Plugin | Language Server | 安装命令 |
|--------|----------------|----------|
| `typescript-lsp` | TypeScript Language Server | `npm install -g typescript-language-server typescript` |
| `pyright-lsp` | Pyright (Python) | `pip install pyright` |
| `rust-analyzer-lsp` | rust-analyzer | [安装指南](https://rust-analyzer.github.io/manual.html#installation) |
| `gopls-lsp` | gopls | `go install golang.org/x/tools/gopls@latest` |
| `clangd-lsp` | clangd | 系统包管理器 |
| `csharp-lsp` | OmniSharp / Roslyn | `dotnet tool install` |
| `jdtls-lsp` | Eclipse JDT LS | 下载 |
| `kotlin-lsp` | Kotlin Language Server | 下载 |
| `lua-lsp` | Lua Language Server | `npm install -g lua-language-server` |
| `php-lsp` | PHP Language Server | `composer install` |
| `ruby-lsp` | Ruby LSP | `gem install ruby-lsp` |
| `swift-lsp` | SourceKit-LSP | Xcode 自带 |

---

## 二、LSP 工具的 input_schema（文档推断）

> **注意**：以下 input_schema 基于官方文档描述推断，未经直接实验验证。

### LSP 工具支持的 action

根据 tools-reference.md 的描述，LSP 工具支持以下代码智能操作：

| Action | 描述 | 预期输入 |
|--------|------|----------|
| 跳转到定义 | Go to Definition | file_path + position |
| 查找所有引用 | Find References | file_path + position |
| 获取类型信息 | Hover/Type Info | file_path + position |
| 列出符号 | Document/Workspace Symbols | file_path 或 query |
| 查找实现 | Find Implementations | file_path + position |
| 调用层次 | Call Hierarchy | file_path + position |

### 推断的 input 结构

```typescript
// 推断的 LSP tool input（基于 LSP 协议和文档描述）
interface LSPToolInput {
  action: 'definition' | 'references' | 'hover' | 'symbols' | 'implementations' | 'callHierarchy';
  file_path: string;       // 文件路径
  line?: number;           // 行号（从 0 或 1 开始）
  character?: number;      // 列号（从 0 开始）
  query?: string;          // 搜索 query（用于 workspace symbols）
}
```

### 推断的 tool_result 结构

```typescript
// 推断的 LSP tool result
interface LSPToolResult {
  // definition / references / implementations
  locations?: Array<{
    file_path: string;
    line: number;
    character?: number;
    text?: string;         // 该行的代码文本
  }>;

  // hover
  hover?: {
    type?: string;         // 类型签名
    documentation?: string; // 文档
  };

  // symbols
  symbols?: Array<{
    name: string;
    kind: string;          // function, class, variable, etc.
    file_path: string;
    line: number;
  }>;

  // diagnostics（自动报告）
  diagnostics?: Array<{
    file_path: string;
    line: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
  }>;
}
```

---

## 三、LSP 不可用时的回退行为

### Claude 的自动回退策略

当 LSP 工具不可用时，Claude **自动回退到 Grep + Read 组合**来完成代码智能任务：

| LSP 功能 | 回退方案 | 事件数 |
|----------|---------|--------|
| Go to Definition | Grep(pattern="query", glob="src/app.module.ts") + Read 多个文件 | 206 事件 |
| Find References | Grep(pattern="import.*query") 遍历文件 | 多轮 Grep |
| Hover/Type Info | Read(file_path) 直接读取文件 | 多轮 Read |

### 实际回退事件流（Case 1 数据）

```
Case 1: "查找 query 函数的定义"

工具调用序列（5 轮，6 个 API turn）：
1. Grep(pattern="query", glob="src/app.module.ts")     → 找到 import 行
2. Grep(pattern="import.*query", glob="src/app.module.ts") → 确认 import
3. Read(src/app.module.ts)                              → 读取文件
4. Read(src/query/query.module.ts)                      → 追踪 import 链
5. Read(src/query/query.service.ts)                     → 找到 query 函数定义

总计: 206 个事件, 6 turn, 28817ms, $0.58477
```

### 回退 vs LSP 的效率对比

| 维度 | LSP（预期） | 回退（Grep+Read） |
|------|------------|-------------------|
| API turn 数 | 1-2 | 5-6 |
| 耗时 | <5s | 28.8s |
| 成本 | ~$0.05 | $0.58 |
| 文件读取 | 0（LSP 直接返回位置） | 3-5 个文件全文读取 |
| 上下文消耗 | 极低（只返回位置信息） | 高（读取大量文件内容） |

---

## 四、LSP Plugin 配置格式

### .lsp.json 文件格式

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    }
  }
}
```

### plugin.json 中的 LSP 配置

```json
{
  "name": "typescript-lsp",
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      }
    }
  }
}
```

### LSP Server 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `command` | Yes | LSP 二进制可执行文件（必须在 PATH 中） |
| `extensionToLanguage` | Yes | 文件扩展名到语言标识符的映射 |
| `args` | No | 命令行参数 |
| `transport` | No | 通信传输方式：`stdio`（默认）或 `socket` |
| `env` | No | 启动服务器时设置的环境变量 |
| `initializationOptions` | No | 初始化时传递给服务器的选项 |
| `settings` | No | 通过 `workspace/didChangeConfiguration` 传递的设置 |
| `workspaceFolder` | No | 服务器的工作区目录 |
| `startupTimeout` | No | 服务器启动超时（毫秒） |
| `shutdownTimeout` | No | 优雅关闭超时（毫秒） |
| `restartOnCrash` | No | 是否在崩溃后自动重启 |
| `maxRestarts` | No | 最大重启次数 |

---

## 五、LSP 的自动诊断功能

### 文件编辑后自动报告

根据文档描述，LSP 的另一个重要功能是在每次文件编辑后自动报告类型错误和警告：

> "After each file edit, it automatically reports type errors and warnings so Claude can fix issues without a separate build step."

这意味着 LSP 不只是被动调用（如 Glob/Grep），还有**主动推送**诊断信息的能力。这种诊断信息可能通过以下 SDK 消息类型传递：

- `system` (subtype: `status`) — 可能包含 LSP 诊断
- 或直接嵌入 tool_result 中

### 诊断信息的影响

- Claude 可以在 Edit 工具调用后立即看到编译错误
- 不需要运行 `tsc --noEmit` 或 `npm run build` 来检查
- 减少了需要执行的工具调用次数

---

## 六、LSP 权限规则

### 权限格式

LSP 工具**不需要权限**（No permission required）。但其权限规则使用 `Read(...)` 路径格式：

```
Read(~/secrets/**)     → 同时应用于 Read, Grep, Glob, LSP
```

这意味着：
- 如果对某路径设置了 Read deny 规则，LSP 也无法访问该路径
- LSP 不需要单独的权限配置

---

## 七、Vue3 + Element Plus 渲染方案

### 数据模型（TypeScript interface）

```typescript
// LSP 工具的推断 input 参数
interface LSPToolInput {
  action: 'definition' | 'references' | 'hover' | 'symbols' | 'implementations' | 'callHierarchy';
  file_path: string;
  line?: number;
  character?: number;
  query?: string;
}

// LSP 工具的推断 result（各 action 不同）
interface LSPDefinitionResult {
  locations: Array<{
    file_path: string;
    line: number;
    character?: number;
    text?: string;
  }>;
}

interface LSPHoverResult {
  type?: string;
  documentation?: string;
}

interface LSPDiagnosticsResult {
  diagnostics: Array<{
    file_path: string;
    line: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
  }>;
}

// 前端 ContentBlock 中的 LSP tool_use 类型
interface LSPToolUseBlock {
  type: 'tool_use';
  toolUseId: string;
  toolName: 'LSP';
  toolInput: LSPToolInput;
  toolStatus: 'calling' | 'running' | 'complete' | 'error' | 'unavailable';
  toolResult?: LSPDefinitionResult | LSPHoverResult | LSPDiagnosticsResult;
}
```

### 状态机设计

```
                  ┌──────────────┐
                  │  unavailable │ ← LSP 工具不在 tools 列表中
                  └──────┬───────┘
                         │ plugin 启用
                         ▼
calling ──→ (content_block_start) ──→ (input_json_delta ×N) ──→ running
                                                                    │
                                                              tool_result
                                                                    │
                                                                    ▼
                                                               complete
                                                           ┌──────────┐
                                                           │ 显示结果  │
                                                           │ (位置/类型)│
                                                           └──────────┘
```

### 组件模板

```vue
<template>
  <el-card class="lsp-tool-card" shadow="hover">
    <template #header>
      <div class="tool-header">
        <el-tag :type="statusTagType">
          <el-icon v-if="status === 'calling' || status === 'running'" class="is-loading">
            <Loading />
          </el-icon>
          LSP · {{ actionLabel }}
        </el-tag>
        <span v-if="toolInput.file_path" class="file-path-text">
          {{ formatPath(toolInput.file_path) }}
          <span v-if="toolInput.line">:{{ toolInput.line }}</span>
        </span>
      </div>
    </template>

    <!-- LSP 不可用提示 -->
    <el-alert
      v-if="status === 'unavailable'"
      title="LSP 工具不可用"
      type="info"
      :closable="false"
      show-icon
    >
      请安装对应语言的 LSP plugin 以启用代码智能功能。
    </el-alert>

    <!-- 加载中 -->
    <div v-else-if="status === 'calling' || status === 'running'" class="loading-area">
      <el-skeleton :rows="2" animated />
    </div>

    <!-- 结果显示 -->
    <template v-else-if="status === 'complete' && result">
      <!-- Definition / References / Implementations 结果 -->
      <template v-if="'locations' in result">
        <el-table
          v-if="result.locations?.length"
          :data="result.locations"
          stripe
          size="small"
          :max-height="300"
        >
          <el-table-column type="index" width="40" label="#" />
          <el-table-column label="文件" min-width="200">
            <template #default="{ row }">
              <span class="file-link" @click="emit('open-file', row.file_path, row.line)">
                {{ formatPath(row.file_path) }}:{{ row.line }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="代码" prop="text" min-width="300">
            <template #default="{ row }">
              <code>{{ row.text }}</code>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="未找到结果" :image-size="60" />
      </template>

      <!-- Hover / Type Info 结果 -->
      <template v-if="'hover' in result || 'type' in result">
        <div class="hover-result">
          <div v-if="result.type" class="type-signature">
            <el-tag type="success" size="small">类型</el-tag>
            <code>{{ result.type }}</code>
          </div>
          <div v-if="result.documentation" class="documentation">
            <el-text type="info">{{ result.documentation }}</el-text>
          </div>
        </div>
      </template>

      <!-- Diagnostics 结果 -->
      <template v-if="'diagnostics' in result">
        <el-table
          v-if="result.diagnostics?.length"
          :data="result.diagnostics"
          stripe
          size="small"
        >
          <el-table-column label="级别" width="80">
            <template #default="{ row }">
              <el-tag :type="severityType(row.severity)" size="small">
                {{ row.severity }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="位置" width="150">
            <template #default="{ row }">
              {{ formatPath(row.file_path) }}:{{ row.line }}
            </template>
          </el-table-column>
          <el-table-column label="消息" prop="message" />
        </el-table>
        <el-result v-else icon="success" title="无诊断问题" />
      </template>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Loading } from '@element-plus/icons-vue'

interface Props {
  toolInput: {
    action: string
    file_path: string
    line?: number
    character?: number
    query?: string
  }
  status: 'calling' | 'running' | 'complete' | 'error' | 'unavailable'
  result?: any
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'open-file': [path: string, line?: number]
}>()

const actionLabel = computed(() => {
  const labels: Record<string, string> = {
    definition: '跳转定义',
    references: '查找引用',
    hover: '类型信息',
    symbols: '符号列表',
    implementations: '查找实现',
    callHierarchy: '调用层次',
  }
  return labels[props.toolInput.action] || props.toolInput.action
})

const statusTagType = computed(() => {
  switch (props.status) {
    case 'complete': return 'success'
    case 'error': return 'danger'
    case 'unavailable': return 'info'
    default: return 'primary'
  }
})

function formatPath(path: string): string {
  return path.split(/[/\\]/).slice(-3).join('/')
}

function severityType(severity: string): string {
  switch (severity) {
    case 'error': return 'danger'
    case 'warning': return 'warning'
    default: return 'info'
  }
}
</script>

<style scoped>
.lsp-tool-card { margin: 8px 0; }
.tool-header { display: flex; align-items: center; gap: 8px; }
.file-path-text {
  font-family: 'Fira Code', monospace;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.file-link {
  color: var(--el-color-primary);
  cursor: pointer;
  font-family: 'Fira Code', monospace;
  font-size: 13px;
}
.file-link:hover { text-decoration: underline; }
.hover-result { padding: 8px 0; }
.type-signature { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.type-signature code {
  font-size: 13px;
  background: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
}
.loading-area { padding: 8px 0; }
</style>
```

### 关键交互处理

LSP 工具**不需要用户交互**（无权限确认、无表单填写）。

**前端渲染流程**：

```
1. 收到 system(init) 消息
   → 检查 tools 列表中是否包含 LSP
   → 如果不包含，标记 LSP 为 unavailable

2. 如果 LSP 可用：
   a. 收到 content_block_start(type=tool_use, name=LSP)
      → 创建 LSPToolUseBlock, status='calling'
      → 显示卡片，带 loading
   b. 收到 input_json_delta ×N
      → 拼接 JSON，解析得到 action, file_path, line
      → 更新卡片显示
   c. 收到 user 消息 (tool_result)
      → 解析 tool_use_result
      → status='complete'
      → 根据 action 类型渲染不同结果视图

3. 如果 LSP 不可用：
   → Claude 自动使用 Grep + Read 组合
   → 前端渲染 Grep/Read 工具调用（已有组件）
   → 可在 UI 中显示提示："安装 LSP plugin 可获得更快的代码导航"
```

---

## 八、前端状态更新回答

### SDK 会推送很多次状态更新吗？

**预计不会。LSP 是瞬时工具，行为与 Glob/Grep 类似：**

| 预计事件类型 | 预计推送次数 | 说明 |
|------------|------------|------|
| `input_json_delta` | 预计 4-8 次 | 取决于 input 参数复杂度 |
| `text_delta` | 变化大 | Claude 的文本回复 |
| `tool_progress` | **预计 0 次** | LSP 查询通常 < 1s |

### 前端状态修改频率

| 阶段 | 预计状态修改次数 | 说明 |
|------|----------------|------|
| tool_use 开始 | 1 次 | 创建 block |
| input_json_delta | 4-8 次 | 拼接参数 |
| tool_result 到达 | 1 次 | 渲染结果 |
| **总计** | **~6-10 次** | 非常少 |

### 额外考虑：LSP 诊断的自动推送

如果 LSP 可用，在每次 Edit 工具调用后，LSP 可能会**自动推送**诊断信息。这意味着：
- 不需要额外的 tool_use 调用
- 诊断信息可能通过 system(status) 消息传递
- 前端需要监听这些消息来更新诊断面板

---

## 九、实验数据

### 实验矩阵

| Case | 场景 | LSP 可用 | 实际使用工具 | 总事件 | API turns | 耗时 | 成本 |
|------|------|---------|------------|--------|-----------|------|------|
| 1 | 查找定义 | ❌ | Grep ×2, Read ×3 | 206 | 6 | 28.8s | $0.58 |
| 4 | 纯文本基线 | N/A | 无 | ~10 | 1 | ~3s | ~$0.01 |

### 原始事件样本（Case 1 — LSP 不可用时的回退行为）

#### init 消息 — tools 列表（LSP 不在其中）

```json
{
  "index": 0,
  "type": "system",
  "subtype": "init",
  "raw": {
    "tools": [null, null, null, null, null, null, null, null, null, null,
              null, null, null, null, null, null, null, null, null, null,
              null, null, null]
  }
}
```

> 注意：SDK init 消息中的 tools 列表全是 null。实际工具名称在 API request 的 tools 数组中：
> Agent, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit,
> EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep,
> NotebookEdit, Read, ScheduleWakeup, Skill, TaskOutput, TaskStop, TodoWrite,
> WebFetch, WebSearch, Write

#### 回退工具调用序列

```
#1: Grep(pattern="query", glob="src/app.module.ts", output_mode="content")
    → 找到 import 行: "import { QueryModule } from './query/query.module';"

#2: Grep(pattern="import.*query", glob="src/app.module.ts", output_mode="content")
    → 确认: "import { QueryModule } from './query/query.module';"

#3: Read(file_path="src/app.module.ts")
    → 读取文件内容

#4: Read(file_path="src/query/query.module.ts")
    → 追踪 import 链

#5: Read(file_path="src/query/query.service.ts")
    → 找到 query 函数定义位置
```

#### 最终结果

```json
{
  "subtype": "success",
  "num_turns": 6,
  "duration_ms": 28817,
  "stop_reason": "end_turn",
  "total_cost_usd": 0.58477
}
```

---

## 十、与基线对比（全工具横向比较）

| 维度 | LSP（推断） | Glob | Grep | Read |
|------|------------|------|------|------|
| 需要权限 | No | No | No | No |
| 需要前置配置 | **Yes（plugin + binary）** | No | No | No |
| 条件性可用 | **Yes** | 始终可用 | 始终可用 | 始终可用 |
| 回退方案 | Grep + Read | 无 | 无 | 无 |
| input 字段数 | 2-5（推断） | 1 | 1-12 | 1-3 |
| tool_result 格式 | 结构化对象（推断） | 结构化对象 | 结构化对象 | 文本 |
| tool_progress | 预计 0 | 0 | 0 | 0 |
| 执行时间 | 预计 <1s | 400-2000ms | <1s | <100ms |
| 额外功能 | **自动诊断** | 无 | 无 | 无 |

---

## 十一、未验证行为

| 行为 | 状态 | 说明 |
|------|------|------|
| LSP input_schema 完整结构 | ❌ 未验证 | 需要 LSP plugin 启用后才能观察 |
| LSP tool_result 完整结构 | ❌ 未验证 | 需要 LSP plugin 启用后才能观察 |
| LSP input_json_delta 推送次数 | ❌ 未验证 | 推断为 4-8 次 |
| LSP tool_progress 频率 | ❌ 未验证 | 推断为 0 次 |
| LSP 诊断信息推送格式 | ❌ 未验证 | Edit 后自动报告诊断的格式未知 |
| LSP 跨文件 reference 结果格式 | ❌ 未验证 | 多文件引用如何返回 |
| LSP symbols 列表格式 | ❌ 未验证 | workspace symbols 的返回格式 |
| LSP 与 Edit 工具的交互 | ❌ 未验证 | Edit 后自动诊断的具体事件序列 |
| LSP server 启动超时处理 | ❌ 未验证 | startupTimeout 到期后的行为 |
| LSP server 崩溃重启 | ❌ 未验证 | restartOnCrash 的具体行为 |
| `--bare` 模式下 LSP 行为 | ❌ 未验证 | 文档提到 `--bare` 跳过 LSP |
| SSE 视角（Case 5/6） | ❌ 未运行 | 测试超时，但 SDK 直连数据已足够 |
| SDK `settingSources: []` 对 LSP 的影响 | ❌ 未验证 | 可能阻止 plugin 加载 |

### 下一步验证建议

1. **安装 TypeScript LSP plugin**：在 Claude Code CLI 中执行 `/plugin` 搜索并启用 `typescript-lsp`
2. **重新运行 Case 1-3**：验证 LSP 可用后的事件流
3. **观察 Edit 后诊断**：执行一次 Edit，观察 LSP 诊断信息的事件格式
4. **对比 LSP vs Grep+Read**：同样任务下的效率差异
