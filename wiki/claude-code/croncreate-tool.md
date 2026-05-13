# CronCreate 工具详解

**来源**: Anthropic Claude Code 官方文档 + 本地测试验证  
**更新**: 2026-05-12

---

## 概述

`CronCreate` 是 Claude Code 中的定时任务调度工具，用于在当前会话中创建周期性或一次性提示任务。任务与会话绑定，在未过期的情况下可通过 `--resume` 或 `--continue` 恢复。

与 `CronList` 和 `CronDelete` 共同构成完整的定时任务系统。

---

## 工具签名

```typescript
{
  name: "CronCreate",
  description: "在未来时间点排队执行提示。支持周期性调度和一次性提醒。返回可用于 CronDelete 取消任务的作业 ID。",
  input_schema: {
    type: "object",
    properties: {
      cron: {
        type: "string",
        description: "标准 5 字段 cron 表达式（本地时区）：M H DoM Mon DoW（如 '*/5 * * * *' = 每 5 分钟，'30 14 28 2 *' = 2月28日下午2:30本地时间单次执行）"
      },
      prompt: {
        type: "string",
        description: "每次触发时执行的提示。自主循环使用字面量 sentinel '<<autonomous-loop>>'，运行时解析回 autonomous-loop 指令。"
      },
      recurring: {
        type: "boolean",
        description: "true（默认）= 每个 cron 匹配时间触发，直到删除或 7 天自动过期；false = 下次匹配触发一次后自动删除。用于'提醒我'类一次性任务。"
      },
      durable: {
        type: "boolean",
        description: "true = 持久化到 .claude/scheduled_tasks.json 并跨重启存活；false（默认）= 仅内存存储，Claude 退出时消失。仅在用户明确要求持久化时使用。"
      }
    },
    required: ["cron", "prompt"]
  }
}
```

---

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cron` | string | 是 | - | 5 字段 cron 表达式（分 时 日 月 周），使用用户本地时区 |
| `prompt` | string | 是 | - | 定时执行的提示内容。自主模式使用 `<<autonomous-loop>>` |
| `recurring` | boolean | 否 | true | true=重复执行直到删除/过期；false=一次执行后自动删除 |
| `durable` | boolean | 否 | false | true=写入磁盘跨重启存活；false=仅会话期间有效 |

---

## Cron 表达式格式

标准 vixie-cron 5 字段语法：`分钟 小时 日期 月份 星期`

- 所有字段支持 `*`（通配符）、单值（`5`）、步长（`*/15`）、范围（`1-5`）、列表（`1,15,30`）
- 星期：`0` 或 `7`=周日，`1-6`=周一至周六
- **本地时区解释**（无 UTC 转换）
- **不支持**扩展语法（L, W, ?, MON, JAN 等别名）

### 常用示例

| 表达式 | 含义 |
|--------|------|
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时整点 |
| `7 * * * *` | 每小时第 7 分钟（避免整点抖动） |
| `0 9 * * *` | 每天上午 9 点（本地时间） |
| `0 9 * * 1-5` | 工作日上午 9 点 |
| `30 14 28 2 *` | 2月28日下午2:30（一次性需设 recurring=false） |
| `57 8 * * *` | 每天8:57（精确时间，避开整点抖动） |

---

## 使用模式

### 1. 固定间隔调度（通过 /loop）

```bash
/loop 5m 检查部署是否完成并告诉我结果
```

Claude 自动转换为 cron 表达式并创建任务。

### 2. 一次性提醒

```text
remind me at 3pm to push the release branch
in 45 minutes, check whether the integration tests passed
```

Claude 固定到具体的分钟/小时，并设置 `recurring: false`。

### 3. 自主循环（动态间隔）

```bash
/loop check whether CI passed and address any review comments
```

省略间隔让 Claude 根据观察动态选择延迟（1分钟-1小时）。为提高效率可能使用 Monitor 工具而非 cron。

### 4. 内置维护提示

```bash
/loop
```

运行默认提示：继续未完成工作、处理 PR、运行清理。可通过 `.claude/loop.md` 自定义。

---

## 运行时行为

### 调度引擎

- 每秒检查到期任务
- 在回合之间低优先级排队提示（**不在响应中途**）
- 所有时间使用用户本地时区
- 应用抖动避免 API 请求雷鸣群效应：
  - **周期任务**：延迟最多30分钟（或超过每小时任务的一半间隔）
  - **单次任务**：整点/半点时间最多提前90秒触发

### 会话作用域

- 仅在当前对话中存活
- 新会话启动时停止
- 通过 `--resume`/`--continue` 恢复（条件如下）：
  - **周期任务**：创建于7天内
  - **单次任务**：预定时间未到
- 每会话最多50个任务

### 7天自动过期

- 周期任务创建7天后自动删除
- 删除前会触发最后一次
- 限制遗忘循环的运行时间；需更长时间需重新创建

### 持久化任务

- `durable: true` 时写入 `.claude/scheduled_tasks.json`
- 跨会话重启存活（非会话终止）
- 恢复时删除已错过的单次任务
- 临时循环建议使用会话级（`durable: false`）

---

## 抖动规则（避免:00和:30）

调度器添加确定性偏移：

1. **周期任务**：在预定时间后最多30分钟触发（或更频繁任务的一半间隔）
   - 示例：`0 9 * * *` 可能触发于9:00-9:30之间
   - 相同ID=相同偏移（确定性）
   - **解决方案**：使用 `3 9 * * *`（上午9:03）获得精确时间

2. **单次任务**：`:00`/`:30` 时间最多提前90秒触发
   - **解决方案**：使用非整分钟时间如 `14 15`（下午3:14）

---

## 与其他工具集成

| 工具 | 关系 |
|------|------|
| `CronList` | 列出所有计划任务（含ID、调度、提示） |
| `CronDelete` | 通过 CronCreate 返回的ID取消任务 |
| `Monitor` | 事件驱动工作流的替代方案（流式输出） |
| `/loop` | 封装 CronCreate 的常用场景捆绑技能 |
| `/goal` | 基于条件的逐回合循环（非间隔基） |

---

## 平台限制

| 平台 | 定时任务 | 备注 |
|------|----------|------|
| Anthropic API | 完整 | 所有功能可用 |
| Amazon Bedrock | **不可用** | 定时任务功能禁用 |
| Google Vertex AI | 部分 | 动态循环回退到10分钟固定间隔 |
| Microsoft Foundry | 部分 | 动态循环回退到10分钟固定间隔 |

---

## 环境变量

- `CLAUDE_CODE_DISABLE_CRON=1` - 完全禁用调度器
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` - 代理相关调度所需

