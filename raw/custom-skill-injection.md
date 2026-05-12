# 自定义 Skill 注入方式与注意事项

通过 24 组变量控制实验，完整验证了 Claude Code SDK 中 `tools`、`settingSources`、`cwd`、`additionalDirectories`、`skills`、`CLAUDE_CONFIG_DIR` 六个参数对 skill 注入的影响。

## 实验矩阵总结

### 基础矩阵（Case 1-8）

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

### settingSources 细粒度矩阵（Case 9-13）

| Case | settingSources | cwd | additionalDirs | 用户级 skill | 项目级 skill | 结论 |
|------|----------------|-----|----------------|:---:|:---:|------|
| 9 | `['user']` | 有 skill | 无 | ✅ | ❌ | 只加载用户级，项目级不加载 |
| 10 | `['project']` | 有 skill | 无 | ❌ | ✅ | 只加载项目级，用户级不加载 |
| 11 | `['local']` | 有 skill | 无 | ❌ | ❌ | local 不控制任何 skill 加载 |
| 12 | `['user','project']` | 有 skill | 无 | ✅ | ✅ | 两者都加载，等同于默认 |
| 13 | `['project']` | 空目录 | 有 skill | ❌ | ✅ | additionalDirectories 走 project 通道 |

### `skills` 选项过滤矩阵（Case 14-19）

| Case | skills | settingSources | cwd | 可见 skill | 结论 |
|------|--------|----------------|-----|-----------|------|
| 14 | `'all'` | 默认 | 有 skill | 全部（用户级+项目级+bundled） | 等同于不设 skills |
| 15 | `['greet']` | 默认 | 有 skill | 仅 greet | 精确过滤，其他全部隐藏 |
| 16 | `['greet','joke']` | 默认 | 有 skill | 仅 greet + joke | 多个指定 skill 都出现 |
| 17 | `['greet']` | `[]` | 有 skill | 无 | skills 依赖 settingSources 先发现，发现不了则过滤无效 |
| 18 | `['loop']` | 默认 | 有 skill | 仅 loop | 可以精确选择 bundled skill |
| 19 | `[]` | 默认 | 有 skill | 无（Skill 工具仍存在但列表为空） | 空数组禁用所有 skill 列表 |

### `CLAUDE_CONFIG_DIR` 环境变量矩阵（Case 20-24）

| Case | CLAUDE_CONFIG_DIR | settingSources | cwd | skills | 可见 skill | 结论 |
|------|-------------------|----------------|-----|--------|-----------|------|
| 20 | 有 skill 的目录 | `['user']` | 空 | 不设置 | config 目录的 greet+joke | 替代了 ~/.claude/skills/ |
| 21 | 空目录 | `['user']` | 空 | 不设置 | 无 | 空 config 无 skill 可发现 |
| 22 | 有 skill 的目录 | `[]` | 空 | 不设置 | 无 | settingSources=[] 仍然阻止 |
| 23 | 有 skill 的目录 | `['user','project']` | 有 skill | 不设置 | 两边叠加(greet×2) | CONFIG_DIR 和 cwd 不去重 |
| 24 | 有 skill 的目录 | `['user']` | 空 | `['greet']` | 仅 greet | 完整隔离方案验证通过 |

## 各参数独立作用

### `tools`

控制模型可用的工具集。

| 值 | 效果 |
|---|---|
| `[]` | 无任何工具，Skill 工具不存在，skill 列表不注入 |
| `['Skill']` | 仅 Skill 工具，skill 列表正常注入 |
| 不设置（默认） | 全量工具（Bash、Read、Edit、Skill 等），skill 列表正常注入 |

### `settingSources`

控制 settings 系统的加载来源。类型定义：`SettingSource = 'user' | 'project' | 'local'`

