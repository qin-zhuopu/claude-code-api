import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

const ADDITIONAL_DIR = resolve(__dirname, 'fixtures', 'additional-dir');
const PROJECT_WITH_SKILLS = resolve(__dirname, 'fixtures', 'project-with-skills');
const EMPTY_PROJECT = resolve(__dirname, 'fixtures', 'empty-project');

function getRequestBodyText(apiBodyDir: string): string {
  const allFiles = readdirSync(apiBodyDir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
  if (requestFiles.length === 0) throw new Error('没有找到 .request.json 文件');

  const firstFile = requestFiles.sort()[0];
  const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
  const requestBody = JSON.parse(content);

  const userMessage = requestBody.messages[0];
  return userMessage.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');
}

describe('自定义 skill 注入', () => {
  let apiBodyDir: string;

  beforeEach(() => {
    apiBodyDir = createTimestampDir('additional-directories');
  });

  it('通过 cwd 指向含 .claude/skills 的目录，自定义 skill 应出现在请求中', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        cwd: PROJECT_WITH_SKILLS,
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
          OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        },
        includePartialMessages: true,
        persistSession: false,
        effort: 'low',
        tools: ['Skill'],
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

    expect(existsSync(apiBodyDir)).toBe(true);

    const allText = getRequestBodyText(apiBodyDir);
    console.error('\n📋 skill 列表片段:', allText.slice(0, 800));

    // 断言：自定义 skill 应该出现
    expect(allText).toContain('greet');
    expect(allText).toContain('joke');
    expect(allText).toContain('greeting');
    expect(allText).toContain('programming joke');

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  it('通过 additionalDirectories 注入的 skill 应出现在请求中', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        cwd: EMPTY_PROJECT,
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
          OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        },
        additionalDirectories: [ADDITIONAL_DIR],
        includePartialMessages: true,
        persistSession: false,
        effort: 'low',
        tools: ['Skill'],
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

    expect(existsSync(apiBodyDir)).toBe(true);

    const allText = getRequestBodyText(apiBodyDir);
    console.error('\n📋 skill 列表片段:', allText.slice(0, 800));

    // 断言：通过 additionalDirectories 注入的 skill 应该出现
    expect(allText).toContain('greet');
    expect(allText).toContain('joke');
    expect(allText).toContain('greeting');
    expect(allText).toContain('programming joke');

    expect(resultText.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);
});
