/**
 * OTEL 日志选项矩阵测试
 *
 * 观察 OTEL_LOG_RAW_API_BODIES / OTEL_LOG_TOOL_CONTENT / OTEL_LOG_TOOL_DETAILS / OTEL_LOG_USER_PROMPTS
 * 四个环境变量对 SDK 日志输出的影响。
 *
 * 方法论：观察性测试 — 通过对比不同 env 组合下产出的 JSON 文件内容差异，
 * 推断各变量的实际控制行为。
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ─── 公共配置 ───────────────────────────────────────────────────────────────

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

/** 触发工具调用的 prompt — 让模型使用 Read 工具读取一个文件 */
const TOOL_TRIGGER_PROMPT = 'Read the file ./package.json and tell me the project name.';

/** 简单 prompt — 不触发工具调用 */
const SIMPLE_PROMPT = 'Say exactly: "hello world". Nothing else.';

// ─── 工具函数 ───────────────────────────────────────────────────────────────

interface LogAnalysis {
  /** 目录中的文件总数 */
  totalFiles: number;
  /** request 文件数 */
  requestFiles: number;
  /** response 文件数 */
  responseFiles: number;
  /** 第一个 request 的 keys */
  requestKeys: string[];
  /** request 中是否包含 messages 字段 */
  hasMessages: boolean;
  /** request 中 messages 是否包含用户 prompt 文本 */
  hasUserPromptContent: boolean;
  /** request 中是否包含 tools 字段 */
  hasTools: boolean;
  /** request 中 tools 数组长度 */
  toolsCount: number;
  /** request 中 tools 是否包含 input_schema（详细定义） */
  hasToolInputSchema: boolean;
  /** request 中 messages 是否包含 tool_result 角色的消息 */
  hasToolResultMessages: boolean;
  /** request 中 tool_result 消息是否包含 content */
  hasToolResultContent: boolean;
  /** response 中是否包含 tool_use content block */
  hasToolUseInResponse: boolean;
  /** response 中 tool_use 是否包含 input 字段 */
  hasToolUseInput: boolean;
  /** 第一个 request 的 JSON 大小（字节） */
  requestSize: number;
  /** 第一个 response 的 JSON 大小（字节，0 表示无 response） */
  responseSize: number;
}

function analyzeLogDir(dir: string): LogAnalysis {
  const allFiles = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'));
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const analysis: LogAnalysis = {
    totalFiles: allFiles.length,
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    requestKeys: [],
    hasMessages: false,
    hasUserPromptContent: false,
    hasTools: false,
    toolsCount: 0,
    hasToolInputSchema: false,
    hasToolResultMessages: false,
    hasToolResultContent: false,
    hasToolUseInResponse: false,
    hasToolUseInput: false,
    requestSize: 0,
    responseSize: 0,
  };

  // 分析所有 request 文件（多轮对话会有多个）
  if (requestFiles.length > 0) {
    const firstReqContent = readFileSync(join(dir, requestFiles[0]), 'utf-8');
    analysis.requestSize = firstReqContent.length;
    const reqBody = JSON.parse(firstReqContent);
    analysis.requestKeys = Object.keys(reqBody).sort();

    // messages
    analysis.hasMessages = Array.isArray(reqBody.messages);
    if (analysis.hasMessages && reqBody.messages.length > 0) {
      // 检查是否有用户 prompt 文本
      const userMsgs = reqBody.messages.filter((m: any) => m.role === 'user');
      analysis.hasUserPromptContent = userMsgs.some((m: any) => {
        if (typeof m.content === 'string') return m.content.length > 0;
        if (Array.isArray(m.content)) {
          return m.content.some((b: any) => b.type === 'text' && b.text && b.text.length > 0);
        }
        return false;
      });
    }

    // tools
    analysis.hasTools = Array.isArray(reqBody.tools);
    analysis.toolsCount = reqBody.tools?.length ?? 0;
    if (analysis.hasTools && analysis.toolsCount > 0) {
      analysis.hasToolInputSchema = reqBody.tools.some((t: any) => t.input_schema && Object.keys(t.input_schema).length > 0);
    }

    // 检查所有 request 文件中是否有 tool_result（多轮时第二个 request 会包含）
    for (const rf of requestFiles) {
      const content = readFileSync(join(dir, rf), 'utf-8');
      const body = JSON.parse(content);
      if (Array.isArray(body.messages)) {
        const toolResults = body.messages.filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
        if (toolResults.length > 0) {
          analysis.hasToolResultMessages = true;
          // 检查 tool_result 是否有 content
          for (const tr of toolResults) {
            const blocks = tr.content.filter((b: any) => b.type === 'tool_result');
            if (blocks.some((b: any) => b.content && (typeof b.content === 'string' ? b.content.length > 0 : true))) {
              analysis.hasToolResultContent = true;
            }
          }
        }
      }
    }
  }

  // 分析 response 文件
  if (responseFiles.length > 0) {
    const firstRespContent = readFileSync(join(dir, responseFiles[0]), 'utf-8');
    analysis.responseSize = firstRespContent.length;
    const respBody = JSON.parse(firstRespContent);

    // 检查 response 中是否有 tool_use
    if (Array.isArray(respBody.content)) {
      const toolUseBlocks = respBody.content.filter((b: any) => b.type === 'tool_use');
      analysis.hasToolUseInResponse = toolUseBlocks.length > 0;
      if (analysis.hasToolUseInResponse) {
        analysis.hasToolUseInput = toolUseBlocks.some((b: any) => b.input && Object.keys(b.input).length > 0);
      }
    }
  }

  return analysis;
}

