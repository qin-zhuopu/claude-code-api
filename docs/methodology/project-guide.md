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

### 第三轮：文档化

1. 整理实验矩阵表格
2. 写各参数独立作用
3. 标注关键发现
4. 给出实际应用建议

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

## 参考已有测试用例

| 测试文件 | 参考价值 |
|---------|---------|
| `skill-injection-matrix.spec.ts` | 最完整的变量控制矩阵（24 cases），含分析函数模板 |
| `system-prompt-matrix.spec.ts` | systemPrompt 专项，展示如何分析 system 字段结构 |
| `tools-disabled.spec.ts` | 最简单的单一断言测试 |
| `additional-directories.spec.ts` | 展示如何用 fixture 目录做隔离测试 |

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
