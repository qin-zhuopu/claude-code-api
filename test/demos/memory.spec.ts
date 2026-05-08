import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';

// 加载 .env 文件
dotenv.config();

describe('Memory Demo (对话记忆)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  async function streamQuery(prompt: string, options: any) {
    const server = app.getHttpServer();
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, options }),
    });

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

    return fullText;
  }

  it('应该记住对话上下文，知道用户是小明', async () => {
    const envConfig = {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    };

    console.log('\n========== Memory Demo ==========');
    console.log('第一轮：告诉 AI "我是小明"');
    console.log('================================\n');

    const text1 = await streamQuery('我是小明，请记住这个名字。', { env: envConfig });
    expect(text1).toContain('data:');
    expect(text1).toContain('done');

    console.log('\n第二轮：问 AI "我是谁？"（使用 continue 继续对话）');
    console.log('================================\n');

    const text2 = await streamQuery('我是谁？请简短回答。', { continue: true, env: envConfig });
    expect(text2).toContain('data:');
    expect(text2).toContain('done');
    expect(text2).toMatch(/小明|Xiaoming|xiaoming/);

    console.log('\n✅ AI 记住了用户是小明！');
    console.log('================================\n');
  });
});
