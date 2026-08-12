import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
dotenv.config();

interface SdkEvent {
  index: number;
  receivedAt: number;
  raw: any;
}

describe('Single Query Multi-Turn Streaming', () => {
  it('应该在单 query 多轮对话中实现真流式输出', async () => {
    async function* conversation() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: '我叫小红，记住我的名字。简短回答。' },
      };
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: '我叫什么名字？只回答名字' },
      };
    }

    const sdkQuery = query({
      prompt: conversation(),
      options: {
        env: getProfileEnv('bigmodel', { includeBehaviorEnv: false, includeModelNames: false }),
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
      } as any,
    });

    // 采集所有 SDK 事件
    const events: SdkEvent[] = [];
    const queryStart = Date.now();

    for await (const message of sdkQuery) {
      events.push({ index: events.length, receivedAt: Date.now(), raw: message });
    }

    const queryEnd = Date.now();
    const totalDuration = queryEnd - queryStart;

    // ===== 按轮次拆分事件 =====
    const rounds: SdkEvent[][] = [];
    let currentRound: SdkEvent[] = [];

    for (const e of events) {
      currentRound.push(e);
      if (e.raw.type === 'result') {
        rounds.push(currentRound);
        currentRound = [];
      }
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    // ===== 每轮提取 text_delta 事件 =====
    const extractTextDeltas = (roundEvents: SdkEvent[]) =>
      roundEvents.filter((e) => {
        const msg = e.raw;
        return (
          msg.type === 'stream_event' &&
          msg.event?.type === 'content_block_delta' &&
          msg.event.delta?.type === 'text_delta'
        );
      });

    const extractThinkingDeltas = (roundEvents: SdkEvent[]) =>
      roundEvents.filter((e) => {
        const msg = e.raw;
        return (
          msg.type === 'stream_event' &&
          msg.event?.type === 'content_block_delta' &&
          msg.event.delta?.type === 'thinking_delta'
        );
      });

    const extractPartialText = (deltas: SdkEvent[]) =>
      deltas.map((e) => e.raw.event.delta.text || '').join('');

    const extractResultText = (roundEvents: SdkEvent[]) => {
      const result = roundEvents.find((e) => e.raw.type === 'result');
      return result?.raw?.result || '';
    };

    // ===== 诊断报告 =====
    console.error('\n📊 多轮对话流式输出分析报告');
    console.error('═══════════════════════════════════');
    console.error(`总事件数: ${events.length}`);
    console.error(`对话轮数: ${rounds.length}`);
    console.error(`总时长: ${totalDuration}ms`);
    console.error('');

    for (let i = 0; i < rounds.length; i++) {
      const textDeltas = extractTextDeltas(rounds[i]);
      const thinkingDeltas = extractThinkingDeltas(rounds[i]);
      const partialText = extractPartialText(textDeltas);
      const resultText = extractResultText(rounds[i]);
      const roundStart = rounds[i][0]?.receivedAt || queryStart;
      const roundEnd = rounds[i][rounds[i].length - 1]?.receivedAt || roundStart;
      const roundDuration = roundEnd - roundStart;

      console.error(`── 第 ${i + 1} 轮 ──`);
      console.error(`  事件数: ${rounds[i].length} (text_delta: ${textDeltas.length}, thinking_delta: ${thinkingDeltas.length})`);
      console.error(`  轮时长: ${roundDuration}ms`);
      console.error(`  partial 文本: ${partialText}`);
      console.error(`  result 文本:  ${resultText}`);
      console.error('');
    }

    // ===== 断言 =====

    // 1. 至少 2 轮对话
    console.error(`${rounds.length >= 2 ? '✅' : '❌'} 对话轮数: ${rounds.length} >= 2 — ${rounds.length >= 2 ? 'PASS' : 'FAIL'}`);
    expect(rounds.length).toBeGreaterThanOrEqual(2);

    // 2. 每轮都有流式 text_delta 事件（短回复可能只有 1 个 delta）
    for (let i = 0; i < rounds.length; i++) {
      const textDeltas = extractTextDeltas(rounds[i]);
      console.error(`${textDeltas.length >= 1 ? '✅' : '❌'} 第 ${i + 1} 轮 text_delta 事件数: ${textDeltas.length} >= 1 — ${textDeltas.length >= 1 ? 'PASS' : 'FAIL'}`);
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    }

    // 3. 有足够 text_delta 的轮次，TTFT 占轮时长 < 80%（短回复 thinking 占比大，跳过）
    for (let i = 0; i < rounds.length; i++) {
      const textDeltas = extractTextDeltas(rounds[i]);
      if (textDeltas.length < 3) {
        console.error(`⏭️  第 ${i + 1} 轮 text_delta < 3，跳过 TTFT 断言`);
        continue;
      }
      const roundStart = rounds[i][0].receivedAt;
      const roundEnd = rounds[i][rounds[i].length - 1].receivedAt;
      const roundDuration = roundEnd - roundStart;
      const firstPartial = rounds[i].find((e) => e.raw.type === 'stream_event');
      const ttft = firstPartial ? firstPartial.receivedAt - roundStart : roundDuration;
      const ttftRatio = roundDuration > 0 ? ttft / roundDuration : 1;

      console.error(`${ttftRatio < 0.8 ? '✅' : '❌'} 第 ${i + 1} 轮 TTFT: ${(ttftRatio * 100).toFixed(1)}% < 80% — ${ttftRatio < 0.8 ? 'PASS' : 'FAIL'}`);
      expect(ttftRatio).toBeLessThan(0.8);
    }

    // 4. 每轮 partial 拼接 === result 文本
    for (let i = 0; i < rounds.length; i++) {
      const partialText = extractPartialText(extractTextDeltas(rounds[i]));
      const resultText = extractResultText(rounds[i]);
      const match = partialText.trim() === resultText.trim();
      console.error(`${match ? '✅' : '❌'} 第 ${i + 1} 轮内容一致: partial === result — ${match ? 'PASS' : 'FAIL'}`);
      expect(partialText.trim()).toBe(resultText.trim());
    }

    // 5. 第二轮记住上下文
    const lastResult = extractResultText(rounds[rounds.length - 1]);
    console.error(`${lastResult.includes('小红') ? '✅' : '❌'} 上下文记忆: "${lastResult}" 包含 "小红" — ${lastResult.includes('小红') ? 'PASS' : 'FAIL'}`);
    expect(lastResult).toContain('小红');

    console.error('');
  }, 120000);
});
