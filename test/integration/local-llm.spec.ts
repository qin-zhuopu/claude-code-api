import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

describe('Local LLM (Jereh-LLM)', () => {
  it('应该通过本地 Jereh-LLM 端点完成简单问答', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        env: {
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
          ANTHROPIC_BASE_URL: 'http://10.1.3.115:4000',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-LLM-NO-THINK-V1',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-LLM-NO-THINK-V1',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-LLM-NO-THINK-V1',
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        includePartialMessages: true,
        persistSession: false,
        effort: 'low',
      } as any,
    });

    const startTime = Date.now();
    let firstTokenTime = 0;
    let resultText = '';

    for await (const message of sdkQuery) {
      const msg = message as any;

      // 首个流式事件
      if (firstTokenTime === 0 && msg.type === 'stream_event') {
        firstTokenTime = Date.now();
        const delta = msg.event?.delta;
        const tokenType = delta?.type === 'thinking_delta' ? 'thinking' : delta?.type === 'text_delta' ? 'text' : msg.event?.type || 'unknown';
        console.error(`  ⚡ 首 token 到达: ${firstTokenTime - startTime}ms (${tokenType})`);
      }

      // 打印 text_delta
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        const delta = msg.event.delta;
        if (delta?.type === 'text_delta') {
          process.stderr.write(delta.text);
        }
      }

      if (msg.type === 'result') {
        resultText = msg.result || '';
      }
    }

    const totalTime = Date.now() - startTime;
    console.error(`\n\n📊 耗时统计:`);
    console.error(`  首 token (TTFT): ${firstTokenTime > 0 ? firstTokenTime - startTime : 'N/A'}ms`);
    console.error(`  总耗时:          ${totalTime}ms`);
    console.error(`  回复:            ${resultText}`);

    expect(resultText.trim().length).toBeGreaterThan(0);
  }, 60000);
});
