/**
 * AskUserQuestion 工具观察性测试（双环境交叉对比）
 *
 * 两组 LLM 后端：
 * - Jereh: http://10.1.3.115:4000 (Jereh-LLM-NO-THINK-V1)
 * - GLM:   https://open.bigmodel.cn/api/anthropic (glm-4.7 / glm-4.5-air)
 *
 * 观察 AskUserQuestion 工具在 SDK 中的行为：
 * - 默认 tools 列表中是否包含 AskUserQuestion（SDK 行为，应与 LLM 无关）
 * - AskUserQuestion 的 input_schema 结构（SDK 行为）
 * - toolConfig.previewFormat 对 schema/description 的影响（SDK 行为）
 * - tools 列表中排除 AskUserQuestion（SDK 行为）
 * - LLM 是否愿意调用 AskUserQuestion（LLM 行为差异）
 * - canUseTool 回调的交互流程
 *
 * 方法论：观察性测试 — 对比两组 LLM 后端下 SDK 产出的请求/响应，
 * 区分 SDK 固定行为 vs LLM 依赖行为。
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ─── 双环境配置 ─────────────────────────────────────────────────────────────

const ENVIRONMENTS = [
  {
    label: 'Jereh',
    env: {
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
    },
  },
  {
    label: 'GLM',
    env: {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_BIGMODEL,
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_TRACES_EXPORTER: 'none',
    },
  },
] as const;

// ─── 分析工具 ───────────────────────────────────────────────────────────────

interface AskUserQuestionAnalysis {
  totalFiles: number;
  requestFiles: number;
  responseFiles: number;
  hasAskUserQuestionTool: boolean;
  askUserQuestionSchema: Record<string, unknown> | null;
  askUserQuestionSchemaProperties: string[];
  questionsSchema: Record<string, unknown> | null;
  optionsHavePreview: boolean;
  hasAskUserQuestionToolUse: boolean;
  askUserQuestionToolUseInput: Record<string, unknown> | null;
  allAskUserQuestionToolUses: Array<{ input: Record<string, unknown>; id: string }>;
  hasSecondRequest: boolean;
  hasAskUserQuestionToolResult: boolean;
  toolResultContent: string | null;
  toolsCount: number;
  toolNames: string[];
  askToolDescriptionLength: number;
  askToolDescHasHtml: boolean;
  askToolDescHasMarkdown: boolean;
  requestSize: number;
}

function analyzeAskUserQuestionLogs(dir: string): AskUserQuestionAnalysis {
  const allFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'))
    : [];
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const analysis: AskUserQuestionAnalysis = {
    totalFiles: allFiles.length,
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    hasAskUserQuestionTool: false,
    askUserQuestionSchema: null,
    askUserQuestionSchemaProperties: [],
    questionsSchema: null,
    optionsHavePreview: false,
    hasAskUserQuestionToolUse: false,
    askUserQuestionToolUseInput: null,
    allAskUserQuestionToolUses: [],
    hasSecondRequest: false,
    hasAskUserQuestionToolResult: false,
    toolResultContent: null,
    toolsCount: 0,
    toolNames: [],
    askToolDescriptionLength: 0,
    askToolDescHasHtml: false,
    askToolDescHasMarkdown: false,
    requestSize: 0,
  };

  for (const rf of requestFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    if (rf === requestFiles[0]) {
      analysis.requestSize = content.length;
    }

    try {
      const body = JSON.parse(content);

      if (rf === requestFiles[0]) {
        if (Array.isArray(body.tools)) {
          analysis.toolsCount = body.tools.length;
          analysis.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);

          const askTool = body.tools.find((t: any) => t.name === 'AskUserQuestion');
          if (askTool) {
            analysis.hasAskUserQuestionTool = true;
            analysis.askUserQuestionSchema = askTool.input_schema || null;
            analysis.askToolDescriptionLength = askTool.description?.length || 0;
            analysis.askToolDescHasHtml = /html/i.test(askTool.description || '');
            analysis.askToolDescHasMarkdown = /markdown|ascii/i.test(askTool.description || '');

            if (askTool.input_schema?.properties) {
              analysis.askUserQuestionSchemaProperties = Object.keys(askTool.input_schema.properties);

              const questionsProp = askTool.input_schema.properties.questions;
              if (questionsProp) {
                analysis.questionsSchema = questionsProp;

                const items = questionsProp.items;
                if (items?.properties?.options?.items?.properties) {
                  analysis.optionsHavePreview = 'preview' in items.properties.options.items.properties;
                }
              }
            }
          }
        }
      }

      if (rf !== requestFiles[0]) {
        analysis.hasSecondRequest = true;
      }
      if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_result') {
                analysis.hasAskUserQuestionToolResult = true;
                if (typeof block.content === 'string') {
                  analysis.toolResultContent = block.content;
                } else if (Array.isArray(block.content)) {
                  const textBlocks = block.content.filter((b: any) => b.type === 'text');
                  if (textBlocks.length > 0) {
                    analysis.toolResultContent = textBlocks.map((b: any) => b.text).join('\n');
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`[analyzeAskUserQuestionLogs] Failed to parse request: ${rf}`);
    }
  }

  for (const rf of responseFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    try {
      const body = JSON.parse(content);
      if (Array.isArray(body.content)) {
        for (const block of body.content) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            analysis.hasAskUserQuestionToolUse = true;
            if (!analysis.askUserQuestionToolUseInput) {
              analysis.askUserQuestionToolUseInput = block.input || null;
            }
            analysis.allAskUserQuestionToolUses.push({
              input: block.input || {},
              id: block.id || '',
            });
          }
        }
      }
    } catch (e) {
      console.error(`[analyzeAskUserQuestionLogs] Failed to parse response: ${rf} (${content.length} bytes)`);
    }
  }

  return analysis;
}

// ─── runQuery 封装 ──────────────────────────────────────────────────────────

interface RunQueryOptions {
  env: Record<string, string | undefined>;
  prompt: string;
  tools?: string[];
  toolConfig?: Record<string, unknown>;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
}

async function runQuery(options: RunQueryOptions): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.toolConfig !== undefined ? { toolConfig: options.toolConfig } : {}),
      ...(options.canUseTool !== undefined ? { canUseTool: options.canUseTool } : {}),
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

// ─── 交叉对比：SDK 层行为（应与 LLM 无关）──────────────────────────────────

describe.each(ENVIRONMENTS)('AskUserQuestion SDK 行为 [$label]', ({ label, env: BASE_ENV }) => {

  /**
   * Case 1: 基线 — 默认配置，简单 prompt
   * SDK 行为：AskUserQuestion 应始终在 tools 列表中
   */
  it('case-1 基线：默认 tools 包含 AskUserQuestion', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-1-baseline`);
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hello world". Nothing else.',
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-1]`, JSON.stringify(analysis, null, 2));

    // SDK 行为断言（不应因 LLM 不同而变化）
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.responseFiles).toBeGreaterThan(0);
    expect(analysis.hasAskUserQuestionTool).toBe(true);
    expect(analysis.hasAskUserQuestionToolUse).toBe(false);
    expect(analysis.askUserQuestionSchemaProperties).toContain('questions');

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 2: input_schema 详细结构
   * SDK 行为：schema 结构完全由 SDK 决定
   */
  it('case-2 input_schema 结构', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-2-schema`);
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "ok".',
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-2] Schema properties:`, analysis.askUserQuestionSchemaProperties);

    expect(analysis.hasAskUserQuestionTool).toBe(true);
    expect(analysis.askUserQuestionSchema).not.toBeNull();

    if (analysis.askUserQuestionSchema) {
      const schema = analysis.askUserQuestionSchema as any;
      // SDK 层面的结构断言
      expect(schema.type).toBe('object');
      expect(schema.required).toContain('questions');
      expect(analysis.askUserQuestionSchemaProperties).toContain('answers');
      expect(analysis.askUserQuestionSchemaProperties).toContain('annotations');
      expect(analysis.askUserQuestionSchemaProperties).toContain('metadata');

      if (schema.properties?.questions?.items?.properties) {
        const qp = schema.properties.questions.items.properties;
        expect(qp).toHaveProperty('question');
        expect(qp).toHaveProperty('header');
        expect(qp).toHaveProperty('options');
        expect(qp).toHaveProperty('multiSelect');

        if (qp.options?.items?.properties) {
          expect(qp.options.items.properties).toHaveProperty('label');
          expect(qp.options.items.properties).toHaveProperty('description');
        }
      }
    }

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 3: 禁用 AskUserQuestion
   * SDK 行为：tools 选项控制工具可用性
   */
  it('case-3 禁用 AskUserQuestion', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-3-no-ask-tool`);
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Which testing framework should I use? Jest or Vitest?',
      tools: ['Read', 'Grep', 'Glob'],
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-3]`, JSON.stringify(analysis, null, 2));

    expect(analysis.hasAskUserQuestionTool).toBe(false);
    expect(analysis.toolNames).not.toContain('AskUserQuestion');

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 4: toolConfig previewFormat=html
   * SDK 行为：description 内容变化
   */
  it('case-4 previewFormat=html', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-4-preview-html`);
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "ok".',
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-4] descLen=${analysis.askToolDescriptionLength} hasHtml=${analysis.askToolDescHasHtml} preview=${analysis.optionsHavePreview}`);

    expect(analysis.hasAskUserQuestionTool).toBe(true);
    expect(analysis.optionsHavePreview).toBe(true);
    expect(analysis.askToolDescriptionLength).toBeGreaterThan(1500);
    expect(analysis.askToolDescHasHtml).toBe(true);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 5: toolConfig previewFormat=markdown
   * SDK 行为：description 内容变化
   */
  it('case-5 previewFormat=markdown', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-5-preview-markdown`);
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "ok".',
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-5] descLen=${analysis.askToolDescriptionLength} hasMd=${analysis.askToolDescHasMarkdown}`);

    expect(analysis.hasAskUserQuestionTool).toBe(true);
    expect(analysis.optionsHavePreview).toBe(true);
    expect(analysis.askToolDescriptionLength).toBeGreaterThan(1600);
    expect(analysis.askToolDescHasMarkdown).toBe(true);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 6: 默认（无 toolConfig）
   * SDK 行为：最短 description，无 preview 指令
   */
  it('case-6 默认无 toolConfig', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-6-default-preview`);
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "ok".',
    });

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-6] descLen=${analysis.askToolDescriptionLength} hasHtml=${analysis.askToolDescHasHtml} hasMd=${analysis.askToolDescHasMarkdown}`);

    expect(analysis.hasAskUserQuestionTool).toBe(true);
    expect(analysis.optionsHavePreview).toBe(true);
    expect(analysis.askToolDescriptionLength).toBeLessThan(1200);
    expect(analysis.askToolDescHasHtml).toBe(false);
    expect(analysis.askToolDescHasMarkdown).toBe(false);

    prettyFormatJsonFiles(dir);
  }, 120000);
});

