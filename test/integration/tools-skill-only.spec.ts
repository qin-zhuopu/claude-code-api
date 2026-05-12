import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

describe('Local LLM - skill tool only', () => {
  let apiBodyDir: string;

  beforeEach(() => {
    apiBodyDir = createTimestampDir('tools-skill-only');
  });

  it('tools 应该只包含 Skill 工具', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
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
        settingSources: [],
        effort: 'low',
        tools: ['Skill'],
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

    expect(existsSync(apiBodyDir)).toBe(true);

    const allFiles = readdirSync(apiBodyDir);
    const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));

    if (requestFiles.length > 0) {
      const firstFile = requestFiles.sort()[0];
      const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
      const requestBody = JSON.parse(content);

      console.error(`\n📋 tools 数量: ${requestBody.tools?.length}`);
      console.error(`📋 tool names: ${requestBody.tools?.map((t: any) => t.name).join(', ')}`);

      // 验证 tools 只包含 Skill 相关的工具
      expect(requestBody.tools).toBeInstanceOf(Array);
      expect(requestBody.tools.length).toBeGreaterThan(0);

      const toolNames: string[] = requestBody.tools.map((t: any) => t.name);
      for (const name of toolNames) {
        expect(name.toLowerCase()).toContain('skill');
      }
    } else {
      expect.fail('没有找到 .request.json 文件');
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    // 对目录下所有 JSON 文件进行 pretty 格式化
    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);
});
