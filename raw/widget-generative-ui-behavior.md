# Widget 生成式 UI — LLM 遵循性观察

> Sources: claude-code-api 观察性测试, 2026-05-19
> 测试文件: `test/integration/widget-generative-ui.spec.ts`

## 核心发现摘要

| 发现 | 结论 | 影响 |
|------|------|------|
| **格式遵循不稳定** | 同一 prompt 不同次运行，LLM 有时输出 `show-widget` 有时输出 ` ```html ` | 生产环境不可靠 |
| **无提示 → 不输出** | 没有 WIDGET_SYSTEM_PROMPT 时，LLM 绝不输出 show-widget | ✅ 系统提示是必要条件 |
| **Chart 场景最差** | 即使注入完整 chart 指南，LLM 仍倾向于输出 ` ```html ` | 需要格式强化策略 |
| **Diagram/Art 可行** | SVG 类型的 widget 遵循率较高（~50%）| 纯字符串嵌入比 Chart.js 简单 |
| **多 widget 能力** | LLM 能输出多个独立 `show-widget` 围栏 | ✅ 规则 8 可被遵循 |
| **JSON 完整性问题** | LLM 经常输出不完整的 JSON（未关闭外层 `}`）| 需要宽松解析器 |
| **字符限制常超标** | widget_code 经常超过 3000 字符限制 | 需要截断策略 |
| **内容指南被学习** | 即使格式不对，LLM 也遵循了色板、CDN 白名单等设计规则 | ✅ 指南内容有效 |

---

## 实验矩阵

### 测试环境

- **LLM**: Jereh-LLM-NO-THINK-V1
- **端点**: http://10.1.3.115:4000
- **SDK**: `@anthropic-ai/claude-agent-sdk` via `query()`
- **工具**: 禁用 (`tools: []`)，防止 LLM 尝试执行命令
- **超时**: 180s/case

### 6 组实验

| Case | systemPrompt | prompt 主题 | 观察目标 |
|------|-------------|------------|---------|
| 1 | 无（默认 agent 身份） | 月度收入折线图 | 基线：LLM 自然输出 |
| 2 | WIDGET_SYSTEM_PROMPT + chart 指南 | 月度收入折线图 | Chart 场景遵循性 |
| 3 | WIDGET_SYSTEM_PROMPT + diagram 指南 | SDLC 流程图 | SVG diagram 遵循性 |
| 4 | WIDGET_SYSTEM_PROMPT + art 指南 | 数据流动插画 | SVG art 遵循性 |
| 5 | WIDGET_SYSTEM_PROMPT + chart + diagram | 饼图 + 时间线 | 多 widget 独立围栏 |
| 6 | 普通可视化助手 | 月度收入折线图 | 对照：无 widget 提示 |

### 结果汇总（2 轮运行对比）

| Case | Run 1 围栏数 | Run 2 围栏数 | 稳定性 |
|------|-------------|-------------|--------|
| 1 | 0 | 0 | ✅ 稳定（始终无） |
| 2 | 0 | 0 | ⚠️ 稳定但不符合期望 |
| 3 | 1 | 1 | ⚠️ 数量稳定但内容不稳定 |
| 4 | 1 | 1 | ⚠️ 数量稳定但长度超标 |
| 5 | 1 | 2 | ❌ 数量不稳定 |
| 6 | 0 | 0 | ✅ 稳定（始终无） |

---

## 详细发现

### 1. 系统提示是 show-widget 输出的必要条件

- Case 1（无提示）和 Case 6（普通提示）：**从未**输出 show-widget
- Case 2-5（含 WIDGET_SYSTEM_PROMPT）：**有时**输出 show-widget
- 结论：WIDGET_SYSTEM_PROMPT 是必要条件但非充分条件

### 2. LLM 更倾向于输出标准代码围栏

即使注入了 WIDGET_SYSTEM_PROMPT，LLM 仍然经常输出：
- ` ```html ` — Chart.js 代码（Case 2 最常见）
- ` ```python ` — matplotlib 代码（Case 1 默认行为）

这表明 LLM 对标准代码围栏的"偏好"远强于 `show-widget` 格式。

### 3. Chart.js 场景遵循率最低

Case 2 在两次运行中都**未能**输出 `show-widget` 格式：
- Run 1: ` ```html ` 包裹 Chart.js 代码
- Run 2: ` ```html ` 包裹 Chart.js 代码
- 但内容**正确使用了指南中的色板**（`#818CF8`、`#64748B`）

### 4. SVG diagram/art 场景遵循率较高

Case 3 和 Case 4 都成功输出了 `show-widget` 围栏：
- Case 3: 输出 SVG 流程图，但 JSON 格式有时不完整
- Case 4: 输出 SVG 插画，但 widget_code 超过 3000 字符限制

### 5. 多 widget 能力验证

Case 5 证明 LLM **能够**输出多个独立的 `show-widget` 围栏：
- Run 2: 2 个围栏，title 分别为 "团队技能分布" 和 "项目时间线"
- 但 Run 1 只有 1 个围栏（合并了两个图表）

### 6. JSON 完整性是主要问题

LLM 输出的 `show-widget` JSON 存在多种格式问题：

| 问题 | 频率 | 示例 |
|------|------|------|
| 外层 `}` 未关闭 | 常见 | `{"title":"...","widget_code":"...</script>" />` |
| widget_code 中未转义引号 | 偶见 | HTML 中 `onclick="..."` 未转义 |
| widget_code 超长 | 常见 | 3102 字符 vs 3000 限制 |
| JSON 后追加 `/>` | 偶见 | `</script>" />` — LLM 的 XML 习惯 |

### 7. 设计指南内容被有效学习

