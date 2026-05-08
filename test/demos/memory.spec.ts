import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
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
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

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

    // 第一句话：告诉 AI 我是小明
    const res1 = await request(app.getHttpServer())
      .post('/api/query')
      .send({
        prompt: '我是小明，请记住这个名字。',
        options: { env: envConfig }
      })
      .expect('Content-Type', /text\/event-stream/);

    console.log('---------- Response 1 ----------');
    console.log(res1.text);
    console.log('----------------------------------\n');

    expect(res1.text).toContain('data:');
    expect(res1.text).toContain('done');

    console.log('第二轮：问 AI "我是谁？"（使用 continue 继续对话）');
    console.log('================================\n');

    // 第二句话：问 AI 我是谁（使用 continue 继续对话）
    const res2 = await request(app.getHttpServer())
      .post('/api/query')
      .send({
        prompt: '我是谁？请简短回答。',
        options: { continue: true, env: envConfig }
      })
      .expect('Content-Type', /text\/event-stream/);

    console.log('---------- Response 2 ----------');
    console.log(res2.text);
    console.log('----------------------------------\n');

    expect(res2.text).toContain('data:');
    expect(res2.text).toContain('done');
    // 断言：AI 应该知道用户是小明
    expect(res2.text).toMatch(/小明|Xiaoming|xiaoming/);

    console.log('✅ AI 记住了用户是小明！');
    console.log('================================\n');
  });
});
