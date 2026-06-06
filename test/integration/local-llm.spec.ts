import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { getProfileEnv } from './llm-profiles';

dotenv.config();

describe('Local LLM - OTEL_LOG_RAW_API_BODIES 测试', () => {
  let apiBodyDir: string;

  beforeEach(() => {
    apiBodyDir = createTimestampDir('local-llm');
  });

  it('应该能通过 OTEL_LOG_RAW_API_BODIES 捕获首次请求', async () => {
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
      } as any,
    });

    const startTime = Date.now();
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

    const totalTime = Date.now() - startTime;
    console.error(`\n\n📊 总耗时: ${totalTime}ms`);
    console.error(`📋 回复: ${resultText}`);

    // 检查目录是否存在文件
    expect(existsSync(apiBodyDir)).toBe(true);

    const allFiles = readdirSync(apiBodyDir);
    console.error(`📁 目录中的文件 (${allFiles.length}):`, allFiles);

    const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
    const responseFiles = allFiles.filter(f => f.endsWith('.response.json'));

    console.error(`📋 request 文件数: ${requestFiles.length}`);
    console.error(`📋 response 文件数: ${responseFiles.length}`);

    if (requestFiles.length > 0) {
      // 读取第一个请求文件
      const firstFile = requestFiles.sort()[0];
      const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
      const requestBody = JSON.parse(content);

      console.error(`\n✅ 成功捕获 API 请求!`);
      console.error(`📋 请求 keys: ${Object.keys(requestBody).join(', ')}`);
      console.error(`📋 model: ${requestBody.model}`);
      console.error(`📋 system prompt 类型: ${typeof requestBody.system}`);
      console.error(`📋 system prompt 长度: ${JSON.stringify(requestBody.system)?.length}`);
      console.error(`📋 messages 数量: ${requestBody.messages?.length}`);
      console.error(`📋 tools 数量: ${requestBody.tools?.length}`);

      // system prompt 前 100 字符
      const systemStr = JSON.stringify(requestBody.system, null, 2);
      console.error(`\n📋 System Prompt (前100字符):\n${systemStr.slice(0, 100)}`);

      // 断言：验证请求体的完整结构
      const expectedKeys = [
        'model',
        'messages',
        'system',
        'tools',
        'betas',
        'metadata',
        'max_tokens',
        'thinking',
        'context_management',
        'output_config',
        'stream',
      ];
      for (const key of expectedKeys) {
        expect(requestBody).toHaveProperty(key);
      }

      // 验证关键字段的类型和内容
      expect(requestBody.model).toBe('Jereh-LLM-NO-THINK-V1');
      expect(requestBody.messages).toBeInstanceOf(Array);
      expect(requestBody.messages.length).toBeGreaterThan(0);
      expect(requestBody.system).toBeInstanceOf(Array);
      expect(requestBody.tools).toBeInstanceOf(Array);
      expect(requestBody.tools.length).toBeGreaterThan(0);
      expect(requestBody.stream).toBe(true);
      expect(requestBody.max_tokens).toBeTypeOf('number');
    } else {
      expect.fail('没有找到 .request.json 文件，OTEL_LOG_RAW_API_BODIES=file: 模式未生效');
    }

    expect(resultText.trim().length).toBeGreaterThan(0);

    // 对目录下所有 JSON 文件进行 pretty 格式化
    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);
});
