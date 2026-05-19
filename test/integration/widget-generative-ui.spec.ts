/**
 * Widget 生成式 UI — LLM 遵循性观察性测试
 *
 * 调研课题：本地 LLM（Jereh-LLM-NO-THINK-V1）能否按照 CodePilot Widget 规范
 * 输出合法的 `show-widget` 代码围栏。
 *
 * 核心问题：
 * 1. LLM 是否能输出 `show-widget` 代码围栏？
 * 2. 围栏内的 JSON 格式是否合法（title + widget_code）？
 * 3. LLM 是否遵循 14 条强制规则中的关键规则？
 * 4. 不同 widget 类型（chart/diagram/art）的输出质量如何？
 * 5. 多 widget 场景下能否独立围栏输出？
 *
 * 方法论：
 * - Case 1: 基线 — 仅 prompt，无 widget 系统提示（看 LLM 自然输出）
 * - Case 2: 注入 WIDGET_SYSTEM_PROMPT — chart 场景
 * - Case 3: diagram 流程图 — SVG 输出
 * - Case 4: art SVG 插画
 * - Case 5: 多 widget（饼图 + 时间线）
 * - Case 6: 对照组 — 无 widget 提示但有完整系统提示
 *
 * 断言策略：结构断言 > 内容断言
 * - 围栏存在性、JSON 可解析性、字段完整性
 * - 不断言 LLM 输出的具体文本内容
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ====== 公共配置 ======

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

// ====== Widget 系统提示（内联自 JerehPilot widget-guidelines.ts）======

const WIDGET_SYSTEM_PROMPT = `<widget-capability>
You can create interactive visualizations using the \`show-widget\` code fence.

## Format
\`\`\`show-widget
{"title":"snake_case_id","widget_code":"<raw HTML/SVG string>"}
\`\`\`

## Design specs
Call \`codepilot_load_widget_guidelines\` before your first widget to load detailed design specs.
Available modules: interactive, chart, mockup, art, diagram.

## Required rules (always apply)
1. widget_code is a JSON string — escape quotes, newlines. No DOCTYPE/html/head/body
2. Transparent background — host provides bg
3. Each widget ≤ 3000 chars. Always close JSON + fence
4. Streaming order: SVG → \`<defs>\` first; HTML → \`<style>\` → content → \`<script>\` last
5. CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh
6. CDN scripts: \`onload="initFn()"\` + \`if(window.Lib) initFn();\` fallback
7. Text explanations go OUTSIDE the code fence
8. Multi-widget: interleave text, each widget in a SEPARATE fence
9. SVG: \`<svg width="100%" viewBox="0 0 680 H">\`, arrow marker in \`<defs>\`
10. Interactive controls MUST update visuals — call \`chart.update()\` after data changes
11. Clickable drill-down: \`onclick="window.__widgetSendMessage('...')"\`
12. Title should be human-readable in the user's language (e.g. "用户参与度" not "user_engagement")
13. Use \`min-height\` instead of \`height\` for the outermost container to prevent bottom clipping
14. Cross-widget filter: \`window.__widgetPublish('topic', {key:'value'})\`. Other widgets listen via \`window.addEventListener('widget-filter', e => { /* e.detail */ })\`
</widget-capability>`;

// Chart 模块核心指南（内联）
const CHART_GUIDELINES = `## Charts (Chart.js)

\`\`\`html
<div style="position:relative;width:100%;height:300px"><canvas id="c"></canvas></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" onload="init()"></script>
<script>
var chart;
function init(){
  chart=new Chart(document.getElementById('c'),{
    type:'line',
    data:{labels:['Jan','Feb','Mar','Apr','May'],datasets:[{data:[30,45,28,50,42],borderColor:'#818CF8',backgroundColor:'rgba(129,140,248,0.1)',fill:true,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{grid:{color:'rgba(0,0,0,0.06)'}},x:{grid:{display:false}}}}
  });
}
if(window.Chart)init();
</script>
\`\`\`

## Color palette

| Ramp | 50 (fill) | 200 (stroke) | 400 (accent) | 600 (subtitle) | 800 (title) |
|------|-----------|-------------|-------------|----------------|-------------|
| Indigo | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 |
| Emerald | #ECFDF5 | #A7F3D0 | #34D399 | #059669 | #065F46 |
| Slate | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 |

- Indigo is the primary accent. Use 2-3 ramps per diagram. Slate for structural/neutral.
- Text on fills: 800 from same ramp. Never black.
- Chart.js: use 400 for borderColor, 400 with 0.1 alpha for backgroundColor

## Core Design System
- **Flat**: no gradients, shadows, blur, glow, neon. Solid fills only.
- No comments, no emoji, no position:fixed, no iframes
- No font-size below 11px
- No dark/colored backgrounds on outer containers
- No DOCTYPE/html/head/body
- CDN allowlist: cdnjs.cloudflare.com, esm.sh, cdn.jsdelivr.net, unpkg.com. No Tailwind CDN.`;