即使格式不正确，LLM 的输出也遵循了指南中的关键设计规则：
- ✅ 使用了指定色板（Indigo `#818CF8`、Slate `#64748B`）
- ✅ CDN 限制在白名单内（仅 `cdnjs.cloudflare.com`）
- ✅ Chart.js 代码结构正确（`responsive:true`、`maintainAspectRatio:false`）
- ✅ SVG 使用了 `viewBox="0 0 680 H"` 格式
- ✅ 使用了 `min-height` 而非固定 `height`

---

## 解析器设计经验

### 问题：标准正则无法处理 show-widget

`show-widget` 围栏内的 JSON 值包含 HTML/SVG/JS 代码，其中：
- `<script>` 标签内的 `{` `}` 会干扰花括号匹配
- HTML 属性中的 `"` 需要在 JSON 中转义
- 代码内容可能包含 `` ` `` 字符

### 解决方案：三阶段解析

1. **标记定位**：`/`{1,3}show-widget`{0,3}/` 找标记
2. **精确解析**：花括号深度 + 字符串转义感知的 `findJsonEnd()`
3. **宽松回退**：`tryRepairWidgetJson()` — 正则提取 `title` 和 `widget_code` 值

### 宽松解析策略

```typescript
// 策略1: 从最后一个 } 往前找合法 JSON
// 策略2: 从最后一个 " 往前找，补全缺失的 }
// 策略3: 正则提取 title 和 widget_code 值，重新构造 JSON
```

---

## 实际应用建议

### 1. 格式强化策略

在系统提示中**多次重复** `show-widget` 格式要求：
```
IMPORTANT: You MUST use ```show-widget fence, NOT ```html.
Format: ```show-widget\n{"title":"...","widget_code":"..."}\n```
```

### 2. 解析器必须宽松

CodePilot 的 `parseAllShowWidgets()` 已经很宽松，但可能还需要：
- 处理未关闭的 JSON 外层对象
- 处理 `/>` 后缀
- 处理 widget_code 中未转义的引号

### 3. 分类型置信度

| Widget 类型 | 格式遵循置信度 | 建议 |
|-------------|---------------|------|
| Chart.js | ~0% (低) | 需要 few-shot 示例强化 |
| SVG diagram | ~50% (中) | 可以使用，需宽松解析 |
| SVG art | ~50% (中) | 可以使用，需宽松解析 |
| 多 widget | ~50% (中) | 可以使用，数量不稳定 |

### 4. Few-shot 可能是最有效的策略

在系统提示中加入 1-2 个完整的 `show-widget` 输出示例，可能比规则描述更有效。

---

## 第二组实验：systemPrompt 模式变量

### 实验设计

固定 prompt（chart 折线图），只改变 `systemPrompt` 传入方式，观察对 `show-widget` 输出的影响。

SDK 的 `systemPrompt` 参数有 4 种用法：

| 模式 | 代码 | 实际 system 内容 |
|------|------|-----------------|
| 不设置 | 不传 `systemPrompt` | SDK 默认身份（~146 chars）|
| string 追加 | `systemPrompt: "widget 提示"` | SDK 默认身份 + widget 提示 |
| preset | `{type:'preset', preset:'claude_code'}` | 完整 Claude Code prompt（~25600 chars）|
| preset + append | `{type:'preset', preset:'claude_code', append: "widget 提示"}` | 完整 CC prompt + widget 提示（~28800 chars）|

### 结果矩阵

| Case | 模式 | system 字符数 | SDK身份 | 完整CC | Widget提示 | 围栏数 |
|------|------|-------------|---------|--------|-----------|--------|
| 7 | 不设置 | 146 | ✅ | ❌ | ❌ | **0** |
| 8 | string 追加 | 3,323 | ✅ | ❌ | ✅ | **0** |
| 9 | preset | 25,628 | ✅ | ✅ | ❌ | **0** |
| **10** | **preset + append** | **28,839** | **❌** | **✅** | **✅** | **1** ✅ |

### 核心发现

1. **Case 10 是 chart 场景唯一成功的组合！** `preset + append` 模式下 LLM 输出了合法的 `show-widget` 围栏。

2. **完整 Claude Code prompt 是关键基底。** 单纯的 string 追加（Case 8）等同于之前的 Case 2（都是 0 围栏）。加上 25000+ 字符的完整 CC prompt 后，LLM 的指令遵循能力显著增强。

3. **preset 模式会替换 SDK 默认身份。** Case 10 的 `hasSdkIdentity: false` 表明 preset 不是追加，而是用完整的 Claude Code 行为规范替换了简短的 SDK 身份声明。

4. **单独的 widget 提示不够。** Case 8 有 widget 提示但没有完整 CC prompt，LLM 仍然输出 ` ```html `。说明 widget 格式指导需要建立在强指令遵循能力的基础上。

### 实际应用建议

对于需要 LLM 遵循 `show-widget` 格式的场景：
- ❌ 不要只用 `systemPrompt: string` 追加 widget 提示
- ✅ 使用 `systemPrompt: {type:'preset', preset:'claude_code', append: widget提示}` 组合
- 原因：完整 Claude Code prompt 提供了更强的指令遵循框架

---

1. **Few-shot 强化效果**：在系统提示中加入完整示例是否能显著提高遵循率？
2. **温度参数影响**：低温度（0.1-0.3）是否能提高格式稳定性？
3. **Few-shot + chart 类型**：加了 chart 示例后 Case 2 的遵循率是否提高？
4. **流式场景**：流式输出时 widget 围栏的完整性如何？
5. **MCP 工具调用**：LLM 是否会主动调用 `codepilot_load_widget_guidelines`？
6. **长 widget_code 截断**：LLM 是否能在 3000 字符限制内有效压缩代码？
