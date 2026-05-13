# Claude Code 内置工具完整参考

**Sources**: raw/claude-code-docs/docs/tools-reference.md; raw/claude-code-docs/docs/agent-sdk__custom-tools.md; raw/claude-code-docs/docs/agent-sdk__permissions.md; raw/claude-code-docs/docs/agent-sdk__tool-search.md  
**Updated**: 2026-05-13

---

## 全部内置工具一览

| 工具 | 用途 | 需要权限 |
|------|------|----------|
| `Agent` | 生成子代理执行任务 | No |
| `AskUserQuestion` | 向用户提问收集需求 | No |
| `Bash` | 执行 Shell 命令 | **Yes** |
| `CronCreate` | 创建定时/一次性任务 | No |
| `CronDelete` | 取消定时任务 | No |
| `CronList` | 列出所有定时任务 | No |
| `Edit` | 精确字符串替换编辑文件 | **Yes** |
| `EnterPlanMode` | 进入规划模式 | No |
| `EnterWorktree` | 创建/进入 git worktree | No |
| `ExitPlanMode` | 提交计划并退出规划模式 | **Yes** |
| `ExitWorktree` | 退出 worktree 回到原目录 | No |
| `Glob` | 按文件名模式查找文件 | No |
| `Grep` | 按内容模式搜索文件 | No |
| `ListMcpResourcesTool` | 列出 MCP 服务器资源 | No |
| `LSP` | 语言服务器代码智能 | No |
| `Monitor` | 后台运行命令并监控输出 | **Yes** |
| `NotebookEdit` | 编辑 Jupyter Notebook 单元格 | **Yes** |
| `PowerShell` | 执行 PowerShell 命令 | **Yes** |
| `PushNotification` | 发送桌面/手机推送通知 | No |
| `Read` | 读取文件内容 | No |
| `ReadMcpResourceTool` | 按 URI 读取 MCP 资源 | No |
| `RemoteTrigger` | 创建/管理 claude.ai Routines | No |
| `SendMessage` | 向 Agent Team 队友发消息 | No |
| `ShareOnboardingGuide` | 上传分享 ONBOARDING.md | **Yes** |
| `Skill` | 执行 Skill 工作流 | **Yes** |
| `TaskCreate` | 创建后台任务 | No |
| `TaskGet` | 获取任务详情 | No |
| `TaskList` | 列出所有任务 | No |
| `TaskOutput` | _(已废弃)_ 获取任务输出 | No |
| `TaskStop` | 停止后台任务 | No |
| `TaskUpdate` | 更新任务状态 | No |
| `TeamCreate` | 创建 Agent Team | No |
| `TeamDelete` | 解散 Agent Team | No |
| `TodoWrite` | 管理会话任务清单 | No |
| `ToolSearch` | 搜索延迟加载的 MCP 工具 | No |
| `WebFetch` | 抓取 URL 内容 | **Yes** |
| `WebSearch` | 执行网络搜索 | **Yes** |
| `Write` | 创建或覆写文件 | **Yes** |

---

## 工具权限规则格式

工具名称用于 permissions、subagent tools、hook matchers 等配置中。支持 specifier 的工具：

| 规则格式 | 适用工具 | 说明 |
|----------|----------|------|
| `Bash(npm run *)` | Bash, Monitor | 命令模式匹配 |
| `PowerShell(Get-ChildItem *)` | PowerShell | 命令模式匹配 |
| `Read(~/secrets/**)` | Read, Grep, Glob, LSP | 路径模式匹配 |
| `Edit(/src/**)` | Edit, Write, NotebookEdit | 路径模式匹配（同时授予 Read 权限） |
| `Skill(deploy *)` | Skill | Skill 名称匹配 |
| `Agent(Explore)` | Agent | 子代理类型匹配 |
| `WebFetch(domain:example.com)` | WebFetch | 域名匹配 |
| `WebSearch` | WebSearch | 仅支持裸名称 |

---

## 各工具详细行为

### Agent

生成子代理在独立上下文窗口中执行任务，完成后返回单一文本结果。父会话看不到子代理的中间工具调用。

**工具访问控制**：
- 未设置 `tools`/`disallowedTools`：继承父级所有工具
- 仅设置 `tools`：只能使用列出的工具
- 仅设置 `disallowedTools`：排除列出的工具
- 两者都设置：`disallowedTools` 优先

