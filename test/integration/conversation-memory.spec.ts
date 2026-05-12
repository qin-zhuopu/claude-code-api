import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import dotenv from 'dotenv';

dotenv.config();

const queryOptions = {
  env: {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  },
  agent: 'simple',
  agents: {
    simple: {
      description: 'Simple fast agent',
      prompt: '你是一个简单的助手，简短回答问题，不要使用任何工具。',
      model: 'haiku',
      tools: [],
      skills: [],
    },
  },
  persistSession: true,
  effort: 'low',
};

async function query(baseUrl: string, prompt: string, extra?: Record<string, any>) {
  const response = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      options: { ...queryOptions, ...extra },
    }),
  });

  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
  expect(response.ok).toBe(true);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sessionId = '';
  let resultText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const match = line.match(/^data:\s*(.+)$/);
      if (!match) continue;

      const raw = JSON.parse(match[1]);

      try {
        const inner = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw.content;
        // 提取 session_id（来自 init 事件）
        if (inner.type === 'system' && inner.subtype === 'init' && inner.session_id) {
          sessionId = inner.session_id;
        }
        // 提取 result 文本
        if (inner.type === 'result' && inner.result) {
          resultText = inner.result;
        }
      } catch {}
    }
  }

  return { sessionId, resultText };
}

describe('Conversation Memory', () => {
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

  it('应该在同一会话中记住上下文', async () => {
    // 第一步：告诉 AI 名字
    console.error('\n📝 第一步：告诉 AI 我叫小红');
    const first = await query(baseUrl, '我叫小红，记住我的名字');
    console.error(`  session_id: ${first.sessionId}`);
    console.error(`  回复: ${first.resultText}`);

    expect(first.sessionId).toBeTruthy();
    expect(first.resultText.length).toBeGreaterThan(0);

    // 第二步：问 AI 我叫什么
    console.error('\n📝 第二步：问 AI 我叫什么名字');
    const second = await query(baseUrl, '我叫什么名字？', { resume: first.sessionId });
    console.error(`  session_id: ${second.sessionId}`);
    console.error(`  回复: ${second.resultText}`);

    expect(second.resultText).toContain('小红');
  }, 120000);
});