| 值 | 用户级 skill | 项目级 skill | additionalDirs skill | bundled skills |
|---|:---:|:---:|:---:|:---:|
| 不设置（默认） | ✅ | ✅ | ✅ | ✅ |
| `['user', 'project']` | ✅ | ✅ | ✅ | ✅ |
| `['user']` | ✅ | ❌ | ❌ | ✅ |
| `['project']` | ❌ | ✅ | ✅ | ✅ |
| `['local']` | ❌ | ❌ | ❌ | ✅ |
| `[]` | ❌ | ❌ | ❌ | ✅ |

**关键发现**：

1. `'user'` 控制 `~/.claude/skills/` 的加载
2. `'project'` 控制 `cwd/.claude/skills/` **和** `additionalDirectories` 中 `.claude/skills/` 的加载
3. `'local'` 不控制任何 skill 加载（只影响 `.claude/settings.local.json`）
4. bundled skills 始终存在，不受 settingSources 影响
5. `additionalDirectories` 的 skill 归属于 `'project'` 通道，不是独立通道

### `cwd`

SDK 进程的工作目录。进程启动后扫描 `cwd/.claude/skills/` 发现项目级 skill。

| 值 | 效果 |
|---|---|
| 含 `.claude/skills/` 的目录 | 该目录下的 skill 被发现并注入 |
| 空目录 / 无 `.claude/skills/` | 无项目级 skill |

### `additionalDirectories`

额外目录，其中的 `.claude/skills/` 也会被扫描。

| 值 | 效果 |
|---|---|
| 含 `.claude/skills/` 的目录数组 | 该目录下的 skill 被发现并注入 |
| 不设置 | 无额外 skill 来源 |

**注意**：additionalDirectories 的 skill 加载受 `settingSources` 中 `'project'` 的控制。如果 settingSources 不包含 `'project'`，additionalDirectories 的 skill 也不会被加载。

### `CLAUDE_CONFIG_DIR`（环境变量）

覆盖 `~/.claude` 配置根目录。设置后，用户级 skill 从 `$CLAUDE_CONFIG_DIR/skills/` 加载，而非 `~/.claude/skills/`。

| 值 | 效果 |
|---|---|
| 不设置 | 默认使用 `~/.claude/skills/` |
| 指向有 `skills/` 的目录 | 该目录的 skill 替代用户级 skill |
| 指向空目录 | 无用户级 skill |

**关键发现**：

1. `CLAUDE_CONFIG_DIR` 完全替换了 `~/.claude`，不是追加。原始 `~/.claude/skills/` 不再被扫描
2. 仍然受 `settingSources` 控制：`settingSources: []` 会阻止即使 `CLAUDE_CONFIG_DIR` 有 skill
3. 与 `cwd` 的 skill 叠加不去重（同名 skill 出现两次）
4. 通过 SDK 的 `env` 选项传入：`env: { CLAUDE_CONFIG_DIR: '/path/to/config' }`

### `skills`

控制哪些已发现的 skill 对模型可见。类型定义：`skills?: string[] | 'all'`

| 值 | 效果 |
|---|---|
| 不设置（默认） | 不做过滤，所有已发现的 skill 都可见 |
| `'all'` | 等同于不设置，所有已发现的 skill 都可见 |
| `['greet', 'joke']` | 只有指定的 skill 可见，其他全部隐藏（包括 bundled） |
| `['loop']` | 可以精确选择 bundled skill |
| `[]` | 禁用所有 skill 列表（Skill 工具仍存在但无可用 skill） |

**关键发现**：

1. `skills` 是一个**过滤器**，不是加载器。它只能从已发现的 skill 中筛选，不能凭空创建
2. `skills` 依赖 `settingSources` 先完成 skill 发现。如果 `settingSources: []` 导致 skill 未被发现，`skills: ['greet']` 也无法让 greet 出现
3. `skills: []` 不会移除 Skill 工具本身，只是让 skill 列表为空
4. 可以混合选择自定义 skill 和 bundled skill：`skills: ['greet', 'loop']`

## 重要发现

### 1. 同名 skill 不去重，叠加出现

