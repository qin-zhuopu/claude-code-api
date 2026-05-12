# Agent 封装与分发方案

## 设计目标

将 Claude Code SDK 的能力封装成可安装、可更新、可定制的 Agent 包。用户可以：

- 安装/卸载 agent
- 更新到新版本 / 回退到旧版本
- 微调 agent（修改 prompt、添加 skill）
- 改乱了可以重置到线上版本
- 复制一个 agent 作为自己的变体

## Agent 包目录结构

每个 agent 是一个独立目录，安装到用户本地的 agents 仓库中：

```
~/.jereh-agents/                          # agents 仓库根目录
├── registry.json                         # 已安装 agent 的注册表
└── packages/
    └── greeter/                          # agent 名称
        ├── manifest.json                 # agent 元数据（版本、描述、作者等）
        ├── agent.json                    # agent 定义（prompt、tools、skills 列表）
        ├── skills/                       # agent 自带的 skill
        │   ├── greet/
        │   │   └── SKILL.md
        │   └── joke/
        │       └── SKILL.md
        └── .lock                         # 版本锁定文件（记录来源和 hash）
```

### manifest.json

```json
{
  "name": "greeter",
  "version": "1.2.0",
  "description": "A multilingual greeting agent",
  "author": "your-team",
  "source": "https://registry.example.com/agents/greeter",
  "minSdkVersion": "0.2.130",
  "skills": ["greet", "joke"],
  "tools": ["Skill", "Read"]
}
```

### agent.json

```json
{
  "description": "Greets users in different languages and tells jokes",
  "prompt": "You are a friendly assistant. Use the greet skill when users want a greeting, and the joke skill when they want entertainment.",
  "tools": ["Skill", "Read"],
  "skills": ["greet", "joke"],
  "model": "sonnet",
  "effort": "low"
}
```

## 调用方式

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const AGENTS_ROOT = resolve(process.env.HOME || '', '.jereh-agents/packages');

function runAgent(agentName: string, prompt: string, userWorkDir: string) {
  const agentDir = resolve(AGENTS_ROOT, agentName);
  const agentDef = JSON.parse(readFileSync(resolve(agentDir, 'agent.json'), 'utf-8'));
  const manifest = JSON.parse(readFileSync(resolve(agentDir, 'manifest.json'), 'utf-8'));

  return query({
    prompt,
    options: {
      cwd: userWorkDir,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: agentDir,        // 指向 agent 目录，skill 从这里加载
      },
      agent: agentName,
      agents: {
        [agentName]: {
          description: agentDef.description,
          prompt: agentDef.prompt,
          tools: agentDef.tools,
          skills: agentDef.skills,          // 预加载到 system prompt
          model: agentDef.model,
          effort: agentDef.effort,
        },
      },
      settingSources: ['user'],             // 从 CLAUDE_CONFIG_DIR/skills/ 发现
      skills: manifest.skills,              // 全局过滤白名单（兜底）
      tools: manifest.tools,                // 全局工具限制
      persistSession: false,
    },
  });
}

// 使用
const result = runAgent('greeter', '用法语跟我打招呼', process.cwd());
```

### 核心原理

| 参数 | 值 | 作用 |
|------|---|------|
| `CLAUDE_CONFIG_DIR` | agent 目录 | skill 从 `agentDir/skills/` 加载，隔离用户 `~/.claude` |
| `settingSources` | `['user']` | 只从 CLAUDE_CONFIG_DIR 发现 skill |
| `agents[x].skills` | `['greet', 'joke']` | 预加载 skill 全文到 system prompt |
| `skills` | `['greet', 'joke']` | 全局白名单兜底 |
| `tools` | `['Skill', 'Read']` | 全局工具限制 |
| `cwd` | 用户工作目录 | 不影响 skill 发现（settingSources 没包含 'project'） |

### 隔离效果

- ✅ 用户的 `~/.claude/skills/` 被完全屏蔽
- ✅ 用户项目的 `.claude/skills/` 不会混入
- ✅ 只有 agent 自带的 skill 可见
- ✅ `skills` 白名单做最后兜底

## 生命周期管理

### 安装

```bash
jereh-agent install greeter                    # 从 registry 安装最新版
jereh-agent install greeter@1.2.0              # 安装指定版本
jereh-agent install ./local-agent-dir          # 从本地目录安装
```

实现：从 registry 下载 → 解压到 `packages/<name>/` → 写入 `.lock` → 更新 `registry.json`

### 更新

```bash
jereh-agent update greeter                     # 更新到最新版
jereh-agent update greeter@2.0.0               # 更新到指定版本
```

### 回退

```bash
jereh-agent rollback greeter                   # 回退到上一个版本
jereh-agent install greeter@1.0.0              # 安装旧版本覆盖
```

### 重置

```bash
jereh-agent reset greeter                      # 根据 .lock 重新下载，恢复原样
```

读取 `.lock` 中的来源和版本 → 重新下载 → 覆盖当前目录。

### 复制/Fork

```bash
jereh-agent fork greeter my-greeter            # 复制一份作为自己的变体
```

复制目录 → 修改 manifest.json 的 name → `.lock` 标记 `forked-from: greeter@1.2.0`

### 卸载

```bash
jereh-agent uninstall greeter
```

### 列出已安装

```bash
jereh-agent list
# greeter    1.2.0   (from registry)
# my-greeter 1.2.0   (forked from greeter@1.2.0, modified)
```

### 变更检测

```bash
jereh-agent status greeter
# greeter 1.2.0 (modified)
#   + skills/my-custom-skill/SKILL.md (added)
#   ~ agent.json (modified)
```

通过对比 `.lock` 中记录的文件 hash 来检测变更。

## 用户定制

### 向 agent 添加自己的 skill

```bash
mkdir -p ~/.jereh-agents/packages/greeter/skills/my-skill
# 编辑 SKILL.md ...
# 更新 agent.json 和 manifest.json 的 skills 列表
```

### 修改 agent prompt

直接编辑 `agent.json` 的 `prompt` 字段。

### 改乱了恢复

```bash
jereh-agent reset greeter    # 完全恢复到线上版本
```

如果只想保留自己加的 skill：
```bash
jereh-agent reset greeter --keep-added    # 恢复原始文件，保留新增的 skill
```

## 可行性总结

| 需求 | SDK 支持 | 实现方式 |
|------|:---:|------|
| 隔离 skill 发现范围 | ✅ | `CLAUDE_CONFIG_DIR` + `settingSources: ['user']` |
| 精确控制可用 skill | ✅ | `skills: [...]` 白名单 |
| 精确控制可用工具 | ✅ | `tools: [...]` + `agents[x].tools` |
| 预加载 skill 到 prompt | ✅ | `agents[x].skills` |
| 自定义 agent prompt | ✅ | `agents[x].prompt` |
| 用户工作目录不受影响 | ✅ | `cwd` 独立于 `CLAUDE_CONFIG_DIR` |
| 多 agent 并存 | ✅ | 每个 agent 独立目录 |
| 安装/更新/回退 | 自建 | registry + 版本管理 |
| 重置到线上版本 | 自建 | `.lock` + 重新下载 |
| Fork/复制 | 自建 | 目录复制 |

**结论：SDK 层面完全可行。** 需要自建的是 agent 包管理层（registry、版本控制、CLI 命令），SDK 本身提供了足够的隔离和控制能力。

## 相关文档

- [raw/custom-skill-injection.md](./custom-skill-injection.md) — 24 组变量控制实验的详细数据
- [raw/skill-tool-prompt-structure.md](./skill-tool-prompt-structure.md) — Skill 工具对 API 请求结构的影响分析