**前台 vs 后台子代理**：
- 前台：显示权限提示，与主会话相同
- 后台：不显示提示，自动拒绝需要提示的工具调用，继续执行

### Bash

在环境中执行 Shell 命令。每条命令在独立进程中运行。

**持久性行为**：
- `cd` 在主会话中持久（限项目目录内），子代理中不持久
- 环境变量不跨命令持久
- 超出项目目录时自动重置到项目根目录

**限制**：
- 超时：默认 2 分钟，最大 10 分钟（通过 `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` 配置）
- 输出长度：默认 30,000 字符，超出后保存到文件（通过 `BASH_MAX_OUTPUT_LENGTH` 配置，上限 150,000）
- 后台任务：设置 `run_in_background: true` 启动后台进程

### Edit

精确字符串替换。接收 `old_string` 和 `new_string`，不使用正则或模糊匹配。

**三项检查**：
1. **Read-before-edit**：必须在当前会话中读取过该文件，且文件未在磁盘上变更
2. **精确匹配**：`old_string` 必须完全匹配（包括空白和缩进）
3. **唯一性**：`old_string` 必须只出现一次，除非设置 `replace_all: true`

> 通过 Bash 执行 `cat path/to/file` 或 `sed -n 'X,Yp' path/to/file` 也满足 read-before-edit 要求。

### Write

创建新文件或完全覆写已有文件。不支持追加或合并。

- 覆写已有文件前必须在当前会话中读取过该文件
- 新文件无此限制
- 部分修改应使用 Edit 而非 Write

### Read

读取文件内容并附带行号。

**支持的文件类型**：
- 纯文本：直接返回内容
- 图片（PNG/JPG 等）：作为视觉内容返回（大图会被缩放）
- PDF：短文件整体读取，长文件（>10页）按范围读取（每次最多 20 页）
- Jupyter Notebook：返回所有单元格及输出

> Read 只读文件不读目录。列目录用 `ls`（通过 Bash）。

### Glob

按文件名模式查找文件。支持标准 glob 语法：
- `**/*.js` — 递归匹配所有 .js 文件
- `src/**/*.ts` — src 下所有 .ts 文件
- `*.{json,yaml}` — 当前目录的 .json 和 .yaml 文件

**注意**：
- 结果按修改时间排序，上限 100 个文件
- **默认不遵守 .gitignore**（设置 `CLAUDE_CODE_GLOB_NO_IGNORE=false` 可改变）

### Grep

搜索文件内容中的模式。基于 ripgrep，使用 ripgrep 正则语法（非 POSIX grep）。

**输出模式**：
- `files_with_matches`（默认）：仅文件路径
- `content`：匹配行及行号
- `count`：每文件匹配数

**注意**：默认遵守 .gitignore，跳过 gitignored 文件。

### LSP

通过语言服务器提供代码智能：
- 跳转到定义
- 查找所有引用
- 获取类型信息
- 列出文件/工作区符号
- 查找接口实现
- 追踪调用层次

> 需要安装对应语言的 code intelligence plugin 才能激活。

### Monitor

在后台运行命令并将每行输出反馈给 Claude，使其能在对话中实时响应。

用途：
- 监控日志文件中的错误
- 轮询 PR/CI 状态变化
- 监视目录文件变更
- 跟踪长时间运行脚本的输出

权限规则与 Bash 相同。不可用于 Bedrock/Vertex/Foundry。

### NotebookEdit

按 `cell_id` 修改 Jupyter Notebook 单元格。

**编辑模式**：
- `replace`（默认）：覆写单元格内容
- `insert`：在目标后插入新单元格（需指定 `cell_type`）
- `delete`：删除目标单元格

权限规则使用 `Edit(...)` 路径格式。

### PowerShell

原生执行 PowerShell 命令。Windows 上自动检测 `pwsh.exe`（PS7+）或回退到 `powershell.exe`（PS5.1）。

启用：`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`

**Shell 选择配置**：
- `"defaultShell": "powershell"` — settings.json 中设置
- `"shell": "powershell"` — 单个 hook 中设置
- `shell: powershell` — skill frontmatter 中设置

### WebFetch

抓取 URL 内容。获取页面后转换为 Markdown，用小模型根据 prompt 提取信息。

**行为特点**：
- HTTP 自动升级为 HTTPS
- 大页面截断后处理
- 15 分钟缓存
- 跨域重定向返回信息而非跟随
- User-Agent 以 `Claude-User` 开头
- **有损设计**：提取 prompt 决定 Claude 看到什么