当 `cwd` 和 `additionalDirectories` 都包含同名 skill（如 `greet`）时，该 skill 在 system-reminder 中**出现两次**。SDK 不做去重处理。

### 2. Skill 来源的完整加载顺序

system-reminder 中的 skill 列表按以下顺序出现：

1. **用户级 skill**（`$CLAUDE_CONFIG_DIR/skills/` 或 `~/.claude/skills/`）— 需要 settingSources 包含 `'user'`
2. **项目级 skill**（`cwd/.claude/skills/`）— 需要 settingSources 包含 `'project'`
3. **additionalDirectories 的 skill** — 需要 settingSources 包含 `'project'`
4. **bundled skills**（内置）— 始终存在

### 3. `settingSources` 各值的语义

```typescript
type SettingSource = 'user' | 'project' | 'local';
```

| 值 | 对应文件 | 控制的 skill 来源 |
|---|---|---|
| `'user'` | `~/.claude/settings.json` | `~/.claude/skills/` |
| `'project'` | `.claude/settings.json` | `cwd/.claude/skills/` + `additionalDirectories` 的 skill |
| `'local'` | `.claude/settings.local.json` | 无（不影响 skill） |

### 4. `tools: []` vs `settingSources: []` 的区别

- `tools: []`：完全移除 Skill 工具定义，模型无法调用任何 skill，system-reminder 中也不注入 skill 列表
- `settingSources: []`：Skill 工具定义仍然存在，bundled skills 仍然列出，但自定义 skill 不被发现

## 目录约定

Claude Code **只认** `.claude/skills/` 路径：

```
.claude/skills/
├── greet/
│   └── SKILL.md        # 必须有这个文件
└── joke/
    └── SKILL.md
```

其他路径（如 `.agents/skills/`）不会被扫描。

## 实际应用建议

| 场景 | 推荐配置 |
|------|------|
| 只用内置 skill，不加载任何自定义 | `tools: ['Skill']` + `settingSources: []` |
| 只加载项目级 skill（不加载用户级） | `tools: ['Skill']` + `settingSources: ['project']` |
| 只加载用户级 skill（不加载项目级） | `tools: ['Skill']` + `settingSources: ['user']` |
| 加载所有自定义 skill | `tools: ['Skill']`（不设 settingSources） |
| 从外部目录注入 skill | `additionalDirectories: [...]` + settingSources 包含 `'project'` |
| 精确指定 agent 可用的 skill | `skills: ['greet', 'joke']` + 确保 settingSources 能发现这些 skill |
| 只给 agent 一个 bundled skill | `skills: ['loop']` |
| 完全隔离：自带 skill 仓库 | `CLAUDE_CONFIG_DIR` 指向自己的目录 + `settingSources: ['user']` + `skills` 白名单 |
| 完全禁用 skill 功能 | `tools: []` 或 `skills: []` |
| 默认全量（含 skill） | 不设 `tools`，不设 `settingSources`，不设 `skills` |

### 封装 Agent 的推荐模式

#### 方案 A：用 CLAUDE_CONFIG_DIR 完全隔离 + skills 过滤

skill 通过 Skill 工具按需加载，模型调用时才注入全文。

```typescript
// 方案 A：用 CLAUDE_CONFIG_DIR 完全隔离（推荐）
query({
  prompt: userInput,
  options: {
    cwd: userWorkDir,
    env: {
      ...BASE_ENV,
      CLAUDE_CONFIG_DIR: '/your-agent/config',  // 你自己的 config 目录
      // /your-agent/config/skills/greet/SKILL.md
      // /your-agent/config/skills/joke/SKILL.md
    },
    settingSources: ['user'],              // 加载你的 config 目录的 skill
    skills: ['greet', 'joke'],             // 精确过滤，兜底保险
    tools: ['Skill'],
    persistSession: false,
  },
});
```

#### 方案 B：用 additionalDirectories 注入