// Diagram 模块核心指南
const DIAGRAM_GUIDELINES = `## SVG setup

\`<svg width="100%" viewBox="0 0 680 H">\` — 680px fixed width. Adjust H to fit content + 40px buffer.

**Arrow marker** (required):
\`<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>\`

## Diagram type catalog

### Flowchart (process)
Nodes left→right or top→bottom. Straight arrows. Color = semantic category.
- Decision points: diamond shape or bold-bordered node
- ≤4 nodes per row

## Core Design System
- **Flat**: no gradients, shadows, blur, glow, neon. Solid fills only.
- No comments, no emoji, no position:fixed, no iframes
- No DOCTYPE/html/head/body

## Color palette
| Ramp | 50 (fill) | 200 (stroke) | 400 (accent) | 600 (subtitle) | 800 (title) |
|------|-----------|-------------|-------------|----------------|-------------|
| Indigo | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 |
| Emerald | #ECFDF5 | #A7F3D0 | #34D399 | #059669 | #065F46 |
| Slate | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 |`;

// Art 模块核心指南
const ART_GUIDELINES = `## SVG setup

\`<svg width="100%" viewBox="0 0 680 H">\` — 680px fixed width. Adjust H to fit content + 40px buffer.

**Style**: inline font styles with system-ui fallback. 13-14px labels, 11-12px subtitles. Stroke 0.5-1px borders, 1.5px arrows. rx=8-12 for nodes. One SVG per widget.

## Core Design System
- **Flat**: no gradients, shadows, blur, glow, neon. Solid fills only.
- No comments, no emoji, no position:fixed, no iframes
- No DOCTYPE/html/head/body

## Color palette
| Ramp | 50 (fill) | 200 (stroke) | 400 (accent) | 600 (subtitle) | 800 (title) |
|------|-----------|-------------|-------------|----------------|-------------|
| Indigo | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 |
| Slate | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 |`;


// ====== 核心解析工具 ======

/**
 * 从 LLM 输出文本中提取所有 show-widget 围栏内容。
 * 兼容 `` ```show-widget ... ``` `` 和 `` ````show-widget ... ```` `` 等变体。
 *
 * 策略：
 * 1. 用正则找到 show-widget 标记
 * 2. 用花括号深度匹配定位 JSON 边界（精确模式）
 * 3. 如果精确模式失败，尝试多种回退策略（宽松模式）
 */
function extractWidgetFences(text: string): string[] {
  const matches: string[] = [];
  const markerRegex = /`{1,3}show-widget`{0,3}/g;
  let markerMatch;
  while ((markerMatch = markerRegex.exec(text)) !== null) {
    const afterMarker = text.slice(markerMatch.index + markerMatch[0].length);
    const jsonStart = afterMarker.indexOf('{');
    if (jsonStart < 0) continue;

    const jsonText = afterMarker.slice(jsonStart);

    // 策略1: 精确的花括号深度匹配
    const jsonEnd = findJsonEnd(jsonText);
    if (jsonEnd > 0) {
      matches.push(jsonText.slice(0, jsonEnd + 1));
      continue;
    }

    // 策略2: 宽松回退 — LLM 可能在 widget_code 中有未转义字符
    const repaired = tryRepairWidgetJson(jsonText);
    if (repaired) {
      matches.push('REPAIRED:' + repaired);
    }
  }
  return matches;
}

/**
 * 花括号深度 + 字符串转义感知的 JSON 边界检测。
 * 与 CodePilot 的 findJsonEnd() 逻辑一致。
 */
function findJsonEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 宽松回退：尝试从损坏的 JSON 中提取 title 和 widget_code。
 * 处理 LLM 常见的格式错误：
 * - JSON 外层对象未关闭
 * - widget_code 中的 HTML/CSS/JS 包含未转义的引号或花括号
 * - 在 JSON 结束后添加了 " />\n\n 正文
 *
 * 返回修复后的合法 JSON 字符串，或 null。
 */
function tryRepairWidgetJson(text: string): string | null {
  // 提取 title（通常在 JSON 开头，格式正确）
  const titleMatch = text.match(/"title"\s*:\s*"([^"]*?)"/);
  if (!titleMatch) return null;
  const title = titleMatch[1];

  // 提取 widget_code 的值范围
  const codeKeyIdx = text.indexOf('"widget_code"');
  if (codeKeyIdx < 0) return null;
  const colonIdx = text.indexOf(':', codeKeyIdx);
  const quoteStart = text.indexOf('"', colonIdx);
  if (quoteStart < 0) return null;

  // 从 quoteStart+1 开始，找到 widget_code 内容的结束位置
  // 策略：查找 \n``` 或字符串中最后可能的 " 位置
  const codeContent = text.slice(quoteStart + 1);

  // 尝试多种结束标记
  const endMarkers = ['\n```', '\n``', '\n`'];
  let codeEnd = codeContent.length;
  for (const marker of endMarkers) {
    const idx = codeContent.indexOf(marker);
    if (idx > 0 && idx < codeEnd) {
      codeEnd = idx;
      break;
    }
  }

  // 如果找到结束标记前的 "，用那个位置
  const beforeEnd = codeContent.slice(0, codeEnd);
  const lastQuote = beforeEnd.lastIndexOf('"');
  if (lastQuote > 0) {
    codeEnd = lastQuote;
  }

  const widgetCode = codeContent.slice(0, codeEnd);
  // 验证提取的内容看起来像 HTML/SVG
  if (widgetCode.length > 20 && (widgetCode.includes('<') || widgetCode.includes('<svg'))) {
    return JSON.stringify({ title, widget_code: widgetCode });
  }

  return null;
}

/**
 * 验证单个 widget 围栏内容的 JSON 结构
 */
interface WidgetValidation {
  rawContent: string;           // 原始围栏内容
  parseable: boolean;           // JSON.parse 成功
  jsonRepaired: boolean;        // JSON 需要修复（如添加缺失的 }）
  hasTitle: boolean;            // title 字段存在
  hasWidgetCode: boolean;       // widget_code 字段存在
  widgetCodeLength: number;     // widget_code 字符数
  withinCharLimit: boolean;     // widget_code ≤ 3000
  noForbiddenTags: boolean;     // 无 DOCTYPE/html/head/body
  cdnWhitelisted: boolean;      // 所有 CDN 在白名单内
  hasCdn: boolean;              // 是否包含 CDN 引用
  parseError?: string;          // 解析错误信息
  title?: string;               // title 值
  widgetCodePreview?: string;   // widget_code 前 200 字符预览
}

const CDN_WHITELIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
];

const FORBIDDEN_TAGS = ['<!DOCTYPE', '<html', '</html>', '<head', '</head>', '<body', '</body>'];

