/**
 * 观察性测试：.claude/agents/*.md 是否在会话启动时【自动加载进 system prompt】
 *
 * 课题：claude 会话启动时，.claude/agents/*.md 会不会被自动全量注入进
 * system prompt/上下文，还是仅作为「可被 Agent 工具选中的 subagent 配置」按需加载？
 *
 * 方法：控制变量 + OTEL_LOG_RAW_API_BODIES 落盘真实 API 请求体，grep magic 字符串。
 *
 * fixture: test/integration/fixtures/project-with-agents/.claude/agents/magic-agent.md
 *   - 名/description 含 MAGICPROBE7Q3X（可用 agent 清单摘要标记）
 *   - body 含 ZZUNIQUEBODY9X4K7（仅当全文正文被注入才会出现）
 *
 * 对比：
 *   case-1 settingSources:['project'] + cwd 指向含 agents 的 fixture —— filesystem agent 加载路径
 *   case-2 settingSources:[]        + 同 cwd                        —— 隔离对照（不加载 .claude）
 *   case-3 无 agents 目录（empty-project）                          —— baseline
 *   case-4 programmatic agents（options.agents 传入独特 magic）      —— 编程式 agent 注入对照
 *
 * 断言维度（区分三种可能）：
 *   A) 全量正文注入 —— system prompt 含 body magic (ZZUNIQUEBODY9X4K7)
 *   B) 仅摘要注入   —— system prompt 含 name/description magic (MAGICPROBE7Q3X) 但不含 body magic
 *   C) 完全不注入   —— 两个 magic 都不在 system prompt
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

const PROJECT_WITH_AGENTS = resolve(__dirname, 'fixtures', 'project-with-agents');
const EMPTY_PROJECT = resolve(__dirname, 'fixtures', 'empty-project');

// filesystem agent md 里的两个 magic 标记
const NAME_MAGIC = 'MAGICPROBE7Q3X';     // 出现在 name/description
const BODY_MAGIC = 'ZZUNIQUEBODY9X4K7';  // 只出现在 md body

// programmatic agent 的独特标记
const PROG_NAME_MAGIC = 'PROGAGENTQQ22';
const PROG_DESC_MAGIC = 'PROGDESC55KK';
const PROG_BODY_MAGIC = 'PROGBODY88WW';

const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'https://litellm.jereh.cn',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-Qwen3.8-Flash-Next',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-Qwen3.8-Flash-Next',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-Qwen3.8-Flash-Next',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
  NO_PROXY: '.jereh.cn,10.0.0.0/8,localhost,127.0.0.1',
  no_proxy: '.jereh.cn,10.0.0.0/8,localhost,127.0.0.1',
};

/** 高危工具禁用，防止意外副作用 */
const DANGEROUS_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];

interface AutoloadAnalysis {
  requestFiles: number;
  systemPromptChars: number;
  systemBlockCount: number;
  // 顶层 system 字段（真正的 system prompt）中是否命中各 magic
  systemHasNameMagic: boolean;
  systemHasBodyMagic: boolean;
  systemHasProgName: boolean;
  systemHasProgDesc: boolean;
  systemHasProgBody: boolean;
  // messages 数组（对话上下文，含 role=system 的 system-reminder）中是否命中
  messagesHasNameMagic: boolean;
  messagesHasBodyMagic: boolean;
  messagesHasProgName: boolean;
  messagesHasProgBody: boolean;
  // agent 清单是否以「system-reminder 摘要行」形式出现
  agentListedAsSummary: boolean;
  // 整个请求体（system + tools + messages 全文）中是否命中（最宽范围）
  requestHasNameMagic: boolean;
  requestHasBodyMagic: boolean;
  requestHasProgName: boolean;
  requestHasProgBody: boolean;
  toolNames: string[];
  hasAgentTool: boolean;
  verdict: string; // A=全量正文进system / B=摘要进对话上下文 / C=完全不出现
}