### WebSearch

通过 Anthropic 搜索后端执行查询，返回标题和 URL（不抓取页面）。

- 每次调用最多 8 次后端搜索
- 支持 `allowed_domains` / `blocked_domains` 限定范围
- 不可用于 Amazon Bedrock

### CronCreate / CronDelete / CronList

会话级定时任务管理。任务在 `--resume` 或 `--continue` 时恢复（如未过期）。

### TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop

交互模式下的任务管理系统。

### TodoWrite

非交互模式和 Agent SDK 中的任务清单管理。交互模式使用 Task* 系列工具。

### EnterPlanMode / ExitPlanMode

规划模式切换。进入后 Claude 分析和设计方案而不编辑文件。ExitPlanMode 提交计划供审批。

### EnterWorktree / ExitWorktree

Git worktree 隔离。创建独立工作树或切换到已有工作树。不可用于子代理。

### PushNotification

发送桌面通知。连接 Remote Control 时可推送到手机。不可用于 Bedrock/Vertex/Foundry。

### SendMessage / TeamCreate / TeamDelete

Agent Team 协作工具。需要 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。

### RemoteTrigger

管理 claude.ai 上的 Routines。需要 Pro/Max/Team/Enterprise 计划。

### ToolSearch

当 tool search 启用时，搜索并加载延迟注册的 MCP 工具。

---

## SDK 中的工具配置

### 权限模式（Permission Modes）

通过 `permissionMode` 控制工具审批行为：

| 模式 | 行为 |
|------|------|
| `default` | 未匹配的工具触发 `canUseTool` 回调 |
| `dontAsk` | 未预批准的工具直接拒绝，不调用回调 |
| `acceptEdits` | 文件编辑和文件系统操作自动批准 |
| `bypassPermissions` | 所有工具无提示运行（**危险**） |
| `plan` | 只读工具可用，不编辑文件 |
| `auto` | 模型分类器决定批准/拒绝（仅 TypeScript） |

```typescript
// 设置权限模式
const options = {
  permissionMode: "acceptEdits",
  allowedTools: ["mcp__weather__*"],
  disallowedTools: ["Bash"]
};
```

### 权限评估顺序

1. **Hooks** — 可直接拒绝或放行
2. **Deny rules** — `disallowedTools` + settings.json deny 规则
3. **Permission mode** — `bypassPermissions` 在此步批准所有
4. **Allow rules** — `allowedTools` + settings.json allow 规则
5. **canUseTool callback** — 以上都未决定时调用

### 工具可用性控制（tools 选项）

`tools` 选项控制哪些内置工具出现在 Claude 上下文中（与权限是不同层面）：

```typescript
// 只保留 Read 和 Grep，移除所有其他内置工具
const options = { tools: ["Read", "Grep"] };

// 移除所有内置工具，只用自定义 MCP 工具
const options = { tools: [] };
```

| 选项 | 层面 | 效果 |
|------|------|------|
| `tools: ["Read", "Grep"]` | 可用性 | 只有列出的内置工具在上下文中 |
| `tools: []` | 可用性 | 移除所有内置工具 |
| `allowedTools` | 权限 | 列出的工具免提示运行 |
| `disallowedTools` | 权限 | 列出的工具始终被拒绝 |

### 自定义工具（Custom Tools via MCP）