function validateWidget(rawContent: string): WidgetValidation {
  const result: WidgetValidation = {
    rawContent,
    parseable: false,
    jsonRepaired: false,
    hasTitle: false,
    hasWidgetCode: false,
    widgetCodeLength: 0,
    withinCharLimit: true,
    noForbiddenTags: true,
    cdnWhitelisted: true,
    hasCdn: false,
  };

  // 检查是否是修复后的 JSON
  let contentToParse = rawContent;
  if (rawContent.startsWith('REPAIRED:')) {
    result.jsonRepaired = true;
    contentToParse = rawContent.slice('REPAIRED:'.length);
  }

  // 1. JSON 解析
  let parsed: any;
  try {
    parsed = JSON.parse(contentToParse);
    result.parseable = true;
  } catch (e: any) {
    result.parseError = e.message;
    // 尝试宽松解析：可能围栏内有额外的换行或注释
    const jsonStart = contentToParse.indexOf('{');
    const jsonEnd = contentToParse.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(contentToParse.slice(jsonStart, jsonEnd + 1));
        result.parseable = true;
        result.jsonRepaired = true;
        result.parseError = undefined;
      } catch (e2: any) {
        result.parseError = `strict: ${e.message}; relaxed: ${e2.message}`;
      }
    }
    if (!result.parseable) return result;
  }

  // 2. 字段检查
  result.hasTitle = 'title' in parsed && typeof parsed.title === 'string';
  result.hasWidgetCode = 'widget_code' in parsed && typeof parsed.widget_code === 'string';
  result.title = parsed.title;

  if (result.hasWidgetCode) {
    const code: string = parsed.widget_code;
    result.widgetCodeLength = code.length;
    result.withinCharLimit = code.length <= 3000;
    result.widgetCodePreview = code.substring(0, 200);

    // 3. 禁止标签检查
    const codeLower = code.toLowerCase();
    for (const tag of FORBIDDEN_TAGS) {
      if (codeLower.includes(tag.toLowerCase())) {
        result.noForbiddenTags = false;
        break;
      }
    }

    // 4. CDN 白名单检查
    const cdnRegex = /https?:\/\/([a-z0-9.-]+)/gi;
    let cdnMatch;
    while ((cdnMatch = cdnRegex.exec(code)) !== null) {
      result.hasCdn = true;
      const domain = cdnMatch[1];
      const isWhitelisted = CDN_WHITELIST.some(wl => domain === wl || domain.endsWith('.' + wl));
      if (!isWhitelisted) {
        result.cdnWhitelisted = false;
      }
    }
  }

  return result;
}

/**
 * 从 LLM 完整输出中提取并验证所有 widget
 */
function analyzeWidgets(resultText: string) {
  const fences = extractWidgetFences(resultText);
  const validations = fences.map(validateWidget);

  return {
    fenceCount: fences.length,
    fences,
    validations,
    hasAnyWidget: fences.length > 0,
    allParseable: validations.every(v => v.parseable),
    anyRepaired: validations.some(v => v.jsonRepaired),
    allHaveTitleAndCode: validations.every(v => v.hasTitle && v.hasWidgetCode),
    allWithinCharLimit: validations.every(v => v.withinCharLimit),
    allNoForbiddenTags: validations.every(v => v.noForbiddenTags),
    allCdnWhitelisted: validations.every(v => v.cdnWhitelisted),
  };
}

/** 打印分析结果 */
function printAnalysis(label: string, analysis: ReturnType<typeof analyzeWidgets>, resultText: string) {
  console.error(`\n${'='.repeat(70)}`);
  console.error(`📊 ${label}`);
  console.error(`${'='.repeat(70)}`);
  console.error(`围栏数量: ${analysis.fenceCount}`);
  console.error(`全部可解析: ${analysis.allParseable}`);
  console.error(`需要 JSON 修复: ${analysis.anyRepaired}`);
  console.error(`全部含 title+widget_code: ${analysis.allHaveTitleAndCode}`);
  console.error(`全部 ≤3000 字符: ${analysis.allWithinCharLimit}`);
  console.error(`全部无禁止标签: ${analysis.allNoForbiddenTags}`);
  console.error(`全部 CDN 白名单: ${analysis.allCdnWhitelisted}`);
  console.error(`\n完整输出长度: ${resultText.length} 字符`);
  console.error(`完整输出前 500 字符:\n${resultText.substring(0, 500)}`);

  for (let i = 0; i < analysis.validations.length; i++) {
    const v = analysis.validations[i];
    console.error(`\n--- Widget ${i + 1} ---`);
    console.error(`  可解析: ${v.parseable}`);
    if (v.jsonRepaired) console.error(`  JSON 需修复: true（LLM 输出了不完整的 JSON）`);
    if (v.parseError) console.error(`  解析错误: ${v.parseError}`);
    console.error(`  title: ${v.title}`);
    console.error(`  hasWidgetCode: ${v.hasWidgetCode}`);
    console.error(`  widgetCode 长度: ${v.widgetCodeLength}`);
    console.error(`  ≤3000 字符: ${v.withinCharLimit}`);
    console.error(`  无禁止标签: ${v.noForbiddenTags}`);
    console.error(`  CDN 白名单: ${v.cdnWhitelisted}`);
    if (v.widgetCodePreview) {
      console.error(`  widget_code 预览: ${v.widgetCodePreview}`);
    }
  }
  console.error('');
}

