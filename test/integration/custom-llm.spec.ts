import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

describe('Custom LLM (Jereh Proxy)', () => {
  it('应该通过 aiproxy 端点完成简单问答', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        env: {
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_JEREH,
          ANTHROPIC_BASE_URL: 'http://aiproxy.jereh.cn:4000',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-qwen3.6-plus',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-qwen3.6-plus',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-qwen3.5-flash',
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        agent: 'simple',
        agents: {
          simple: {
            description: 'Simple agent',
            prompt: 'You are a simple assistant, reply briefly.',
            model: 'haiku',
            tools: [],
            skills: [],
          },
        },
        persistSession: false,
        effort: 'low',
      } as any,
    });

    let resultText = '';
    for await (const message of sdkQuery) {
      if ((message as any).type === 'result') {
        resultText = (message as any).result || '';
      }
    }

    console.error(`\nJereh Proxy 回复: ${resultText}`);
    expect(resultText.trim().length).toBeGreaterThan(0);
  }, 60000);
});
