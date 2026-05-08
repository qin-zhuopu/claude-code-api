import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import dotenv from 'dotenv';

// 加载 .env 文件
dotenv.config();

describe('Query API (e2e)', () => {
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

  describe('POST /api/query/interrupt', () => {
    it('应该返回不存在的会话错误', () => {
      return request(app.getHttpServer())
        .post('/api/query/interrupt')
        .send({ sessionId: 'non_existent_session' })
        .expect((res) => {
          expect(res.body.success).toBe(false);
          expect(res.body.error).toContain('not found');
        });
    });
  });

  describe('POST /api/query/stats', () => {
    it('应该返回活跃查询数量', () => {
      return request(app.getHttpServer())
        .post('/api/query/stats')
        .expect((res) => {
          expect(res.body).toHaveProperty('activeQueries');
          expect(typeof res.body.activeQueries).toBe('number');
        });
    });
  });

  describe('POST /api/query', () => {
    it('应该拒绝不合法的请求体', () => {
      return request(app.getHttpServer())
        .post('/api/query')
        .send({})
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toEqual(
            expect.arrayContaining([expect.stringContaining('prompt')]),
          );
        });
    });

    it('env 为空时应该返回认证错误', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/query')
        .send({
          prompt: 'What is 2+2?',
          options: { env: [] }
        })
        .expect('Content-Type', /text\/event-stream/);

      expect(res.text).toContain('data:');
      expect(res.text).toMatch(/Not logged in|authentication/i);
    });

    it('应该使用系统环境变量调用 Claude API 并返回 SSE 流', async () => {
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
  });
});
