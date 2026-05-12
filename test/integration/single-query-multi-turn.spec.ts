import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

describe('Single Query Multi-Turn', () => {
  it('应该在一个 query 中进行多轮对话', async () => {
    // prompt 参数支持 AsyncIterable<SDKUserMessage>，SDK 逐轮 pull
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
        persistSession: false,
        effort: 'low',
      } as any,
    });

    console.error('\n📝 开始单 query 多轮对话...');

    let resultCount = 0;
    const results: string[] = [];

    for await (const message of sdkQuery) {
      if (message.type === 'result') {
        resultCount++;
        const result = (message as any).result || '';
        results.push(result);
        console.error(`  第 ${resultCount} 轮结果: ${result}`);
      }
    }

    console.error(`\n📊 共收到 ${resultCount} 轮结果`);

    expect(resultCount).toBeGreaterThanOrEqual(2);
    expect(results[results.length - 1]).toContain('小红');
  }, 120000);
});
