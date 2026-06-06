import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { getProfileEnv } from './llm-profiles';

dotenv.config();

describe('Local LLM - tools disabled', () => {
  let apiBodyDir: string;

  beforeEach(() => {
    apiBodyDir = createTimestampDir('tools-disabled');
  });

  it('tools 应该为空当 options.tools 为空数组', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        env: {
          ...getProfileEnv('local'),
          OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        },
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        effort: 'low',
        tools: [],
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

      expect(requestBody.tools).toEqual([]);
    } else {
      expect.fail('没有找到 .request.json 文件');
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    // 对目录下所有 JSON 文件进行 pretty 格式化
    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);
});