---

## 错误处理

- 错过的触发**无追赶**（Claude空闲时单次触发）
- 后台Bash/监控任务**永不恢复**
- 无效cron表达式导致立即工具失败

---

## 最佳实践

1. **快速轮询使用 `/loop`** - 比原始 CronCreate 更简单
2. **选择非整分钟时间** - 避免抖动（如 `7 * * * *` 而非 `0 * * * *`）
3. **优先动态间隔** - 精确时间不重要时让Claude选择
4. **单次提醒设 `recurring: false`** - 自动清理
5. **临时循环避免持久化** - 仅在明确要求时使用 durable
6. **用 `/tasks` 检查** - 列出活动任务避免遗忘循环
7. **按 `Esc` 停止** - 仅清除 `/loop` 的待处理唤醒

---

## 与替代方案对比

| 特性 | `/loop` (CronCreate) | Routines | 桌面任务 |
|------|---------------------|----------|----------|
| 作用域 | 会话 | 云端 | 本机 |
| 需要会话打开 | 是 | 否 | 否 |
| 最小间隔 | 1分钟 | 1小时 | 1分钟 |
| 持久性 | Resume恢复 | 永久 | 永久 |
| 本地文件访问 | 是 | 否（新克隆） | 是 |
| MCP服务器 | 继承 | 每任务配置 | 配置文件 |
| 权限提示 | 继承 | 无 | 可配置 |

---

## SDK 使用示例

### 创建周期任务

```typescript
import { createAgent } from '@anthropic-ai/agent-sdk';

const agent = createAgent({
  prompt: 'Check CI status every 5 minutes',
  tools: {
    CronCreate: {
      allowed: true,
    },
  },
});

// 通过自然语言触发
await agent.query('Set up a loop to check CI every 5 minutes');
```

### 创建一次性提醒

```typescript
await agent.query({
  prompt: 'Remind me at 3pm to push the release branch',
  tools: ['CronCreate'],
});
```

---

## 相关文档

- [Claude Code 定时任务文档](https://docs.anthropic.com/en/docs/claude-code/scheduled-tasks)
- [工具参考](https://docs.anthropic.com/en/docs/claude-code/tools-reference)
- [Routines（云端定时任务）](https://docs.anthropic.com/en/docs/claude-code/routines)
- [桌面定时任务](https://docs.anthropic.com/en/docs/claude-code/desktop-scheduled-tasks)