function analyze(dir: string): AutoloadAnalysis {
  const files = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.request.json') && !f.endsWith('.pretty.json')).sort()
    : [];

  const a: AutoloadAnalysis = {
    requestFiles: files.length,
    systemPromptChars: 0,
    systemBlockCount: 0,
    systemHasNameMagic: false,
    systemHasBodyMagic: false,
    systemHasProgName: false,
    systemHasProgDesc: false,
    systemHasProgBody: false,
    messagesHasNameMagic: false,
    messagesHasBodyMagic: false,
    messagesHasProgName: false,
    messagesHasProgBody: false,
    agentListedAsSummary: false,
    requestHasNameMagic: false,
    requestHasBodyMagic: false,
    requestHasProgName: false,
    requestHasProgBody: false,
    toolNames: [],
    hasAgentTool: false,
    verdict: 'C',
  };

  for (const f of files) {
    const raw = readFileSync(join(dir, f), 'utf-8');
    let body: any;
    try { body = JSON.parse(raw); } catch { continue; }

    // 顶层 system 字段 = 真正的 system prompt
    if (Array.isArray(body.system)) {
      const sys = body.system.map((s: any) => s.text || '').join('\n');
      if (sys.length > a.systemPromptChars) {
        a.systemPromptChars = sys.length;
        a.systemBlockCount = body.system.length;
      }
      if (sys.includes(NAME_MAGIC)) a.systemHasNameMagic = true;
      if (sys.includes(BODY_MAGIC)) a.systemHasBodyMagic = true;
      if (sys.includes(PROG_NAME_MAGIC)) a.systemHasProgName = true;
      if (sys.includes(PROG_DESC_MAGIC)) a.systemHasProgDesc = true;
      if (sys.includes(PROG_BODY_MAGIC)) a.systemHasProgBody = true;
    }

    // messages 数组 = 对话上下文（含 role=system 的 system-reminder）
    if (Array.isArray(body.messages)) {
      const msgText = body.messages.map((m: any) => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((bl: any) => bl.text || '').join('\n');
        return '';
      }).join('\n');
      if (msgText.includes(NAME_MAGIC)) a.messagesHasNameMagic = true;
      if (msgText.includes(BODY_MAGIC)) a.messagesHasBodyMagic = true;
      if (msgText.includes(PROG_NAME_MAGIC)) a.messagesHasProgName = true;
      if (msgText.includes(PROG_BODY_MAGIC)) a.messagesHasProgBody = true;
      // 摘要行形态：出现在 "Available agent types" 清单里
      if (/Available agent types/i.test(msgText)) a.agentListedAsSummary = true;
    }

    // 整个请求体全文
    if (raw.includes(NAME_MAGIC)) a.requestHasNameMagic = true;
    if (raw.includes(BODY_MAGIC)) a.requestHasBodyMagic = true;
    if (raw.includes(PROG_NAME_MAGIC)) a.requestHasProgName = true;
    if (raw.includes(PROG_BODY_MAGIC)) a.requestHasProgBody = true;

    if (Array.isArray(body.tools) && a.toolNames.length === 0) {
      a.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
      a.hasAgentTool = a.toolNames.includes('Agent');
    }
  }

  // 裁决
  if (a.systemHasBodyMagic) a.verdict = 'A (agent md 正文被注入 system prompt)';
  else if (a.systemHasNameMagic) a.verdict = 'A- (仅名/描述进 system prompt)';
  else if (a.messagesHasNameMagic) a.verdict = 'B (仅摘要清单进对话上下文 system-reminder，正文不进)';
  else a.verdict = 'C (该 agent 完全不出现在请求体)';

  return a;
}

async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  cwd?: string;
  settingSources?: string[];
  agents?: Record<string, any>;
  systemPrompt?: any;
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      cwd: options.cwd,
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      disallowedTools: DANGEROUS_TOOLS,
      ...(options.settingSources !== undefined ? { settingSources: options.settingSources } : {}),
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
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

