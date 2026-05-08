import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';

// 加载 .env 文件
dotenv.config();

describe('Simple Query Demo (简单查询)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0); // 随机端口
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('应该使用 .env 配置调用 Claude API 并返回 SSE 流', async () => {
    const server = app.getHttpServer();
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    console.log('\n========== Simple Query Demo ==========');
    console.log('Prompt: What is 2+2?');
    console.log('======================================\n');

    const response = await fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'What is 2+2? Answer in one short sentence.',
        options: {
          env: {
            ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
            API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
          }
        }
      }),
    });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    console.log('========== 流式响应 ==========');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        // 实时打印每个 SSE 数据块
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            console.log(line);
          }
        }
      }
    }

    console.log('================================\n');

    expect(fullText).toContain('data:');
    expect(fullText).toContain('done');
  });
});
