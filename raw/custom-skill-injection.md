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
        ├── skills/                       # agent 自带的 skill（即 CLAUDE_CONFIG_DIR/skills/）
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

安装完成后，调用 agent 的代码：

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
        CLAUDE_CONFIG_DIR: agentDir,        // 关键：指向 agent 目录，skill 从这里加载
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

核心原理：
- `CLAUDE_CONFIG_DIR` 指向 agent 目录 → skill 从 `agentDir/skills/` 加载
- `settingSources: ['user']` → 只从 CLAUDE_CONFIG_DIR 发现 skill，隔离用户环境
- `agents[x].skills` → 预加载 skill 全文到 prompt
- `skills` 白名单 → 兜底，防止意外暴露其他 skill

## 生命周期管理

### 安装

```bash
jereh-agent install greeter                    # 从 registry 安装最新版
jereh-agent install greeter@1.2.0              # 安装指定版本
jereh-agent install ./local-agent-dir          # 从本地目录安装
```

实现逻辑：
1. 从 registry 下载 agent 包（或复制本地目录）
2. 解压到 `~/.jereh-agents/packages/<name>/`
3. 写入 `.lock` 文件记录来源、版本、hash
4. 更新 `registry.json`

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

### 重置（改乱了恢复原样）

```bash
jereh-agent reset greeter                      # 根据 .lock 中的来源和版本重新下载
```

实现逻辑：
1. 读取 `.lock` 文件获取原始来源和版本
2. 重新下载该版本
3. 覆盖当前目录（保留用户添加的 skill？或完全覆盖？可配置）

### 复制/Fork

```bash
jereh-agent fork greeter my-greeter            # 复制一份作为自己的变体
```

实现逻辑：
1. 复制 `packages/greeter/` 到 `packages/my-greeter/`
2. 修改 `manifest.json` 中的 name
3. `.lock` 标记为 `forked-from: greeter@1.2.0`

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

## 用户定制

### 向 agent 添加自己的 skill

直接在 agent 的 `skills/` 目录下创建新 skill：

```bash
mkdir -p ~/.jereh-agents/packages/greeter/skills/my-custom-skill
cat > ~/.jereh-agents/packages/greeter/skills/my-custom-skill/SKILL.md << 'EOF'
---
description: My custom addition to the greeter agent
---
Do something custom...
EOF
```

然后更新 `agent.json` 的 skills 列表和 `manifest.json` 的 skills 白名单。

### 修改 agent prompt

直接编辑 `agent.json` 的 `prompt` 字段。

### 检测是否被修改

```bash
jereh-agent status greeter
# greeter 1.2.0 (modified)
#   + skills/my-custom-skill/SKILL.md (added)
#   ~ agent.json (modified)
```

通过对比 `.lock` 中记录的文件 hash 来检测变更。

## 可行性分析

| 需求 | SDK 支持情况 | 实现方式 |
|------|:---:|------|
| 隔离 skill 发现范围 | ✅ | `CLAUDE_CONFIG_DIR` + `settingSources: ['user']` |
| 精确控制可用 skill | ✅ | `skills: [...]` 白名单过滤 |
| 精确控制可用工具 | ✅ | `tools: [...]` + `agents[x].tools` |
| 预加载 skill 到 prompt | ✅ | `agents[x].skills` |
| 自定义 agent prompt | ✅ | `agents[x].prompt` |
| 用户工作目录不受影响 | ✅ | `cwd` 独立于 `CLAUDE_CONFIG_DIR` |
| 多 agent 并存 | ✅ | 每个 agent 独立目录，调用时切换 `CLAUDE_CONFIG_DIR` |
| 安装/更新/回退 | 需自建 | registry + 版本管理（类似 npm） |
| 重置到线上版本 | 需自建 | `.lock` 文件 + 重新下载 |
| Fork/复制 | 需自建 | 目录复制 + manifest 修改 |

**结论：SDK 层面完全可行。** 需要自建的是 agent 包管理层（registry、版本控制、安装/更新命令），SDK 本身提供了足够的隔离和控制能力。

---

## 附录：实验验证数据

以下是支撑上述方案的 24 组变量控制实验结果。

### 实验矩阵总结

#### 基础矩阵（Case 1-8）

