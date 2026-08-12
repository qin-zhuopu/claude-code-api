import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';

// 加载 .env 文件
dotenv.config();

describe('Query API (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  describe('异常情况', () => {
    it('POST /api/query/interrupt - 应该返回不存在的会话错误', async () => {
      const response = await fetch(`${baseUrl}/api/query/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'non_existent_session' }),
      });

      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('POST /api/query - 应该拒绝不合法的请求体', async () => {
      const response = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it('POST /api/query - env 为空时应该返回认证错误', async () => {
      const response = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'What is 2+2?',
          options: { env: {} },
        }),
      });

      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        const chunks: string[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value));
        }
        const fullText = chunks.join('');
        expect(fullText).toMatch(/Not logged in|authentication|error/i);
      }
    });
  });

  describe('正常业务流程', () => {
    it('POST /api/query/stats - 应该返回活跃查询数量', async () => {
      const response = await fetch(`${baseUrl}/api/query/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await response.json();
      expect(result).toHaveProperty('activeQueries');
      expect(typeof result.activeQueries).toBe('number');
    });

    it('POST /api/query - 应该实时流式输出响应', async () => {
      const prompt = '你好';

      const response = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          options: {
            env: getProfileEnv('bigmodel', { includeBehaviorEnv: false, includeModelNames: false }),
            agent: 'simple',
            agents: {
              simple: {
                description: 'Simple fast agent',
                prompt: '你是一个简单的助手，简短回答问题。',
                model: 'haiku',
                tools: [],
                skills: [],
              },
            },
            includePartialMessages: true,
            persistSession: false,
            effort: 'low',
          },
        }),
      });

      // 断言 SSE 响应头
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(response.ok).toBe(true);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('响应体为空');
      }

      let charCount = 0;
      let thinkingCount = 0;
      let eventCount = 0;
      let buffer = '';
      let fullText = '';
      let thinkingText = '';
      let secondBuffer = '';
      let secondThinkingBuffer = '';
      let lastSecondTime = Date.now();
      let secondIndex = 0;

      console.log('\n🚀 开始捕获 Claude API 流式输出...\n');
      console.log('========== 每秒增量输出 ==========\n');

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (secondBuffer || secondThinkingBuffer) {
            secondIndex++;
            const timeString = new Date().toLocaleTimeString();
            console.error(`[${timeString}] 第 ${secondIndex} 秒:`);
            if (secondThinkingBuffer) {
              console.error(`  🧠 思考: ${secondThinkingBuffer}`);
            }
            if (secondBuffer) {
              console.error(`  💬 回复: ${secondBuffer}`);
            }
            console.error('---');
          }
          console.error('\n✅ 流传输结束');
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            eventCount++;
            try {
              const json = JSON.parse(line.slice(5).trim());

              if ((json.type === 'text' || json.type === 'partial') && json.content) {
                const inner = typeof json.content === 'string'
                  ? JSON.parse(json.content)
                  : json.content;

                if (inner.type === 'stream_event' && inner.event?.type === 'content_block_delta') {
                  const delta = inner.event.delta;
                  if (delta?.type === 'text_delta' && delta.text) {
                    const text = delta.text;
                    charCount += text.length;
                    fullText += text;
                    secondBuffer += text;
                  }
                  if (delta?.type === 'thinking_delta' && delta.thinking) {
                    const thinking = delta.thinking;
                    thinkingCount += thinking.length;
                    thinkingText += thinking;
                    secondThinkingBuffer += thinking;
                  }
                }
              }
            } catch {
              // 忽略解析错误
            }
          }
        }

        const now = Date.now();
        if (now - lastSecondTime >= 1000) {
          secondIndex++;
          const timeString = new Date(now).toLocaleTimeString();
          // 使用 console.error 强制实时输出（避免 vitest 缓冲）
          console.error(`[${timeString}] 第 ${secondIndex} 秒:`);
          if (secondThinkingBuffer) {
            console.error(`  🧠 思考: ${secondThinkingBuffer}`);
          } else if (secondBuffer) {
            console.error(`  🧠 思考: (无)`);
          }
          if (secondBuffer) {
            console.error(`  💬 回复: ${secondBuffer}`);
          } else {
            console.error(`  💬 回复: (无)`);
          }
          console.error('---');
          secondBuffer = '';
          secondThinkingBuffer = '';
          lastSecondTime = now;
        }
      }

      console.error(`\n📊 统计: 接收到 ${eventCount} 个 SSE 事件，回复 ${charCount} 字符，思考 ${thinkingCount} 字符\n`);

      expect(charCount).toBeGreaterThanOrEqual(10);
      expect(eventCount).toBeGreaterThan(0);
    }, 120000);
  });
});