// ─── 交叉对比：LLM 行为差异（触发 AskUserQuestion）────────────────────────

describe.each(ENVIRONMENTS)('AskUserQuestion LLM 行为 [$label]', ({ label, env: BASE_ENV }) => {

  /**
   * Case 7: 触发 AskUserQuestion + canUseTool 单选回答
   * LLM 行为：不同 LLM 是否愿意调用 AskUserQuestion、tool_use 格式是否正确
   */
  it('case-7 触发 AskUserQuestion + canUseTool 单选', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-7-trigger`);
    let result = '';
    try {
      result = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Use the AskUserQuestion tool to ask me which testing framework I prefer: Jest, Vitest, or Mocha. Then tell me my choice.',
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            const questions = (input as any).questions || [];
            const answers: Record<string, string> = {};
            for (const q of questions) {
              if (q.options && q.options.length > 0) {
                answers[q.question] = q.options[0].label;
              }
            }
            console.error(`[${label} case-7 canUseTool]`, JSON.stringify(answers));
            return { behavior: 'allow', updatedInput: { questions, answers } };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      });
    } catch (e: any) {
      console.error(`[${label} case-7] SDK error:`, e.message);
    }

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-7]`, JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);

    if (analysis.hasAskUserQuestionToolUse) {
      console.error(`[${label} case-7] LLM 调用了 AskUserQuestion`);

      if (analysis.askUserQuestionToolUseInput) {
        const input = analysis.askUserQuestionToolUseInput as any;
        console.error(`[${label} case-7] tool_use input:`, JSON.stringify(input, null, 2));
        expect(input).toHaveProperty('questions');

        if (Array.isArray(input.questions) && input.questions.length > 0) {
          const q = input.questions[0];
          expect(q).toHaveProperty('question');
          expect(q).toHaveProperty('header');
          expect(q).toHaveProperty('options');
          expect(Array.isArray(q.options)).toBe(true);
          expect(q.options.length).toBeGreaterThanOrEqual(2);
        }
      }

      if (analysis.hasSecondRequest) {
        expect(analysis.hasAskUserQuestionToolResult).toBe(true);
      }
    } else {
      console.error(`[${label} case-7] LLM 未调用 AskUserQuestion（直接文本回答）`);
    }

    if (result) {
      expect(result.trim().length).toBeGreaterThan(0);
    }
    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 8: 多选 canUseTool 回答
   * LLM 行为：multiSelect 场景下 tool_use 的格式差异
   */
  it('case-8 多选 canUseTool', async () => {
    const dir = createTimestampDir(`ask-user-question/${label}/case-8-multiselect`);
    let result = '';
    try {
      result = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Use the AskUserQuestion tool to ask me which features I want to enable: TypeScript, ESLint, Prettier, or Husky. Set multiSelect to true. Then summarize my choices.',
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            const questions = (input as any).questions || [];
            const answers: Record<string, string> = {};
            for (const q of questions) {
              if (q.options && q.options.length >= 2) {
                answers[q.question] = `${q.options[0].label}, ${q.options[1].label}`;
              }
            }
            console.error(`[${label} case-8 canUseTool]`, JSON.stringify(answers));
            return { behavior: 'allow', updatedInput: { questions, answers } };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      });
    } catch (e: any) {
      console.error(`[${label} case-8] SDK error:`, e.message);
    }

    const analysis = analyzeAskUserQuestionLogs(dir);
    console.error(`\n[${label} case-8]`, JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);

    if (analysis.hasAskUserQuestionToolUse && analysis.askUserQuestionToolUseInput) {
      const input = analysis.askUserQuestionToolUseInput as any;
      console.error(`[${label} case-8] tool_use input:`, JSON.stringify(input, null, 2));
      if (input.questions?.[0]) {
        console.error(`[${label} case-8] multiSelect:`, input.questions[0].multiSelect);
      }
    }

    if (analysis.hasSecondRequest) {
      expect(analysis.hasAskUserQuestionToolResult).toBe(true);
    }
    if (result) {
      expect(result.trim().length).toBeGreaterThan(0);
    }
    prettyFormatJsonFiles(dir);
  }, 240000);
});
