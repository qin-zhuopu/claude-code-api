import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import dotenv from 'dotenv';

// 加载 .env 文件
dotenv.config();

describe('Query API Integration (调用真实大模型)', () => {
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

  describe('POST /api/query', () => {
    it('应该使用 .env 配置调用 Claude API 并返回 SSE 流', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/query')
        .send({
          prompt: 'What is 2+2? Answer in one short sentence.',
          options: {
            env: {
              ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
              ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
              API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
            }
          }
        })
        .expect('Content-Type', /text\/event-stream/);

      expect(res.text).toContain('data:');
      expect(res.text).toContain('done');
    });

    it('应该记住对话上下文，知道用户是小明', async () => {
      const envConfig = {
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      };

      // 第一句话：告诉 AI 我是小明
      const res1 = await request(app.getHttpServer())
        .post('/api/query')
        .send({
          prompt: '我是小明，请记住这个名字。',
          options: { env: envConfig }
        })
        .expect('Content-Type', /text\/event-stream/);

      expect(res1.text).toContain('data:');
      expect(res1.text).toContain('done');

      // 第二句话：问 AI 我是谁（使用 continue 继续对话）
      const res2 = await request(app.getHttpServer())
        .post('/api/query')
        .send({
          prompt: '我是谁？请简短回答。',
          options: { continue: true, env: envConfig }
        })
        .expect('Content-Type', /text\/event-stream/);

      expect(res2.text).toContain('data:');
      expect(res2.text).toContain('done');
      // 断言：AI 应该知道用户是小明
      expect(res2.text).toMatch(/小明|Xiaoming|xiaoming/);
    });
  });
});
