# 本项目观察性测试实践指南

基于 [观察性测试方法论](./observational-testing.md) 在 claude-code-api 项目中的具体实践。

## 项目背景

本项目通过 `@anthropic-ai/claude-agent-sdk` 封装 Claude Code 的能力。SDK 是黑盒，很多行为文档未完整描述，需要通过观察性测试来理解。

## 调研输入来源

### SDK 类型定义

```
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

这是最权威的参数定义来源。用 `Select-String` 或 `grep_search` 搜索关键字。

### 官方文档（已本地化）

```
raw/claude-code-docs/docs/          # 官方文档的本地副本
├── skills.md                       # skill 机制
├── settings.md                     # settings 配置项
├── env-vars.md                     # 环境变量
├── scheduled-tasks.md              # /loop 等
└── ...
```

### 已有日志（历史运行数据）

```
.claude/api-bodies/                 # Claude CLI 直接调用的请求/响应
test/integration/tmp/               # 测试用例产生的请求/响应
```

### 参考项目

```
repos/CodePilot/src/lib/claude-client.ts    # JerehPilot 的 SDK 调用方式
```

## 测试用例位置与架构

### 目录结构

```
test/integration/
├── helpers.ts                              # 公共工具函数
├── fixtures/                               # 测试 fixture
│   ├── project-with-skills/                # 含 .claude/skills/ 的项目
│   │   └── .claude/skills/{greet,joke}/
│   ├── additional-dir/                     # additionalDirectories 用
│   │   └── .claude/skills/{greet,joke}/
│   ├── custom-config/                      # CLAUDE_CONFIG_DIR 用
│   │   └── skills/{greet,joke}/
│   ├── empty-project/                      # 空项目目录
│   └── empty-config/                       # 空 config 目录
├── skill-injection-matrix.spec.ts          # skill 注入矩阵（24 cases）
├── system-prompt-matrix.spec.ts            # systemPrompt 矩阵（7 cases）
├── tools-skill-only.spec.ts                # 单一工具测试
├── tools-disabled.spec.ts                  # 工具禁用测试
├── additional-directories.spec.ts          # additionalDirectories 测试
├── local-llm.spec.ts                       # 基础 LLM 连通性
└── tmp/                                    # 测试产生的日志（gitignore）
    ├── skill-matrix/case-{1..24}-*/
    ├── system-prompt/case-{1..7}-*/
    └── ...
```

### 公共工具（helpers.ts）

```typescript
// 创建带时间戳的隔离目录
createTimestampDir(subDir: string): string

// 对目录下所有 JSON 文件进行 pretty 格式化
prettyFormatJsonFiles(dir: string): void
```

### runQuery 封装

每个测试文件都需要消费 SDK 的 async iterator。建议将通用的 `runQuery` 逻辑提取到 helpers 或测试文件顶部：

```typescript
async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  tools?: any[];
  cwd?: string;
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      cwd: options.cwd,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    } as any,
  });

  let resultText = '';
  for await (const message of sdkQuery) {
    const msg = message as any;
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
      const delta = msg.event.delta;
      if (delta?.type === 'text_delta') process.stderr.write(delta.text);
    }
    if (msg.type === 'result') resultText = msg.result || '';
  }
  return resultText;
}
```

### 测试用例模板

```typescript
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'http://10.1.3.115:4000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-LLM-NO-THINK-V1',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

describe('XXX 矩阵', () => {
  it('case-N 描述', async () => {
    const dir = createTimestampDir('xxx-matrix/case-N-name');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      // ... 被测参数
    });

    const analysis = analyzeXxx(dir);
    console.error('\n[case-N]', analysis);

    expect(analysis.xxx).toBe(yyy);
    prettyFormatJsonFiles(dir);
  }, 120000);
});
```

### 关键模式

1. **OTEL_LOG_RAW_API_BODIES**：通过环境变量让 SDK 把完整请求/响应写入文件
2. **每个 case 独立目录**：`createTimestampDir('suite/case-N-name')`
3. **分析函数**：从 JSON 文件中提取结构化指标
4. **先 console.error 再 expect**：方便调试时看到实际值
5. **prettyFormatJsonFiles**：格式化 JSON 便于人工检查
6. **分析函数容错**：对 `JSON.parse` 做 try-catch，SDK 可能产出截断的 response 文件（流式中断、超时等）
7. **控制变量对比**：验证某个变量的效果时，设计「基线 case」和「变量 case」，保持其他参数完全一致。对比维度：文件数量、文件大小、特定字段的有无。文件大小相同 = 变量无效

## 日志观察方法

### 快速查看结构

```bash
# 用已有脚本
node scripts/pretty-json-keys.js <file.json>

