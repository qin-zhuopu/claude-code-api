import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import dotenv from 'dotenv';

dotenv.config();

interface CapturedEvent {
  index: number;
  serverTs: number;
  clientTs: number;
  raw: any;
}

describe('Stream Authenticity', () => {
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

  it('应该证明 SSE 输出是真正的逐 token 流式推送', async () => {
    const requestStart = Date.now();

    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '用三句话介绍太阳系',
        options: {
          env: {
            ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_BIGMODEL,
            ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
            API_TIMEOUT_MS: '3000000',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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
          includePartialMessages: true,
          persistSession: false,
          effort: 'low',
        },
      }),
    });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(response.ok).toBe(true);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // 采集所有 SSE 事件
    const events: CapturedEvent[] = [];
    let buffer = '';
    let eventIndex = 0;
    let streamEnd = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamEnd = Date.now();
        break;
      }

      // chunk 到达时立即打时间戳
      const chunkTs = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const match = line.match(/^data:\s*(.+)$/);
        if (!match) continue;

        const raw = JSON.parse(match[1]);

        events.push({
          index: eventIndex++,
          serverTs: raw.ts || chunkTs,
          clientTs: chunkTs,
          raw,
        });
      }
    }

    const totalDuration = streamEnd - requestStart;

    // ===== 提取关键数据 =====

    // 所有 content_block_delta + text_delta 事件
    const textDeltas = events.filter((e) => {
      try {
        const inner = typeof e.raw.content === 'string' ? JSON.parse(e.raw.content) : e.raw.content;
        return (
          inner.type === 'stream_event' &&
          inner.event?.type === 'content_block_delta' &&
          inner.event.delta?.type === 'text_delta'
        );
      } catch { return false; }
    });

    // 所有 content_block_delta + thinking_delta 事件
    const thinkingDeltas = events.filter((e) => {
      try {
        const inner = typeof e.raw.content === 'string' ? JSON.parse(e.raw.content) : e.raw.content;
        return (
          inner.type === 'stream_event' &&
          inner.event?.type === 'content_block_delta' &&
          inner.event.delta?.type === 'thinking_delta'
        );
      } catch { return false; }
    });

    // 拼接 partial 文本
    const partialText = textDeltas
      .map((e) => {
        const inner = typeof e.raw.content === 'string' ? JSON.parse(e.raw.content) : e.raw.content;
        return inner.event.delta.text || '';
      })
      .join('');

    // 提取 result 文本
    const resultEvent = events.find((e) => {
      try {
        const inner = typeof e.raw.content === 'string' ? JSON.parse(e.raw.content) : e.raw.content;
        return inner.type === 'result';
      } catch { return false; }
    });

    const resultText = resultEvent
      ? (() => {
          const inner = typeof resultEvent.raw.content === 'string'
            ? JSON.parse(resultEvent.raw.content) : resultEvent.raw.content;
          return inner.result || '';
        })()
      : '';

    // ===== 断言 1: TTFT 比率 =====
    // 从首个 SSE 事件（init）开始算，排除 SDK 子进程初始化时间
    const streamStartTs = events.length > 0 ? events[0].serverTs : requestStart;
    const firstPartial = events.find((e) => e.raw.type === 'partial');
    const ttft = firstPartial
      ? firstPartial.serverTs - streamStartTs
      : totalDuration;
    const streamEndTs = events.length > 0 ? events[events.length - 1].serverTs : streamEnd;
    const streamDuration = streamEndTs - streamStartTs;
    const ttftRatio = streamDuration > 0 ? ttft / streamDuration : 1;

    // ===== 断言 2: 事件时间跨度 =====
    // 看所有 partial 事件的跨度（包括 thinking + text）
    const allPartials = events.filter((e) => e.raw.type === 'partial');
    const eventSpan = allPartials.length >= 2
      ? allPartials[allPartials.length - 1].serverTs - allPartials[0].serverTs
      : 0;
    const spanRatio = streamDuration > 0 ? eventSpan / streamDuration : 0;

    // ===== 断言 3: 服务端-客户端延迟方差 =====
    const partialEvents = events.filter((e) => e.raw.type === 'partial');
    const delays = partialEvents.map((e) => e.clientTs - e.serverTs);
    const avgDelay = delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
    const delayVariance = delays.length > 1
      ? delays.reduce((sum, d) => sum + (d - avgDelay) ** 2, 0) / (delays.length - 1)
      : 0;
    const delayStddev = Math.sqrt(delayVariance);

    // ===== 诊断报告 =====
    console.error('\n📊 流式输出真伪分析报告');
    console.error('═══════════════════════════════════');
    console.error(`总事件数: ${events.length}`);
    console.error(`有效 text_delta 事件: ${textDeltas.length}`);
    console.error(`thinking_delta 事件: ${thinkingDeltas.length}`);
    console.error('');
    console.error('⏱ 时序分析 (基于 serverTs, 排除 SDK 初始化):');
    console.error(`  请求开始:         ${requestStart}`);
    console.error(`  流开始(init):     ${streamStartTs}  (SDK 初始化 ${streamStartTs - requestStart}ms)`);
    console.error(`  首 partial 到达:  ${firstPartial?.serverTs || 'N/A'}  (+${ttft}ms, 占流时长 ${(ttftRatio * 100).toFixed(1)}%)`);
    console.error(`  首 text_delta:    ${textDeltas[0]?.serverTs || 'N/A'}`);
    console.error(`  最后 partial:     ${allPartials[allPartials.length - 1]?.serverTs || 'N/A'}`);
    console.error(`  最后事件:         ${streamEndTs}`);
    console.error(`  总时长(client):   ${totalDuration}ms`);
    console.error(`  流时长(server):   ${streamDuration}ms`);
    console.error('');
    console.error('📈 延迟分析 (clientTs - serverTs):');
    console.error(`  平均: ${avgDelay.toFixed(0)}ms`);
    console.error(`  标准差: ${delayStddev.toFixed(0)}ms`);
    console.error(`  最大: ${Math.max(...delays, 0)}ms`);
    console.error(`  最小: ${delays.length > 0 ? Math.min(...delays) : 0}ms`);
    console.error('');

    // 打印事件时间分布
    console.error('📋 事件时间分布 (每 2 秒区间的事件数):');
    if (events.length > 0) {
      const firstTs = events[0].serverTs;
      const lastTs = events[events.length - 1].serverTs;
      const bucketSize = 2000;
      const bucketCount = Math.ceil((lastTs - firstTs) / bucketSize) + 1;
      const buckets = Array.from({ length: bucketCount }, () => ({ total: 0, text: 0, thinking: 0, other: 0 }));

      for (const e of events) {
        const bucketIdx = Math.min(Math.floor((e.serverTs - firstTs) / bucketSize), bucketCount - 1);
        buckets[bucketIdx].total++;
        const inner = (() => { try { return typeof e.raw.content === 'string' ? JSON.parse(e.raw.content) : e.raw.content; } catch { return null; } })();
        if (inner?.type === 'stream_event' && inner.event?.type === 'content_block_delta') {
          if (inner.event.delta?.type === 'text_delta') buckets[bucketIdx].text++;
          else if (inner.event.delta?.type === 'thinking_delta') buckets[bucketIdx].thinking++;
          else buckets[bucketIdx].other++;
        } else {
          buckets[bucketIdx].other++;
        }
      }

      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const startS = (i * bucketSize / 1000).toFixed(0).padStart(4);
        const endS = ((i + 1) * bucketSize / 1000).toFixed(0).padStart(4);
        console.error(`  ${startS}s - ${endS}s: 总${String(b.total).padStart(3)} (text:${String(b.text).padStart(3)} think:${String(b.thinking).padStart(3)} other:${String(b.other).padStart(3)})`);
      }
    }
    console.error('');

    // ===== 执行断言 =====

    // 断言 1: TTFT 比率 < 40%
    console.error(`${ttftRatio < 0.4 ? '✅' : '❌'} TTFT 比率: ${(ttftRatio * 100).toFixed(1)}% < 40% — ${ttftRatio < 0.4 ? 'PASS' : 'FAIL'}`);
    expect(ttftRatio).toBeLessThan(0.4);

    // 断言 2: 事件时间跨度 > 总时长的 30%
    console.error(`${spanRatio > 0.3 ? '✅' : '❌'} 事件跨度: ${eventSpan}ms > ${(totalDuration * 0.3).toFixed(0)}ms (30%) — ${spanRatio > 0.3 ? 'PASS' : 'FAIL'}`);
    expect(spanRatio).toBeGreaterThan(0.3);

    // 断言 3: 延迟标准差 < 200ms
    console.error(`${delayStddev < 200 ? '✅' : '❌'} 延迟方差: σ=${delayStddev.toFixed(0)}ms < 200ms — ${delayStddev < 200 ? 'PASS' : 'FAIL'}`);
    expect(delayStddev).toBeLessThan(200);

    // 断言 4: 至少 3 个 text_delta 事件
    console.error(`${textDeltas.length >= 3 ? '✅' : '❌'} 最少事件数: ${textDeltas.length} >= 3 — ${textDeltas.length >= 3 ? 'PASS' : 'FAIL'}`);
    expect(textDeltas.length).toBeGreaterThanOrEqual(3);

    // 断言 5: 内容一致性
    const contentMatch = partialText.trim() === resultText.trim();
    console.error(`${contentMatch ? '✅' : '❌'} 内容一致性: partial 拼接 ${contentMatch ? '===' : '!=='} result — ${contentMatch ? 'PASS' : 'FAIL'}`);
    console.error(`  partial 拼接 (${partialText.trim().length} 字符): ${partialText.trim().slice(0, 80)}...`);
    console.error(`  result 文本   (${resultText.trim().length} 字符): ${resultText.trim().slice(0, 80)}...`);
    expect(partialText.trim()).toBe(resultText.trim());

    console.error('');
  }, 120000);
});
