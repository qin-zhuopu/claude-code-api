import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

describe('SSE Stream Verification (Vitest)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('应该每秒捕获并实时打印 SSE 事件', async () => {
    const response = await fetch(`${baseUrl}/events/timer`);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const arrivalTimes: number[] = [];
    let index = 0;

    console.log('\n🚀 开始捕获 SSE 流...');

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        console.log('✅ 流传输结束');
        break;
      }

      const chunk = decoder.decode(value);

      if (chunk.includes('data:')) {
        const now = Date.now();
        arrivalTimes.push(now);
        index++;

        const timeString = new Date(now).toLocaleTimeString();
        const cleanChunk = chunk.trim();
        console.log(`[${timeString}] 第 ${index} 次捕获: ${cleanChunk}`);

        expect(chunk).toContain('timestamp');
      }
    }

    expect(arrivalTimes.length).toBe(5);

    for (let i = 1; i < arrivalTimes.length; i++) {
      const gap = arrivalTimes[i] - arrivalTimes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(950);
    }
  }, 15000);
});
