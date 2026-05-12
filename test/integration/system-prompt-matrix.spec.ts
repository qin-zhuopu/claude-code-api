/**
 * 变量控制法：观察 systemPrompt 各种配置对 API 请求中 system 字段的影响
 *
 * systemPrompt 类型：
 *   - 不设置（默认）
 *   - string（完全自定义）
 *   - string[]（多段自定义）
 *   - { type: 'preset', preset: 'claude_code' }（使用默认 Claude Code prompt）
 *   - { type: 'preset', preset: 'claude_code', append: '...' }（默认 + 追加）
 *   - { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }（默认去除动态段）
 *
 * 每个用例的日志目录按编号区分：
 *   test/integration/tmp/system-prompt/case-1-default/
 *   test/integration/tmp/system-prompt/case-2-custom-string/
 *   ...
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// --- 公共 env ---
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

// --- 辅助函数 ---

interface SystemPromptAnalysis {
  systemBlocks: Array<{ text: string; hasCacheControl: boolean }>;
  systemBlockCount: number;
  totalSystemChars: number;
  containsClaudeCode: boolean;       // 是否包含 "Claude Code" 或 "Claude agent"
  containsCustomText: boolean;       // 是否包含我们注入的自定义文本
  customTextPosition: 'none' | 'only' | 'appended' | 'prepended';
  userMessageText: string;           // user message 全文
  userMessageBlockCount: number;
}

function analyzeSystemPrompt(apiBodyDir: string): SystemPromptAnalysis {
  const allFiles = readdirSync(apiBodyDir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
  if (requestFiles.length === 0) {
    return {
      systemBlocks: [], systemBlockCount: 0, totalSystemChars: 0,
      containsClaudeCode: false, containsCustomText: false,
      customTextPosition: 'none', userMessageText: '', userMessageBlockCount: 0,
    };
  }

  const firstFile = requestFiles.sort()[0];
  const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
  const requestBody = JSON.parse(content);

  // system 分析
  const system: any[] = requestBody.system || [];
  const systemBlocks = system.map((s: any) => ({
    text: s.text || '',
    hasCacheControl: !!s.cache_control,
  }));
  const totalSystemChars = systemBlocks.reduce((sum, b) => sum + b.text.length, 0);
  const allSystemText = systemBlocks.map(b => b.text).join('\n');

  const containsClaudeCode = /Claude Code|Claude agent|claude-code/i.test(allSystemText);
  const CUSTOM_MARKER = 'JEREH_CUSTOM_MARKER';
  const containsCustomText = allSystemText.includes(CUSTOM_MARKER);

  // 判断自定义文本位置
  let customTextPosition: SystemPromptAnalysis['customTextPosition'] = 'none';
  if (containsCustomText) {
    if (!containsClaudeCode) {
      customTextPosition = 'only';
    } else {
      // 找到自定义文本在哪个 block
      const customBlockIdx = systemBlocks.findIndex(b => b.text.includes(CUSTOM_MARKER));
      const claudeBlockIdx = systemBlocks.findIndex(b => /Claude Code|Claude agent/i.test(b.text));
      customTextPosition = customBlockIdx > claudeBlockIdx ? 'appended' : 'prepended';
    }
  }

  // user message 分析
  const userMessage = requestBody.messages?.[0];
  const userMessageText = userMessage?.content
    ?.filter((block: any) => block.type === 'text')
    ?.map((block: any) => block.text)
    ?.join('\n') || '';
  const userMessageBlockCount = userMessage?.content?.length || 0;

  return {
    systemBlocks, systemBlockCount: systemBlocks.length, totalSystemChars,
    containsClaudeCode, containsCustomText, customTextPosition,
    userMessageText, userMessageBlockCount,
  };
}

async function runQuery(options: any): Promise<string> {
  const sdkQuery = query({ prompt: 'say hello', options });
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

// --- 测试用例 ---

describe('systemPrompt 配置对 API 请求的影响', () => {

  // Case 1: 不设置 systemPrompt（默认）
  it('case-1 默认: 不设置systemPrompt → SDK默认的精简prompt', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-1-default');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-1] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-1] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-1] containsClaudeCode:', analysis.containsClaudeCode);
    console.error('[case-1] blocks:', analysis.systemBlocks.map(b => b.text.slice(0, 80)));

    // 默认应该有精简的 SDK agent 身份
    expect(analysis.systemBlockCount).toBeGreaterThanOrEqual(2);
    expect(analysis.containsClaudeCode).toBe(true);
    expect(analysis.containsCustomText).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 2: systemPrompt = 自定义字符串（完全替换）
  it('case-2 自定义string: 完全替换默认prompt', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-2-custom-string');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: 'You are a test bot. JEREH_CUSTOM_MARKER. Reply briefly.',
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-2] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-2] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-2] containsClaudeCode:', analysis.containsClaudeCode);
    console.error('[case-2] containsCustomText:', analysis.containsCustomText);
    console.error('[case-2] blocks:', analysis.systemBlocks.map(b => b.text.slice(0, 80)));

    // 自定义字符串：SDK 仍保留 billing header 和基础身份，自定义内容追加在后面
    expect(analysis.containsCustomText).toBe(true);
    // 发现：自定义 string 不会完全替换，而是追加到默认的 billing + 身份之后
    expect(analysis.containsClaudeCode).toBe(true);
    expect(analysis.customTextPosition).toBe('appended');
    // 但 system prompt 应该很短（不是完整的 Claude Code prompt）
    expect(analysis.totalSystemChars).toBeLessThan(500);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 3: systemPrompt = string[]（多段自定义）
  it('case-3 自定义string[]: 多段自定义prompt', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-3-custom-array');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: [
        'You are a test bot.',
        'JEREH_CUSTOM_MARKER',
        'Reply in one sentence.',
      ],
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-3] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-3] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-3] containsClaudeCode:', analysis.containsClaudeCode);
    console.error('[case-3] containsCustomText:', analysis.containsCustomText);
    console.error('[case-3] blocks:', analysis.systemBlocks.map(b => b.text.slice(0, 80)));

    // 多段自定义：同 case-2，SDK 仍保留 billing + 身份，自定义内容合并为一个 block 追加
    expect(analysis.containsCustomText).toBe(true);
    expect(analysis.containsClaudeCode).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 4: systemPrompt = { type: 'preset', preset: 'claude_code' }（使用默认）
  it('case-4 preset默认: 使用Claude Code默认prompt', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-4-preset-default');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-4] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-4] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-4] containsClaudeCode:', analysis.containsClaudeCode);
    console.error('[case-4] blocks preview:', analysis.systemBlocks.map(b => b.text.slice(0, 80)));

    // 应该包含完整的 Claude Code 默认 prompt（比 case-1 大得多）
    expect(analysis.containsClaudeCode).toBe(true);
    expect(analysis.totalSystemChars).toBeGreaterThan(1000);
    expect(analysis.containsCustomText).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 5: systemPrompt = { type: 'preset', preset: 'claude_code', append: '...' }
  it('case-5 preset+append: 默认prompt后追加自定义内容', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-5-preset-append');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'JEREH_CUSTOM_MARKER: Always respond in Chinese.',
      },
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-5] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-5] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-5] containsClaudeCode:', analysis.containsClaudeCode);
    console.error('[case-5] containsCustomText:', analysis.containsCustomText);
    console.error('[case-5] customTextPosition:', analysis.customTextPosition);

    // 应该同时包含 Claude Code 默认 prompt 和自定义内容
    expect(analysis.containsClaudeCode).toBe(true);
    expect(analysis.containsCustomText).toBe(true);
    expect(analysis.customTextPosition).toBe('appended');
    expect(analysis.totalSystemChars).toBeGreaterThan(1000);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 6: systemPrompt = { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }
  it('case-6 preset+excludeDynamic: 去除动态段，观察user message变化', async () => {
    const apiBodyDir = createTimestampDir('system-prompt/case-6-preset-exclude-dynamic');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
      },
    });

    const analysis = analyzeSystemPrompt(apiBodyDir);
    console.error('\n[case-6] systemBlockCount:', analysis.systemBlockCount);
    console.error('[case-6] totalSystemChars:', analysis.totalSystemChars);
    console.error('[case-6] userMessageBlockCount:', analysis.userMessageBlockCount);
    console.error('[case-6] userMessageText length:', analysis.userMessageText.length);

    // 动态段被移到 user message 中
    expect(analysis.containsClaudeCode).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 7: 对比 case-1 和 case-4 → 不设置 vs preset 的区别
  it('case-7 对比: 不设置systemPrompt vs preset claude_code 的system长度差异', async () => {
    // 先跑不设置的
    const dir1 = createTimestampDir('system-prompt/case-7-compare-no-prompt');
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir1}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
    });

    // 再跑 preset 的
    const dir2 = createTimestampDir('system-prompt/case-7-compare-preset');
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir2}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: [],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    const a1 = analyzeSystemPrompt(dir1);
    const a2 = analyzeSystemPrompt(dir2);

    console.error('\n[case-7] 不设置: systemChars=', a1.totalSystemChars, 'blocks=', a1.systemBlockCount);
    console.error('[case-7] preset:  systemChars=', a2.totalSystemChars, 'blocks=', a2.systemBlockCount);
    console.error('[case-7] 差异倍数:', (a2.totalSystemChars / a1.totalSystemChars).toFixed(1), 'x');

    // preset 应该比不设置大很多（完整 Claude Code prompt vs 精简 SDK agent prompt）
    expect(a2.totalSystemChars).toBeGreaterThan(a1.totalSystemChars);

    prettyFormatJsonFiles(dir1);
    prettyFormatJsonFiles(dir2);
  }, 120000);
});