// ====== SDK 调用工具 ======

async function runQuery(options: {
  prompt: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  logDir?: string;
  noTools?: boolean;
}): Promise<string> {
  const env = options.logDir
    ? { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` }
    : BASE_ENV;

  const queryOptions: any = {
    env,
    includePartialMessages: true,
    persistSession: false,
    settingSources: [],
    effort: 'low',
  };

  if (options.systemPrompt !== undefined) {
    queryOptions.systemPrompt = options.systemPrompt;
  }

  // 禁用所有工具 — 纯文本输出，防止 LLM 尝试执行命令超时
  if (options.noTools) {
    queryOptions.tools = [];
  }

  const sdkQuery = query({
    prompt: options.prompt,
    options: queryOptions,
  });

  let resultText = '';
  for await (const message of sdkQuery) {
    const msg = message as any;
    // 打印流式 text_delta 到 stderr
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
      const delta = msg.event.delta;
      if (delta?.type === 'text_delta') {
        process.stderr.write(delta.text);
      }
    }
    if (msg.type === 'result') {
      resultText = msg.result || '';
    }
  }
  return resultText;
}

// ====== 测试用例 ======

describe('Widget 生成式 UI — LLM 遵循性观察', () => {

  // Case 1: 基线 — 无 widget 系统提示，看 LLM 自然输出
  it('case-1 基线：无 widget 系统提示，LLM 自然输出', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-1-baseline');
    const resultText = await runQuery({
      prompt: '画一个展示月度收入趋势的折线图。注意：不要使用任何工具，直接在回复中输出可视化代码。',
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 1: 基线（无 widget 提示）', analysis, resultText);

    // 观察：无 widget 系统提示时，LLM 可能：
    // - 输出普通代码围栏（```chart 等）但不输出 show-widget
    // - 直接输出 SVG/HTML 但不包装在 show-widget 中
    // - 完全不输出可视化代码
    console.error(`[case-1] 是否输出 show-widget 围栏: ${analysis.hasAnyWidget}`);

    // 基线 case 不断言 show-widget 存在性，只记录观察结果
    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 2: 注入 WIDGET_SYSTEM_PROMPT + chart 指南
  it('case-2 注入 WIDGET_SYSTEM_PROMPT + chart 指南', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-2-chart-prompt');
    const systemPrompt = WIDGET_SYSTEM_PROMPT + '\n\n' + CHART_GUIDELINES;

    const resultText = await runQuery({
      prompt: '画一个展示月度收入趋势的折线图。数据：1月 32万，2月 45万，3月 38万，4月 52万，5月 48万，6月 61万',
      systemPrompt,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 2: chart 场景（有系统提示 + 指南）', analysis, resultText);

    // 关键断言：有系统提示时应该能输出 show-widget 围栏
    // 注意：本地 LLM 可能不严格遵循，先观察
    console.error(`[case-2] 围栏数量: ${analysis.fenceCount}`);
    console.error(`[case-2] 全部可解析: ${analysis.allParseable}`);

    if (analysis.hasAnyWidget && analysis.allParseable) {
      // 如果能解析，验证基本结构
      expect(analysis.allHaveTitleAndCode).toBe(true);
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 3: diagram 流程图 — SVG 输出
  it('case-3 diagram 流程图', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-3-diagram');
    const systemPrompt = WIDGET_SYSTEM_PROMPT + '\n\n' + DIAGRAM_GUIDELINES;

    const resultText = await runQuery({
      prompt: '画一个软件开发生命周期的流程图：需求分析 → 设计 → 开发 → 测试 → 部署 → 维护',
      systemPrompt,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 3: diagram 流程图', analysis, resultText);

    console.error(`[case-3] 围栏数量: ${analysis.fenceCount}`);

    if (analysis.hasAnyWidget && analysis.allParseable) {
      // SVG diagram 场景检查
      const v = analysis.validations[0];
      console.error(`[case-3] widget_code 是否包含 <svg>: ${v.widgetCodePreview?.includes('<svg')}`);
      console.error(`[case-3] widget_code 是否包含 viewBox: ${v.widgetCodePreview?.includes('viewBox')}`);
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 4: art SVG 插画
  it('case-4 art SVG 插画', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-4-art');
    const systemPrompt = WIDGET_SYSTEM_PROMPT + '\n\n' + ART_GUIDELINES;

    const resultText = await runQuery({
      prompt: '画一个简洁的 SVG 插画，主题是"数据流动"，用几何形状和线条表现数据在系统间流动的过程',
      systemPrompt,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 4: art SVG 插画', analysis, resultText);

    console.error(`[case-4] 围栏数量: ${analysis.fenceCount}`);

    if (analysis.hasAnyWidget && analysis.allParseable) {
      const v = analysis.validations[0];
      console.error(`[case-4] widget_code 长度: ${v.widgetCodeLength}`);
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 5: 多 widget（饼图 + 时间线）
  it('case-5 多 widget：饼图 + 时间线', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-5-multi-widget');
    const systemPrompt = WIDGET_SYSTEM_PROMPT + '\n\n' + CHART_GUIDELINES + '\n\n' + DIAGRAM_GUIDELINES;

    const resultText = await runQuery({
      prompt: '请分别展示以下两个图表：\n1) 团队技能分布饼图（前端 30%, 后端 40%, DevOps 15%, 测试 15%）\n2) 项目时间线（需求阶段1-2月, 开发阶段3-5月, 测试阶段6月, 上线7月）',
      systemPrompt,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 5: 多 widget（饼图 + 时间线）', analysis, resultText);

    console.error(`[case-5] 围栏数量: ${analysis.fenceCount}`);
    console.error(`[case-5] 期望 2 个围栏，实际 ${analysis.fenceCount} 个`);

    if (analysis.hasAnyWidget) {
      // 检查多 widget 是否独立围栏
      console.error(`[case-5] 各 widget title:`);
      for (let i = 0; i < analysis.validations.length; i++) {
        console.error(`  widget ${i + 1}: title="${analysis.validations[i].title}"`);
      }
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 6: 对照组 — 无 widget 系统提示但 prompt 含"画图"
  it('case-6 对照组：有完整系统提示但无 widget 能力声明', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-6-no-widget-prompt');
    const systemPrompt = '你是一个数据可视化助手，擅长用图表展示数据。直接在回复中输出代码，不要使用任何工具。';

    const resultText = await runQuery({
      prompt: '画一个展示月度收入趋势的折线图。数据：1月 32万，2月 45万，3月 38万，4月 52万，5月 48万，6月 61万',
      systemPrompt,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    printAnalysis('Case 6: 对照组（无 widget 提示）', analysis, resultText);

    // 对照组：没有 show-widget 格式指导，LLM 应该不会输出 show-widget 围栏
    // 如果输出了，说明 LLM 之前见过这个格式（训练数据中有）
    console.error(`[case-6] 是否意外输出 show-widget: ${analysis.hasAnyWidget}`);

    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

});

// ====== 第二组实验：systemPrompt 模式变量 ======

/** 分析请求日志中的 system prompt 结构 */
function analyzeRequestSystem(dir: string) {
  const { readdirSync, readFileSync } = require('fs');
  const { join } = require('path');
  const allFiles = readdirSync(dir);
  const reqFiles = allFiles.filter((f: string) => f.endsWith('.request.json') && !f.includes('.pretty.'));
  if (reqFiles.length === 0) return null;

  const body = JSON.parse(readFileSync(join(dir, reqFiles.sort()[0]), 'utf-8'));
  const system: any[] = body.system || [];
  return {
    blockCount: system.length,
    totalChars: system.reduce((s: number, b: any) => s + (b.text?.length || 0), 0),
    blocks: system.map((b: any, i: number) => ({
      index: i,
      chars: b.text?.length || 0,
      preview: b.text?.substring(0, 80) || '',
      cached: !!b.cache_control,
    })),
    hasSdkIdentity: system.some((b: any) => b.text?.includes('You are a Claude agent')),
    hasFullClaudeCode: system.some((b: any) => (b.text?.length || 0) > 5000),
    hasWidgetCapability: system.some((b: any) => b.text?.includes('show-widget')),
  };
}

describe('Widget 生成式 UI — systemPrompt 模式变量', () => {

  // 统一 prompt，只变 systemPrompt 模式
  const CHART_PROMPT = '画一个展示月度收入趋势的折线图。数据：1月 32万，2月 45万，3月 38万，4月 52万，5月 48万，6月 61万。注意：不要使用任何工具，直接在回复中输出可视化代码。';
  const WIDGET_FULL_PROMPT = WIDGET_SYSTEM_PROMPT + '\n\n' + CHART_GUIDELINES;

  // Case 7: systemPrompt 不设置（SDK 默认身份）+ 无 widget 提示
  it('case-7 systemPrompt 不设置 + 无 widget 提示', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-7-no-systemprompt');
    const resultText = await runQuery({
      prompt: CHART_PROMPT,
      // systemPrompt 不传
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    const sysInfo = analyzeRequestSystem(dir);
    printAnalysis('Case 7: systemPrompt 不设置', analysis, resultText);

    console.error(`[case-7] system prompt blocks: ${sysInfo?.blockCount}, total: ${sysInfo?.totalChars} chars`);
    console.error(`[case-7] hasSdkIdentity: ${sysInfo?.hasSdkIdentity}, hasWidgetCapability: ${sysInfo?.hasWidgetCapability}`);
    console.error(`[case-7] 围栏数量: ${analysis.fenceCount}`);

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 8: systemPrompt = string 追加（与 case-2 相同，对照用）
  it('case-8 systemPrompt = string 追加 widget 提示', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-8-string-append');
    const resultText = await runQuery({
      prompt: CHART_PROMPT,
      systemPrompt: WIDGET_FULL_PROMPT,
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    const sysInfo = analyzeRequestSystem(dir);
    printAnalysis('Case 8: systemPrompt = string 追加', analysis, resultText);

    console.error(`[case-8] system prompt blocks: ${sysInfo?.blockCount}, total: ${sysInfo?.totalChars} chars`);
    console.error(`[case-8] hasSdkIdentity: ${sysInfo?.hasSdkIdentity}, hasWidgetCapability: ${sysInfo?.hasWidgetCapability}`);
    console.error(`[case-8] 围栏数量: ${analysis.fenceCount}`);

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 9: systemPrompt = preset claude_code（完整 Claude Code prompt，无 widget）
  it('case-9 systemPrompt = preset claude_code（无 widget 提示）', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-9-preset-no-widget');
    const resultText = await runQuery({
      prompt: CHART_PROMPT,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    const sysInfo = analyzeRequestSystem(dir);
    printAnalysis('Case 9: preset claude_code（无 widget）', analysis, resultText);

    console.error(`[case-9] system prompt blocks: ${sysInfo?.blockCount}, total: ${sysInfo?.totalChars} chars`);
    console.error(`[case-9] hasSdkIdentity: ${sysInfo?.hasSdkIdentity}, hasFullClaudeCode: ${sysInfo?.hasFullClaudeCode}`);
    console.error(`[case-9] hasWidgetCapability: ${sysInfo?.hasWidgetCapability}`);
    console.error(`[case-9] 围栏数量: ${analysis.fenceCount}`);

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 180000);

  // Case 10: systemPrompt = preset claude_code + append widget 提示
  // 关键问题：完整 Claude Code prompt + widget 提示的组合效果如何？
  it('case-10 systemPrompt = preset claude_code + append widget 提示', async () => {
    const dir = createTimestampDir('widget-generative-ui/case-10-preset-append-widget');
    const resultText = await runQuery({
      prompt: CHART_PROMPT,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: WIDGET_FULL_PROMPT },
      logDir: dir,
      noTools: true,
    });

    const analysis = analyzeWidgets(resultText);
    const sysInfo = analyzeRequestSystem(dir);
    printAnalysis('Case 10: preset claude_code + append widget', analysis, resultText);

    console.error(`[case-10] system prompt blocks: ${sysInfo?.blockCount}, total: ${sysInfo?.totalChars} chars`);
    console.error(`[case-10] hasSdkIdentity: ${sysInfo?.hasSdkIdentity}, hasFullClaudeCode: ${sysInfo?.hasFullClaudeCode}`);
    console.error(`[case-10] hasWidgetCapability: ${sysInfo?.hasWidgetCapability}`);
    console.error(`[case-10] 围栏数量: ${analysis.fenceCount}`);

    if (analysis.hasAnyWidget && analysis.allParseable) {
      expect(analysis.allHaveTitleAndCode).toBe(true);
    }

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 180000);

});