| Case | tools | settingSources | cwd | additionalDirectories | 自定义 skill | 结论 |
|------|-------|----------------|-----|----------------------|:---:|------|
| 1 基准 | `['Skill']` | 默认 | 有 skill | 无 | ✅ | 正常注入 |
| 2 | `[]` | 默认 | 有 skill | 无 | ❌ | tools 为空则无 Skill 工具，skill 列表也不注入 |
| 3 | 不设置 | 默认 | 有 skill | 无 | ✅ | 默认全量工具集包含 Skill，自定义 skill 正常出现 |
| 4 | `['Skill']` | `[]` | 有 skill | 无 | ❌ | settingSources=[] 阻止自定义 skill 发现 |
| 5 | `['Skill']` | 默认 | 空目录 | 无 | ❌ | cwd 无 .claude/skills/ 则无项目级 skill |
| 6 | `['Skill']` | 默认 | 空目录 | 有 skill | ✅ | 仅靠 additionalDirectories 即可注入 |
| 7 | `['Skill']` | 默认 | 有 skill | 有 skill | ✅(×2) | 两个来源的同名 skill **不去重，叠加出现** |
| 8 | `['Skill']` | `[]` | 有 skill | 有 skill | ❌ | settingSources=[] 同时阻止 cwd 和 additionalDirectories |

#### settingSources 细粒度矩阵（Case 9-13）

| Case | settingSources | cwd | additionalDirs | 用户级 skill | 项目级 skill | 结论 |
|------|----------------|-----|----------------|:---:|:---:|------|
| 9 | `['user']` | 有 skill | 无 | ✅ | ❌ | 只加载用户级，项目级不加载 |
| 10 | `['project']` | 有 skill | 无 | ❌ | ✅ | 只加载项目级，用户级不加载 |
| 11 | `['local']` | 有 skill | 无 | ❌ | ❌ | local 不控制任何 skill 加载 |
| 12 | `['user','project']` | 有 skill | 无 | ✅ | ✅ | 两者都加载，等同于默认 |
| 13 | `['project']` | 空目录 | 有 skill | ❌ | ✅ | additionalDirectories 走 project 通道 |

#### `skills` 选项过滤矩阵（Case 14-19）

| Case | skills | settingSources | cwd | 可见 skill | 结论 |
|------|--------|----------------|-----|-----------|------|
| 14 | `'all'` | 默认 | 有 skill | 全部（用户级+项目级+bundled） | 等同于不设 skills |
| 15 | `['greet']` | 默认 | 有 skill | 仅 greet | 精确过滤，其他全部隐藏 |
| 16 | `['greet','joke']` | 默认 | 有 skill | 仅 greet + joke | 多个指定 skill 都出现 |
| 17 | `['greet']` | `[]` | 有 skill | 无 | skills 依赖 settingSources 先发现，发现不了则过滤无效 |
| 18 | `['loop']` | 默认 | 有 skill | 仅 loop | 可以精确选择 bundled skill |
| 19 | `[]` | 默认 | 有 skill | 无（Skill 工具仍存在但列表为空） | 空数组禁用所有 skill 列表 |

#### `CLAUDE_CONFIG_DIR` 环境变量矩阵（Case 20-24）

| Case | CLAUDE_CONFIG_DIR | settingSources | cwd | skills | 可见 skill | 结论 |
|------|-------------------|----------------|-----|--------|-----------|------|
| 20 | 有 skill 的目录 | `['user']` | 空 | 不设置 | config 目录的 greet+joke | 替代了 ~/.claude/skills/ |
| 21 | 空目录 | `['user']` | 空 | 不设置 | 无 | 空 config 无 skill 可发现 |
| 22 | 有 skill 的目录 | `[]` | 空 | 不设置 | 无 | settingSources=[] 仍然阻止 |
| 23 | 有 skill 的目录 | `['user','project']` | 有 skill | 不设置 | 两边叠加(greet×2) | CONFIG_DIR 和 cwd 不去重 |
| 24 | 有 skill 的目录 | `['user']` | 空 | `['greet']` | 仅 greet | 完整隔离方案验证通过 |

### 各参数独立作用

#### `tools`

控制模型可用的工具集。

| 值 | 效果 |
|---|---|
| `[]` | 无任何工具，Skill 工具不存在，skill 列表不注入 |
| `['Skill']` | 仅 Skill 工具，skill 列表正常注入 |
| 不设置（默认） | 全量工具（Bash、Read、Edit、Skill 等），skill 列表正常注入 |

#### `settingSources`

控制 settings 系统的加载来源。类型定义：`SettingSource = 'user' | 'project' | 'local'`

| 值 | 用户级 skill | 项目级 skill | additionalDirs skill | bundled skills |
|---|:---:|:---:|:---:|:---:|
| 不设置（默认） | ✅ | ✅ | ✅ | ✅ |
| `['user', 'project']` | ✅ | ✅ | ✅ | ✅ |
| `['user']` | ✅ | ❌ | ❌ | ✅ |
| `['project']` | ❌ | ✅ | ✅ | ✅ |
| `['local']` | ❌ | ❌ | ❌ | ✅ |
| `[]` | ❌ | ❌ | ❌ | ✅ |

