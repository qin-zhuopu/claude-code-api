import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';

dotenv.config();

describe('Custom LLM (Jereh Proxy)', () => {
  it('应该通过 aiproxy 端点完成简单问答', async () => {
    const sdkQuery = query({
      prompt: 'say hello',
      options: {
        env: getProfileEnv('jereh', { includeBehaviorEnv: false }),
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