# 对比两个请求
node scripts/compare-requests.js <file1.json> <file2.json>
```

### 批量提取指标

```powershell
# 查看所有 case 的 system prompt 大小
Get-ChildItem "test\integration\tmp\system-prompt" -Recurse -Filter "*.request.pretty.json" |
  ForEach-Object {
    $c = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $chars = ($c.system | ForEach-Object { $_.text.Length } | Measure-Object -Sum).Sum
    "$($_.Directory.Parent.Name): $chars chars"
  }
```

### 搜索特定内容

```powershell
# 在日志中搜索关键字
Select-String -Path "test\integration\tmp\**\*.request.json" -Pattern "greet|joke"
```

## 迭代优化流程

### 第一轮：探索

1. 读 SDK 类型定义，列出参数
2. 写最小测试用例（宽松断言）
3. 跑测试，看 console.error 输出
4. 检查日志文件，理解实际结构

### 第二轮：精确化

1. 根据实际数据修正断言
2. 处理意外发现（如 "string 不替换默认 prompt"）
3. 补充遗漏的用例（如 "string[] 的行为是否与 string 相同？"）
4. 确认交互效应
5. **避免精确字节数断言**：动态内容（时间戳、UUID、session 信息）导致每次运行有微小差异，用量级断言（`toBeGreaterThan`）或结构断言代替

### 第三轮：文档化

1. 整理实验矩阵表格
2. 写各参数独立作用
3. 标注关键发现
4. 给出实际应用建议

### 否定实验模式

当对比组之间无差异时，这本身就是重要发现。处理方式：

1. 明确声明「变量 X 在场景 Y 下无效」
2. 推断其实际作用域（如：仅影响 OTLP 导出，不影响 file: dump）
3. 在文档中给出「何时该用 / 何时不用」的建议
4. 用精确数据支撑结论（如：10 个 case 的 request size 完全一致 = 变量对文件内容无影响）

## 文件命名规范

### 原则

采用 `{主题}-{子主题}` 的扁平命名，不建目录层级。

- 扁平结构：文件数量可控（<30），前缀排序天然聚合同主题，vitest glob 更简单
- 测试和文档成对：每个 `.spec.ts` 对应一个 `-behavior.md`

### 命名规则

```
测试文件: test/integration/{主题}-{子主题}.spec.ts
洞察文档: raw/{主题}-{子主题}-behavior.md
设计文档: raw/{主题}-{子主题}-design.md
```

**主题**：描述被观察对象的类别，自由命名，kebab-case。例如当前已有的主题：`tool`、`query`、`otel`、`stream`、`conn`、`session`。新主题直接用，无需预注册。

**子主题**：描述具体观察对象，kebab-case。如果对应 SDK 中的标识符，保持一致（`AskUserQuestion` → `ask-user-question`）。

**深度限制**：最多两级（`{主题}-{子主题}`）。如果子主题内部还需细分，拆成独立文件而非加第三级。

### 当前文件映射

| 测试文件 | 洞察文档 |
|----------|----------|
| `tool-agent.spec.ts` | `tool-agent-behavior.md` |
| `tool-ask-user-question.spec.ts` | `tool-ask-user-question-behavior.md` |
| `otel-log-options.spec.ts` | `otel-log-options-behavior.md` |
| `conn-retry.spec.ts` | `conn-retry-behavior.md` |
| `agent-shared-mechanism.spec.ts` | `agent-shared-mechanism-behavior.md` |
| `query-user-interaction.spec.ts` | `tool-user-interaction-behavior.md` |
| `hook-pre-tool-use.spec.ts` | `hook-pre-tool-use-behavior.md` |
| `stream-event-types.spec.ts` | `stream-event-types-behavior.md` |
| `stream-ask-user-question.spec.ts` | `stream-ask-user-question-behavior.md` |
| `stream-tool-bash.spec.ts` | `stream-tool-bash-behavior.md` |
| `skill-injection-matrix.spec.ts` | `custom-skill-injection.md` *(早期文件)* |
| `system-prompt-matrix.spec.ts` | `system-prompt-options.md` *(早期文件)* |

> 早期文件保持原名，下次修改时顺手改为新规范。

## 文档输出位置

| 类型 | 位置 | 说明 |
|------|------|------|
| 调研洞察 | `raw/` | 实验数据和发现，面向开发者 |
| 设计方案 | `raw/` | 基于洞察的架构设计 |
| 方法论 | `docs/methodology/` | 可复用的方法论文档 |
| 测试用例 | `test/integration/` | 可执行的验证代码 |
| 辅助脚本 | `scripts/` | 数据提取和对比工具 |

### 已有文档索引

| 文档 | 内容 |
|------|------|
| `raw/custom-skill-injection.md` | skill 注入的 24 组实验数据 |
| `raw/system-prompt-options.md` | systemPrompt 的 7 组实验数据 |
| `raw/skill-tool-prompt-structure.md` | Skill 工具对请求结构的影响 |
| `raw/agent-packaging-design.md` | Agent 封装与分发方案设计 |
| `raw/otel-log-options-behavior.md` | OTEL 日志选项的 10 组对比实验 |
| `raw/tool-agent-behavior.md` | Agent 工具行为的观察性实验 |
| `raw/tool-ask-user-question-behavior.md` | AskUserQuestion 工具行为的双环境交叉对比实验 |
| `raw/conn-retry-behavior.md` | SDK 自动重试行为（连接失败/超时/错误时的重试策略、参数、退避算法） |
| `raw/agent-shared-mechanism-behavior.md` | CLI 与 SDK 的 Agent 共享机制（filesystem vs programmatic agent 行为差异） |
| `raw/tool-user-interaction-behavior.md` | SDK 工具-用户交互机制全景（权限确认、AskUserQuestion、MCP Elicitation、User Dialog、多轮对话） |
| `raw/hook-pre-tool-use-behavior.md` | SDK Hook PreToolUse 机制（参数获取、deny 拦截、updatedInput 修改、多 hook 优先级、master agent 直接使用） |
| `raw/stream-event-types-behavior.md` | SDK 流式事件类型全景（27 种消息类型、stream_event 内部结构、工具调用事件流、Vue3+Element Plus 渲染方案） |
| `raw/stream-ask-user-question-behavior.md` | AskUserQuestion 流式工具调用（input_json_delta 拼接、tool_result 格式、状态更新频率、Vue3+Element Plus 表单渲染方案） |
| `raw/stream-tool-bash-behavior.md` | Bash 工具流式调用（input_json_delta 拼接、成功/失败 tool_result 双格式、tool_progress 频率、Vue3+Element Plus 终端风格渲染方案） |

> 每次新增实验文档后，更新本节索引。

## 参考已有测试用例

| 测试文件 | 参考价值 |
|---------|---------|
| `skill-injection-matrix.spec.ts` | 最完整的变量控制矩阵（24 cases），含分析函数模板 |
| `system-prompt-matrix.spec.ts` | systemPrompt 专项，展示如何分析 system 字段结构 |
| `tools-disabled.spec.ts` | 最简单的单一断言测试 |
| `additional-directories.spec.ts` | 展示如何用 fixture 目录做隔离测试 |
| `otel-log-options.spec.ts` | 控制变量对比 + 否定实验 + 多轮对话（工具调用）场景 |
| `tool-agent.spec.ts` | Agent 工具测试（5 cases），含 agents 配置和 agent 会话模式 |
| `tool-ask-user-question.spec.ts` | AskUserQuestion 工具测试，含双环境交叉对比、canUseTool 回调 |
| `stream-event-types.spec.ts` | SDK 流式事件类型全景观察（6 cases），含 SSE 解析、事件分类、工具调用事件流分析 |
| `stream-ask-user-question.spec.ts` | AskUserQuestion 流式事件观察（5 cases），含 input_json_delta 拼接、tool_result 格式、SSE 前端视角 |
| `stream-tool-bash.spec.ts` | Bash 工具流式事件观察（6 cases），含成功/失败 tool_result 差异、input_json_delta 拼接、SSE 对比、permissionMode |

## 执行命令

```bash
# 跑全部集成测试
npx vitest run test/integration/

# 跑单个文件
npx vitest run test/integration/skill-injection-matrix.spec.ts

# 跑特定 case（按名称过滤）
npx vitest run test/integration/skill-injection-matrix.spec.ts -t "case-20|case-21"

# 跑所有矩阵测试
npx vitest run test/integration/ -t "case-"
```

## 注意事项

1. **超时设置**：每个测试用例设 `120000ms`（2 分钟），SDK 调用涉及网络
2. **settingSources**：测试隔离时用 `settingSources: []`，但注意这会阻止 skill 发现
3. **CLAUDE_CONFIG_DIR**：用于隔离用户级配置，但会影响 credentials
4. **日志目录**：`test/integration/tmp/` 应加入 `.gitignore`
5. **并行执行**：vitest 默认并行跑文件，同一文件内串行。矩阵测试建议放同一文件
6. **多轮对话场景**：使用会触发工具调用的 prompt（如 `Read the file ./package.json`），SDK 会自动执行工具并发起第二轮请求。`tmp/` 目录会产出多对 request/response 文件，分析函数需遍历所有 request 文件来检查 tool_result 消息
7. **Response 文件可能截断**：流式中断或超时时，response JSON 可能不完整。分析函数中 `JSON.parse` 必须 try-catch