通过 SDK 内置 MCP 服务器定义自定义工具：

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const getTemperature = tool(
  "get_temperature",                              // 工具名称
  "Get the current temperature at a location",    // 描述（Claude 据此决定何时调用）
  {
    latitude: z.number().describe("Latitude"),    // 输入 schema（Zod）
    longitude: z.number().describe("Longitude")
  },
  async (args) => {                               // Handler
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m`);
    const data: any = await res.json();
    return {
      content: [{ type: "text", text: `Temperature: ${data.current.temperature_2m}°C` }]
    };
  }
);

const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [getTemperature]
});
```

**调用自定义工具**：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "What's the temperature in San Francisco?",
  options: {
    mcpServers: { weather: weatherServer },
    allowedTools: ["mcp__weather__get_temperature"]  // 格式: mcp__{server}__{tool}
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

### 工具注解（Tool Annotations）

可选元数据，描述工具行为特征：

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `readOnlyHint` | `false` | 不修改环境，可与其他只读工具并行调用 |
| `destructiveHint` | `true` | 可能执行破坏性更新 |
| `idempotentHint` | `false` | 相同参数重复调用无额外效果 |
| `openWorldHint` | `true` | 访问进程外部系统 |

```typescript
tool(
  "get_temperature",
  "Get the current temperature",
  { latitude: z.number(), longitude: z.number() },
  async (args) => ({ content: [{ type: "text", text: "..." }] }),
  { annotations: { readOnlyHint: true } }  // 允许并行调用
);
```

### 工具搜索（Tool Search）

当工具数量多时（>30），tool search 按需发现和加载工具，避免上下文膨胀：

```typescript
const options = {
  mcpServers: {
    "enterprise-tools": { type: "http", url: "https://tools.example.com/mcp" }
  },
  allowedTools: ["mcp__enterprise-tools__*"],
  env: { ENABLE_TOOL_SEARCH: "auto:5" }  // 工具定义超过上下文 5% 时激活
};
```

| ENABLE_TOOL_SEARCH 值 | 行为 |
|------------------------|------|
| _(未设置)_ | 默认开启，按需发现 |
| `true` | 强制开启 |
| `auto` | 工具定义超过上下文 10% 时激活 |
| `auto:N` | 自定义百分比阈值 |
| `false` | 关闭，所有工具定义每轮加载 |

限制：最多 10,000 工具；每次搜索返回 3-5 个；需要 Sonnet 4+ 或 Opus 4+。

### 错误处理

自定义工具的错误处理决定 agent loop 是否继续：

| 情况 | 结果 |
|------|------|
| Handler 抛出未捕获异常 | Agent loop 停止，query 调用失败 |
| Handler 返回 `isError: true` | Agent loop 继续，Claude 看到错误并可重试 |

```typescript
async (args) => {
  try {
    const res = await fetch(args.endpoint);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `API error: ${res.status}` }],
        isError: true  // Claude 看到错误，可以重试或换方案
      };
    }
    return { content: [{ type: "text", text: await res.text() }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Failed: ${error.message}` }],
      isError: true  // 保持 agent loop 存活
    };
  }
}
```

### 返回非文本内容

Handler 的 `content` 数组支持三种 block 类型：

**Text**：
```typescript
{ type: "text", text: "Hello world" }
```

**Image**（base64 编码）：
```typescript
{ type: "image", data: base64String, mimeType: "image/png" }
```

**Resource**（带 URI 标识的内容）：
```typescript
{
  type: "resource",
  resource: {
    uri: "file:///tmp/report.md",
    mimeType: "text/markdown",
    text: "# Report\n..."
  }
}
```

**Structured Content**（机器可读 JSON，与 content 并行返回）：
```typescript
return {
  content: [{ type: "image", data: chartPng, mimeType: "image/png" }],
  structuredContent: {
    series: "temperature_2m",
    points: [62.1, 63.4, 65.0]
  }
};
```

---

## 安全最佳实践

1. **从 `default` 模式开始**，逐步放宽到 `acceptEdits`
2. **用 `disallowedTools` 硬性禁止**危险工具（在 `bypassPermissions` 下仍生效）
3. **启用沙箱**隔离 Bash 的文件系统/网络访问
4. **保护敏感路径**：deny 规则覆盖 `.env`、密钥文件、关键配置
5. **限制子代理工具集**：通过 `tools` frontmatter 缩小范围
6. **用 hooks 添加自定义逻辑**：PreToolUse hook 可在工具执行前拦截
7. **`bypassPermissions` 仅用于隔离容器/VM**
8. **自定义工具返回 `isError: true`** 而非抛异常，保持 agent loop 存活
9. **大量工具时启用 tool search**，避免上下文膨胀
10. **审计 WebFetch 域名**和后台任务

---

## 受保护路径

以下路径的写入永远不会被自动批准（`bypassPermissions` 除外）：

**目录**：`.git`、`.vscode`、`.idea`、`.husky`、`.claude`

**文件**：`.gitconfig`、`.gitmodules`、`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.ripgreprc`、`.mcp.json`、`.claude.json`

---

## 相关文档

- [CronCreate 工具详解](./croncreate-tool.md)
- [Agent 工具详解](../claude-code-api/agent-tool-reference.md)
- [AskUserQuestion 工具详解](../claude-code-api/ask-user-question.md)
- [query() Options 参考](../sdk/query-options-reference.md)
