/**
 * 变量控制法：观察 systemPrompt 各种配置对 API 请求中 system 字段的影响
 *
 * systemPrompt 类型：
 *   - 不设置（默认）→ 精简 SDK agent 身份
 *   - string（自定义）→ 追加到基础身份之后
 *   - string[]（多段自定义）→ 合并后追加
 *   - { type: 'preset', preset: 'claude_code' }（完整 Claude Code prompt）
 *   - { type: 'preset', preset: 'claude_code', append: '...' }（完整 + 追加）
 *   - { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }（去动态段）
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

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

const CUSTOM_MARKER = 'JEREH_CUSTOM_MARKER_12345';

// --- 辅助函数 ---

interface SystemAnalysis {
  blocks: Array<{ text: string; chars: number; cached: boolean }>;
  blockCount: number;
  totalChars: number;
  // 内容检测
  hasBillingHeader: boolean;
  hasBaseIdentity: boolean;        // "You are a Claude agent..."
  hasFullClaudeCode: boolean;      // 完整的 Claude Code 行为指令（>5000 chars）
  hasCustomMarker: boolean;
  hasGitStatus: boolean;           // 动态段：git status
  // 位置分析
  identityText: string;            // 身份声明的完整文本
  customMarkerBlockIdx: number;    // 自定义内容在哪个 block
  // user message
  userBlocks: number;
  userFirstBlockChars: number;
  userHasGitStatus: boolean;       // 动态段是否移到了 user message
}

function analyze(apiBodyDir: string): SystemAnalysis {
  const allFiles = readdirSync(apiBodyDir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
  const empty: SystemAnalysis = {
    blocks: [], blockCount: 0, totalChars: 0,
    hasBillingHeader: false, hasBaseIdentity: false, hasFullClaudeCode: false,
    hasCustomMarker: false, hasGitStatus: false,
    identityText: '', customMarkerBlockIdx: -1,
    userBlocks: 0, userFirstBlockChars: 0, userHasGitStatus: false,
  };
  if (requestFiles.length === 0) return empty;

  const firstFile = requestFiles.sort()[0];
  const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
  const body = JSON.parse(content);

  const system: any[] = body.system || [];
  const blocks = system.map((s: any) => ({
    text: s.text || '',
    chars: (s.text || '').length,
    cached: !!s.cache_control,
  }));
  const totalChars = blocks.reduce((sum, b) => sum + b.chars, 0);
  const allSystemText = blocks.map(b => b.text).join('\n');

  const hasBillingHeader = blocks.some(b => b.text.includes('x-anthropic-billing-header'));
  const hasBaseIdentity = blocks.some(b => /You are a Claude agent|You are Claude Code/i.test(b.text));
  const hasFullClaudeCode = blocks.some(b => b.chars > 5000 && b.text.includes('interactive agent'));
  const hasCustomMarker = allSystemText.includes(CUSTOM_MARKER);
  const hasGitStatus = allSystemText.includes('gitStatus') || allSystemText.includes('git status');

  const identityBlock = blocks.find(b => /You are a Claude agent|You are Claude Code/i.test(b.text));
  const identityText = identityBlock?.text || '';
  const customMarkerBlockIdx = blocks.findIndex(b => b.text.includes(CUSTOM_MARKER));

  // user message
  const userMsg = body.messages?.[0];
  const userContent = userMsg?.content || [];
  const userBlocks = userContent.length;
  const userFirstBlockChars = userContent[0]?.text?.length || 0;
  const userAllText = userContent.map((b: any) => b.text || '').join('\n');
  const userHasGitStatus = userAllText.includes('gitStatus') || userAllText.includes('git status');

  return {
    blocks, blockCount: blocks.length, totalChars,
    hasBillingHeader, hasBaseIdentity, hasFullClaudeCode,
    hasCustomMarker, hasGitStatus,
    identityText, customMarkerBlockIdx,
    userBlocks, userFirstBlockChars, userHasGitStatus,
  };
}

async function run(options: any): Promise<string> {
  const sdkQuery = query({ prompt: 'say hello', options });
  let result = '';
  for await (const msg of sdkQuery) {
    const m = msg as any;
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
      if (m.event.delta?.type === 'text_delta') process.stderr.write(m.event.delta.text);
    }
    if (m.type === 'result') result = m.result || '';
  }
  return result;
}

// --- 测试 ---

describe('systemPrompt 配置矩阵', () => {

  it('case-1 不设置: 精简SDK身份(~146 chars)', async () => {
    const dir = createTimestampDir('system-prompt/case-1-default');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
    });

    const a = analyze(dir);
    console.error(`\n[case-1] ${a.blockCount} blocks, ${a.totalChars} chars`);
    console.error(`[case-1] identity: "${a.identityText}"`);

    expect(a.blockCount).toBe(2);
    expect(a.hasBillingHeader).toBe(true);
    expect(a.hasBaseIdentity).toBe(true);
    expect(a.hasFullClaudeCode).toBe(false);
    expect(a.totalChars).toBeLessThan(200);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2 自定义string: 追加到基础身份之后(不替换)', async () => {
    const dir = createTimestampDir('system-prompt/case-2-custom-string');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: `You are a test bot. ${CUSTOM_MARKER}. Reply briefly.`,
    });

    const a = analyze(dir);
    console.error(`\n[case-2] ${a.blockCount} blocks, ${a.totalChars} chars`);
    console.error(`[case-2] blocks: ${a.blocks.map(b => `${b.chars}c${b.cached ? '(cached)' : ''}`).join(', ')}`);

    // 结构：billing + 基础身份 + 自定义内容
    expect(a.blockCount).toBe(3);
    expect(a.hasBillingHeader).toBe(true);
    expect(a.hasBaseIdentity).toBe(true);       // 基础身份保留
    expect(a.hasCustomMarker).toBe(true);       // 自定义内容追加
    expect(a.customMarkerBlockIdx).toBe(2);     // 在第3个block
    expect(a.hasFullClaudeCode).toBe(false);    // 不是完整 Claude Code prompt
    expect(a.totalChars).toBeLessThan(300);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-3 自定义string[]: 多段合并为一个block追加', async () => {
    const dir = createTimestampDir('system-prompt/case-3-custom-array');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: ['You are a test bot.', CUSTOM_MARKER, 'Reply in one sentence.'],
    });

    const a = analyze(dir);
    console.error(`\n[case-3] ${a.blockCount} blocks, ${a.totalChars} chars`);

    // string[] 被合并为一个 block（用 \n\n 连接）
    expect(a.blockCount).toBe(3);
    expect(a.hasBaseIdentity).toBe(true);
    expect(a.hasCustomMarker).toBe(true);
    expect(a.hasFullClaudeCode).toBe(false);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-4 preset claude_code: 完整Claude Code prompt(~26000 chars)', async () => {
    const dir = createTimestampDir('system-prompt/case-4-preset-default');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    const a = analyze(dir);
    console.error(`\n[case-4] ${a.blockCount} blocks, ${a.totalChars} chars`);
    console.error(`[case-4] blocks: ${a.blocks.map(b => `${b.chars}c`).join(', ')}`);

    // 完整 Claude Code prompt
    expect(a.blockCount).toBe(3);
    expect(a.hasBillingHeader).toBe(true);
    expect(a.hasBaseIdentity).toBe(true);
    expect(a.hasFullClaudeCode).toBe(true);
    expect(a.totalChars).toBeGreaterThan(20000);
    // 动态段（gitStatus）在 system prompt 中
    expect(a.hasGitStatus).toBe(true);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-5 preset+append: 自定义内容插入在动态段之前', async () => {
    const dir = createTimestampDir('system-prompt/case-5-preset-append');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: `${CUSTOM_MARKER}: Always respond in Chinese.` },
    });

    const a = analyze(dir);
    console.error(`\n[case-5] ${a.blockCount} blocks, ${a.totalChars} chars`);

    expect(a.hasBillingHeader).toBe(true);
    expect(a.hasFullClaudeCode).toBe(true);
    expect(a.hasCustomMarker).toBe(true);
    expect(a.hasGitStatus).toBe(true);
    // append 内容和 Claude Code prompt 在同一个 block 中
    expect(a.customMarkerBlockIdx).toBe(2);
    // 总大小比 case-4 略大
    expect(a.totalChars).toBeGreaterThan(25000);

    // 验证 append 内容在 gitStatus 之前
    const bigBlock = a.blocks[2].text;
    const markerPos = bigBlock.indexOf(CUSTOM_MARKER);
    const gitPos = bigBlock.indexOf('gitStatus');
    expect(markerPos).toBeLessThan(gitPos);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-6 preset+excludeDynamic: 动态段移到user message', async () => {
    const dir = createTimestampDir('system-prompt/case-6-preset-exclude-dynamic');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
    });

    const a = analyze(dir);
    console.error(`\n[case-6] system: ${a.blockCount} blocks, ${a.totalChars} chars`);
    console.error(`[case-6] user: ${a.userBlocks} blocks, first=${a.userFirstBlockChars} chars`);
    console.error(`[case-6] gitStatus in system: ${a.hasGitStatus}, in user: ${a.userHasGitStatus}`);

    expect(a.hasFullClaudeCode).toBe(true);
    // 动态段从 system 移到了 user message
    expect(a.hasGitStatus).toBe(false);
    expect(a.userHasGitStatus).toBe(true);
    // system 比 case-4 小（少了动态段）
    expect(a.totalChars).toBeLessThan(25500);
    // user message 第一个 block 变大了（包含动态段）
    expect(a.userFirstBlockChars).toBeGreaterThan(500);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-7 身份声明对比: 不设置 vs preset 的身份文本不同', async () => {
    const dir1 = createTimestampDir('system-prompt/case-7-identity-no-prompt');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir1}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
    });

    const dir2 = createTimestampDir('system-prompt/case-7-identity-preset');
    await run({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir2}` },
      includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    const a1 = analyze(dir1);
    const a2 = analyze(dir2);

    console.error(`\n[case-7] 不设置 identity: "${a1.identityText}"`);
    console.error(`[case-7] preset identity: "${a2.identityText.slice(0, 100)}..."`);
    console.error(`[case-7] 大小对比: ${a1.totalChars} vs ${a2.totalChars} (${(a2.totalChars / a1.totalChars).toFixed(0)}x)`);

    // 不设置时身份是精简的
    expect(a1.identityText).toContain('Claude agent');
    expect(a1.identityText).toContain('Claude Agent SDK');
    // preset 时身份 block 相同，但多了完整的行为指令 block
    expect(a2.identityText).toContain('Claude agent');
    expect(a2.hasFullClaudeCode).toBe(true);
    // 大小差异巨大（178x）
    expect(a2.totalChars).toBeGreaterThan(a1.totalChars * 100);

    prettyFormatJsonFiles(dir1);
    prettyFormatJsonFiles(dir2);
  }, 120000);
});