关键发现：
1. `'user'` 控制 `$CLAUDE_CONFIG_DIR/skills/`（或 `~/.claude/skills/`）的加载
2. `'project'` 控制 `cwd/.claude/skills/` **和** `additionalDirectories` 中 `.claude/skills/` 的加载
3. `'local'` 不控制任何 skill 加载（只影响 `.claude/settings.local.json`）
4. bundled skills 始终存在，不受 settingSources 影响

#### `cwd`

SDK 进程的工作目录。进程启动后扫描 `cwd/.claude/skills/` 发现项目级 skill。

#### `additionalDirectories`

额外目录，其中的 `.claude/skills/` 也会被扫描。归属于 `'project'` 通道。

#### `CLAUDE_CONFIG_DIR`（环境变量）

覆盖 `~/.claude` 配置根目录。设置后，用户级 skill 从 `$CLAUDE_CONFIG_DIR/skills/` 加载。

关键发现：
1. 完全替换 `~/.claude`，不是追加
2. 仍然受 `settingSources` 控制
3. 与 `cwd` 的 skill 叠加不去重

#### `skills`

控制哪些已发现的 skill 对模型可见。类型定义：`skills?: string[] | 'all'`

关键发现：
1. 是**过滤器**，不是加载器，只能从已发现的池子中筛选
2. 依赖 `settingSources` 先完成发现
3. `skills: []` 不会移除 Skill 工具本身，只是让列表为空

### Skill 注入完整管道

```
┌─────────────────────────────────────────────────────────────────┐
│ 第一步：发现（加法，做并集）                                       │
│                                                                 │
│  CLAUDE_CONFIG_DIR/skills/  ──┐                                 │
│  ~/.claude/skills/           ──┼── settingSources: ['user']     │
│                               │                                 │
│  cwd/.claude/skills/         ──┼── settingSources: ['project']  │
│  additionalDirectories       ──┘                                │
│                                                                 │
│  bundled skills ──────────────── 始终存在                        │
│                                                                 │
│                         ↓ 汇总成 skill 池子                      │
├─────────────────────────────────────────────────────────────────┤
│ 第二步：过滤（减法）                                              │
│                                                                 │
│  options.skills: ['greet', 'joke']  → 只保留指定的               │
│                                                                 │
│                         ↓ 过滤后的 skill 列表                    │
├─────────────────────────────────────────────────────────────────┤
│ 第三步：工具开关                                                  │
│                                                                 │
│  options.tools 包含 'Skill'  → 注入 Skill 工具 + skill 列表      │
│  options.tools: []           → 整个 Skill 机制关闭               │
│                                                                 │
│                         ↓                                       │
├─────────────────────────────────────────────────────────────────┤
│ 第四步：Agent 层（可选）                                          │
│                                                                 │
│  agents[x].tools: [...]      → agent 可用工具白名单              │
│  agents[x].skills: [...]     → 预加载 skill 全文到 system prompt │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### `options` 层 vs `agents[x]` 层

| 维度 | `options.tools` / `options.skills` | `agents[x].tools` / `agents[x].skills` |
|------|------|------|
| 作用域 | 全局（整个会话） | 仅该 agent |
| tools 语义 | 可用工具的基础集 | agent 可用的工具白名单 |
| skills 语义 | 过滤可见 skill 列表 | **预加载** skill 全文到 agent 的 system prompt |
| 加载时机 | 模型调用 Skill 工具时才加载全文 | agent 启动时就注入全文 |

### 目录约定

Claude Code **只认** 以下路径的 skill：
- `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`（用户级）
- `cwd/.claude/skills/<name>/SKILL.md`（项目级）
- `additionalDirectories[*]/.claude/skills/<name>/SKILL.md`（额外目录）

其他路径（如 `.agents/skills/`）不会被扫描。

### 测试文件

- `test/integration/skill-injection-matrix.spec.ts` — 24 组变量控制实验
- `test/integration/fixtures/project-with-skills/.claude/skills/` — 项目级 skill fixture
- `test/integration/fixtures/additional-dir/.claude/skills/` — additionalDirectories fixture
- `test/integration/fixtures/custom-config/skills/` — CLAUDE_CONFIG_DIR fixture
- `test/integration/fixtures/empty-config/` — 空 config 目录 fixture
- 日志输出：`test/integration/tmp/skill-matrix/case-{1..24}-*/`