describe('.claude/agents/*.md 自动加载观察', () => {

  it('case-1 settingSources:[project] + 含 agents 的 cwd —— filesystem agent 加载路径', async () => {
    const dir = createTimestampDir('agents-md-autoload/case-1-project-source');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hi". Nothing else.',
      cwd: PROJECT_WITH_AGENTS,
      settingSources: ['project'],
    });

    const a = analyze(dir);
    console.error('\n[case-1 project-source]', JSON.stringify(a, null, 2));

    expect(a.requestFiles).toBeGreaterThan(0);
    // 核心断言：agent md 正文【不】进 system prompt；仅摘要清单进对话上下文
    expect(a.systemHasBodyMagic).toBe(false);   // 正文绝不进 system prompt
    expect(a.systemHasNameMagic).toBe(false);   // 连名/描述也不进 system prompt
    expect(a.messagesHasNameMagic).toBe(true);  // 名/描述以摘要形式进 messages
    expect(a.messagesHasBodyMagic).toBe(false); // 正文也不进 messages
    expect(a.agentListedAsSummary).toBe(true);  // 以 "Available agent types" 清单出现
    expect(a.verdict.startsWith('B')).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2 settingSources:[] + 同 cwd —— 隔离对照（不读 .claude）', async () => {
    const dir = createTimestampDir('agents-md-autoload/case-2-isolated');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hi". Nothing else.',
      cwd: PROJECT_WITH_AGENTS,
      settingSources: [],
    });

    const a = analyze(dir);
    console.error('\n[case-2 isolated]', JSON.stringify(a, null, 2));

    expect(a.requestFiles).toBeGreaterThan(0);
    // settingSources:[] 隔离模式：filesystem agent 完全不加载
    expect(a.systemHasBodyMagic).toBe(false);
    expect(a.systemHasNameMagic).toBe(false);
    expect(a.messagesHasNameMagic).toBe(false); // 摘要也不出现（未读 .claude）
    expect(a.requestHasNameMagic).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-3 baseline：空项目（无 .claude/agents）', async () => {
    const dir = createTimestampDir('agents-md-autoload/case-3-baseline');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hi". Nothing else.',
      cwd: EMPTY_PROJECT,
      settingSources: ['project'],
    });

    const a = analyze(dir);
    console.error('\n[case-3 baseline]', JSON.stringify(a, null, 2));

    expect(a.requestFiles).toBeGreaterThan(0);
    expect(a.systemHasNameMagic).toBe(false);
    expect(a.systemHasBodyMagic).toBe(false);
    expect(a.messagesHasNameMagic).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-4 programmatic agents（options.agents 传入）—— 编程式 agent 注入对照', async () => {
    const dir = createTimestampDir('agents-md-autoload/case-4-programmatic');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hi". Nothing else.',
      cwd: EMPTY_PROJECT,
      settingSources: [],
      agents: {
        [PROG_NAME_MAGIC]: {
          description: `${PROG_DESC_MAGIC} a programmatic probe agent`,
          prompt: `You are a probe. Marker: ${PROG_BODY_MAGIC}.`,
          tools: ['Read'],
        },
      },
    });

    const a = analyze(dir);
    console.error('\n[case-4 programmatic]', JSON.stringify(a, null, 2));

    expect(a.requestFiles).toBeGreaterThan(0);
    // 编程式 agent 同样只以摘要进对话上下文，prompt 正文不进 system
    expect(a.systemHasProgName).toBe(false);
    expect(a.systemHasProgBody).toBe(false);
    expect(a.messagesHasProgName).toBe(true);   // 名字进摘要清单
    expect(a.messagesHasProgBody).toBe(false);  // prompt 正文不进
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-5 preset claude_code + filesystem agent —— 真实会话形态（完整 system prompt）', async () => {
    const dir = createTimestampDir('agents-md-autoload/case-5-preset');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hi". Nothing else.',
      cwd: PROJECT_WITH_AGENTS,
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    const a = analyze(dir);
    console.error('\n[case-5 preset]', JSON.stringify(a, null, 2));

    expect(a.requestFiles).toBeGreaterThan(0);
    // 即便用完整 preset system prompt，agent md 正文仍不进 system prompt
    expect(a.systemHasBodyMagic).toBe(false);
    expect(a.systemHasNameMagic).toBe(false);
    // 摘要仍进对话上下文
    expect(a.messagesHasNameMagic).toBe(true);
    expect(a.messagesHasBodyMagic).toBe(false);
    expect(a.verdict.startsWith('B')).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);
});