```typescript
// 方案 B：用 additionalDirectories 注入
query({
  prompt: userInput,
  options: {
    cwd: userWorkDir,
    additionalDirectories: ['/your-agent/skills-dir'],  // 含 .claude/skills/
    settingSources: ['project'],           // 排除用户级，只走 project 通道
    skills: ['greet', 'joke'],             // 精确过滤
    tools: ['Skill'],
    persistSession: false,
  },
});
```

#### 方案 C：用 agent 定义精确控制工具和技能（最完整）

通过 `agent` + `agents` 定义一个完整的 agent，同时控制工具白名单和 skill 预加载。

```typescript
query({
  prompt: userInput,
  options: {
    cwd: userWorkDir,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: '/your-agent/config',
    },

    // 指定使用哪个 agent
    agent: 'my-assistant',

    // 定义 agent
    agents: {
      'my-assistant': {
        description: 'A focused assistant with specific capabilities',
        prompt: 'You are a helpful assistant. Follow skill instructions.',

        // 精确控制工具白名单
        tools: ['Skill', 'Read', 'Grep', 'Glob'],

        // 预加载 skill 全文到 agent 的 system prompt
        skills: ['greet', 'joke'],

        // 可选配置
        model: 'sonnet',
        effort: 'low',
      },
    },

    // 全局 skill 发现控制
    settingSources: ['user'],
    skills: ['greet', 'joke'],      // 全局过滤（双重保险）
    persistSession: false,
  },
});
```

### `options` 层 vs `agents[x]` 层的区别

| 维度 | `options.tools` / `options.skills` | `agents[x].tools` / `agents[x].skills` |
|------|------|------|
| 作用域 | 全局（整个会话） | 仅该 agent |
| tools 语义 | 可用工具的基础集 | agent 可用的工具白名单 |
| skills 语义 | 过滤可见 skill 列表 | **预加载** skill 全文到 agent 的 system prompt |
| 加载时机 | 模型调用 Skill 工具时才加载全文 | agent 启动时就注入全文 |

### Skill 预加载 vs 按需加载

| 模式 | 配置 | 行为 |
|------|------|------|
| 按需加载 | `options.skills: ['greet']` + `tools: ['Skill']` | skill 名称和描述在列表中可见，模型调用 Skill 工具时才加载全文 |
| 预加载 | `agents[x].skills: ['greet']` | skill 全文在 agent 启动时就注入 system prompt，无需调用 Skill 工具 |
| 预加载 + 无 Skill 工具 | `agents[x].skills: ['greet']` + `agents[x].tools: ['Read', 'Bash']` | skill 内容已在上下文中，agent 直接按指令执行，且无法调用其他 skill |

**最严格的控制方式**：预加载 + 不给 Skill 工具。agent 看到了 skill 的指令内容，但没有 Skill 工具去调用其他 skill：

```typescript
agents: {
  'strict-greeter': {
    description: 'Only greets, nothing else',
    prompt: 'Follow the skill instructions below exactly.',
    tools: ['Read'],              // 不给 Skill 工具
    skills: ['greet'],            // 但 greet 的 SKILL.md 全文已注入 prompt
  },
},
```

**注意执行顺序**：`CLAUDE_CONFIG_DIR`（决定用户级路径）→ `settingSources`（控制发现）→ `options.skills`（全局过滤）→ `options.tools`（工具可用性）→ `agents[x].tools`（agent 工具白名单）→ `agents[x].skills`（预加载到 prompt）。

完整管道图：

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

## 测试文件

- `test/integration/skill-injection-matrix.spec.ts` — 24 组变量控制实验
- `test/integration/fixtures/project-with-skills/.claude/skills/` — 项目级 skill fixture
- `test/integration/fixtures/additional-dir/.claude/skills/` — additionalDirectories fixture
- `test/integration/fixtures/custom-config/skills/` — CLAUDE_CONFIG_DIR fixture
- `test/integration/fixtures/empty-config/` — 空 config 目录 fixture
- 日志输出：`test/integration/tmp/skill-matrix/case-{1..24}-*/`
