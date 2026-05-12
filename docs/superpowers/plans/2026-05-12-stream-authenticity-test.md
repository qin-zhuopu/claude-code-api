# Stream Authenticity Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write a single integration test that proves `/api/query` SSE output is truly streaming (token-by-token) and not faked (batched, buffered, or deferred).

**Architecture:** The test sends a real LLM request with `includePartialMessages: true`, captures every SSE event with both server and client timestamps, then runs 5 assertions against the collected data. A diagnostic report is printed regardless of pass/fail.

**Tech Stack:** Vitest, NestJS Testing (`@nestjs/testing`), `fetch` + `ReadableStream` reader, `dotenv` for env vars.

---

### Task 1: Create the test file with app setup and event capture

**Files:**
- Create: `test/integration/stream-authenticity.spec.ts`
- Reference: `test/integration/query-stream.spec.ts` (existing patterns to follow)
- Reference: `test/integration/vitest.config.ts` (config — no changes needed)

- [ ] **Step 1: Create the test file with the full test**

```typescript
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

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const match = line.match(/^data:\s*(.+)$/);
        if (!match) continue;

        const clientTs = Date.now();
        const raw = JSON.parse(match[1]);

        events.push({
          index: eventIndex++,
          serverTs: raw.ts || clientTs,
          clientTs,
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
    const ttft = textDeltas.length > 0
      ? textDeltas[0].clientTs - requestStart
      : totalDuration;
    const ttftRatio = totalDuration > 0 ? ttft / totalDuration : 1;

    // ===== 断言 2: 事件时间跨度 =====
    const eventSpan = textDeltas.length >= 2
      ? textDeltas[textDeltas.length - 1].clientTs - textDeltas[0].clientTs
      : 0;
    const spanRatio = totalDuration > 0 ? eventSpan / totalDuration : 0;

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
    console.error('⏱ 时序分析:');
    console.error(`  请求开始:     ${requestStart}`);
    console.error(`  首 token 到达: ${textDeltas[0]?.clientTs || 'N/A'}  (+${ttft}ms, 占总时长 ${(ttftRatio * 100).toFixed(1)}%)`);
    console.error(`  最后 token:    ${textDeltas[textDeltas.length - 1]?.clientTs || 'N/A'}`);
    console.error(`  流结束:        ${streamEnd}`);
    console.error(`  总时长:        ${totalDuration}ms`);
    console.error('');
    console.error('📈 延迟分析 (clientTs - serverTs):');
    console.error(`  平均: ${avgDelay.toFixed(0)}ms`);
    console.error(`  标准差: ${delayStddev.toFixed(0)}ms`);
    console.error(`  最大: ${Math.max(...delays, 0)}ms`);
    console.error(`  最小: ${delays.length > 0 ? Math.min(...delays) : 0}ms`);
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
```

- [ ] **Step 2: Run the test**

Run: `npx vitest --config ./test/integration/vitest.config.ts --run stream-authenticity`

Expected: PASS with the diagnostic report printed to stderr showing all 5 assertions as ✅.

- [ ] **Step 3: Commit**

```bash
git add test/integration/stream-authenticity.spec.ts
git commit -m "test: 添加 SSE 流式输出真伪断言测试

5 个断言指标验证真正的逐 token 流式推送：
- TTFT 比率 < 40%
- 事件时间跨度 > 总时长 30%
- 服务端-客户端延迟标准差 < 200ms
- 至少 3 个 text_delta 事件
- partial 拼接内容 === result 文本"
```