async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  tools?: any[];
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    } as any,
  });

  let resultText = '';

  for await (const message of sdkQuery) {
    const msg = message as any;

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

// ─── 测试矩阵 ───────────────────────────────────────────────────────────────

describe('OTEL 日志选项矩阵', () => {

  /**
   * Case 1: 基线 — 仅 OTEL_LOG_RAW_API_BODIES，其他三个不设置
   * 预期：产出完整的 request/response JSON，包含所有字段
   */
  it('case-1 基线：仅 OTEL_LOG_RAW_API_BODIES', async () => {
    const dir = createTimestampDir('otel-log-options/case-1-baseline');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: SIMPLE_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-1 基线]', JSON.stringify(analysis, null, 2));

    // 基本验证：文件产出
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.responseFiles).toBeGreaterThan(0);
    // 应包含完整结构
    expect(analysis.hasMessages).toBe(true);
    expect(analysis.hasUserPromptContent).toBe(true);
    expect(analysis.hasTools).toBe(true);
    expect(analysis.toolsCount).toBeGreaterThan(0);
    expect(analysis.hasToolInputSchema).toBe(true);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 2: OTEL_LOG_USER_PROMPTS=false — 禁用用户 prompt 记录
   * 预期：request 中 messages 的用户文本被脱敏或移除
   */
  it('case-2 OTEL_LOG_USER_PROMPTS=false', async () => {
    const dir = createTimestampDir('otel-log-options/case-2-no-user-prompts');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_USER_PROMPTS: 'false',
      },
      prompt: SIMPLE_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-2 no-user-prompts]', JSON.stringify(analysis, null, 2));

    // 文件应该产出
    expect(analysis.requestFiles).toBeGreaterThan(0);
    // 观察：用户 prompt 是否被移除/脱敏
    // 这是观察性断言 — 先宽松，根据实际结果精确化
    console.error('[case-2] hasUserPromptContent:', analysis.hasUserPromptContent);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 3: OTEL_LOG_USER_PROMPTS=true — 显式启用用户 prompt 记录
   * 预期：与 case-1 行为一致，messages 中包含完整用户文本
   */
  it('case-3 OTEL_LOG_USER_PROMPTS=true', async () => {
    const dir = createTimestampDir('otel-log-options/case-3-user-prompts-true');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_USER_PROMPTS: 'true',
      },
      prompt: SIMPLE_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-3 user-prompts-true]', JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.hasUserPromptContent).toBe(true);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 4: OTEL_LOG_TOOL_DETAILS=false — 禁用工具详情记录
   * 预期：request 中 tools 字段被移除或简化（无 input_schema）
   */
  it('case-4 OTEL_LOG_TOOL_DETAILS=false', async () => {
    const dir = createTimestampDir('otel-log-options/case-4-no-tool-details');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_DETAILS: 'false',
      },
      prompt: SIMPLE_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-4 no-tool-details]', JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);
    // 观察：tools 是否被移除或简化
    console.error('[case-4] hasTools:', analysis.hasTools);
    console.error('[case-4] toolsCount:', analysis.toolsCount);
    console.error('[case-4] hasToolInputSchema:', analysis.hasToolInputSchema);
    console.error('[case-4] requestSize vs baseline — 如果 tools 被移除，size 应显著减小');

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 5: OTEL_LOG_TOOL_DETAILS=true — 显式启用工具详情
   * 预期：与 case-1 一致，tools 包含完整 input_schema
   */
  it('case-5 OTEL_LOG_TOOL_DETAILS=true', async () => {
    const dir = createTimestampDir('otel-log-options/case-5-tool-details-true');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_DETAILS: 'true',
      },
      prompt: SIMPLE_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-5 tool-details-true]', JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.hasTools).toBe(true);
    expect(analysis.toolsCount).toBeGreaterThan(0);
    expect(analysis.hasToolInputSchema).toBe(true);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 6: OTEL_LOG_TOOL_CONTENT=false — 禁用工具内容记录（需触发工具调用）
   * 预期：多轮对话中 tool_result 的 content 被脱敏或移除
   */
  it('case-6 OTEL_LOG_TOOL_CONTENT=false（触发工具调用）', async () => {
    const dir = createTimestampDir('otel-log-options/case-6-no-tool-content');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_CONTENT: 'false',
      },
      prompt: TOOL_TRIGGER_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-6 no-tool-content]', JSON.stringify(analysis, null, 2));

    // 应该有多轮（工具调用 → 工具结果 → 最终回复）
    console.error('[case-6] requestFiles:', analysis.requestFiles);
    console.error('[case-6] hasToolResultMessages:', analysis.hasToolResultMessages);
    console.error('[case-6] hasToolResultContent:', analysis.hasToolResultContent);
    console.error('[case-6] hasToolUseInResponse:', analysis.hasToolUseInResponse);
    console.error('[case-6] hasToolUseInput:', analysis.hasToolUseInput);

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 7: OTEL_LOG_TOOL_CONTENT=true — 显式启用工具内容（需触发工具调用）
   * 预期：tool_result 包含完整内容
   */
  it('case-7 OTEL_LOG_TOOL_CONTENT=true（触发工具调用）', async () => {
    const dir = createTimestampDir('otel-log-options/case-7-tool-content-true');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_CONTENT: 'true',
      },
      prompt: TOOL_TRIGGER_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-7 tool-content-true]', JSON.stringify(analysis, null, 2));

    console.error('[case-7] requestFiles:', analysis.requestFiles);
    console.error('[case-7] hasToolResultMessages:', analysis.hasToolResultMessages);
    console.error('[case-7] hasToolResultContent:', analysis.hasToolResultContent);
    console.error('[case-7] hasToolUseInResponse:', analysis.hasToolUseInResponse);
    console.error('[case-7] hasToolUseInput:', analysis.hasToolUseInput);

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 8: 全部 false — 最小日志模式
   * 预期：日志文件仍然产出（OTEL_LOG_RAW_API_BODIES 控制是否写文件），
   *        但内容被大幅精简
   */
  it('case-8 全部 false（最小日志）', async () => {
    const dir = createTimestampDir('otel-log-options/case-8-all-false');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_CONTENT: 'false',
        OTEL_LOG_TOOL_DETAILS: 'false',
        OTEL_LOG_USER_PROMPTS: 'false',
      },
      prompt: TOOL_TRIGGER_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-8 all-false]', JSON.stringify(analysis, null, 2));

    console.error('[case-8] requestSize:', analysis.requestSize);
    console.error('[case-8] hasUserPromptContent:', analysis.hasUserPromptContent);
    console.error('[case-8] hasToolInputSchema:', analysis.hasToolInputSchema);
    console.error('[case-8] hasToolResultContent:', analysis.hasToolResultContent);

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 9: 全部 true — 最大日志模式（对照组）
   * 预期：所有内容完整记录
   */
  it('case-9 全部 true（最大日志）', async () => {
    const dir = createTimestampDir('otel-log-options/case-9-all-true');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        OTEL_LOG_TOOL_CONTENT: 'true',
        OTEL_LOG_TOOL_DETAILS: 'true',
        OTEL_LOG_USER_PROMPTS: 'true',
      },
      prompt: TOOL_TRIGGER_PROMPT,
    });

    const analysis = analyzeLogDir(dir);
    console.error('\n[case-9 all-true]', JSON.stringify(analysis, null, 2));

    console.error('[case-9] requestSize:', analysis.requestSize);
    console.error('[case-9] hasUserPromptContent:', analysis.hasUserPromptContent);
    console.error('[case-9] hasToolInputSchema:', analysis.hasToolInputSchema);
    console.error('[case-9] hasToolResultContent:', analysis.hasToolResultContent);
    console.error('[case-9] hasToolUseInput:', analysis.hasToolUseInput);

    // 全部 true 应该包含所有内容
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.hasMessages).toBe(true);
    expect(analysis.hasUserPromptContent).toBe(true);
    expect(analysis.hasTools).toBe(true);
    expect(analysis.hasToolInputSchema).toBe(true);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 10: 不设置 OTEL_LOG_RAW_API_BODIES — 验证不写文件
   * 预期：目录为空（SDK 不产出日志文件）
   */
  it('case-10 不设置 OTEL_LOG_RAW_API_BODIES（无日志输出）', async () => {
    const dir = createTimestampDir('otel-log-options/case-10-no-raw-bodies');
    const result = await runQuery({
      env: {
        ...BASE_ENV,
        // 不设置 OTEL_LOG_RAW_API_BODIES
        OTEL_LOG_TOOL_CONTENT: 'true',
        OTEL_LOG_TOOL_DETAILS: 'true',
        OTEL_LOG_USER_PROMPTS: 'true',
      },
      prompt: SIMPLE_PROMPT,
    });

    const allFiles = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    console.error('\n[case-10 no-raw-bodies] files in dir:', allFiles.length);

    // 没有 OTEL_LOG_RAW_API_BODIES，不应产出 JSON 文件
    expect(allFiles.length).toBe(0);
    expect(result.trim().length).toBeGreaterThan(0);
  }, 120000);
});
