import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// 加载 .env 文件
dotenv.config();

describe('Streaming Demo (实时流式输出)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0); // 随机端口
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('应该实时流式输出 Claude Code 的中文介绍', async () => {
    const server = app.getHttpServer();
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    // 创建日志目录
    const logDir = path.join(process.cwd(), 'test', 'demos', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logDir, `streaming-${timestamp}.jsonl`);
    const logStream = fs.createWriteStream(logFile);

    console.log('\n========== Streaming Demo ==========');
    console.log('请求: 写一篇关于 Claude Code 的中文介绍（1000-2000字）');
    console.log('配置: 已禁用所有 MCP、工具和技能');
    console.log(`(日志保存到: ${logFile})`);
    console.log('======================================\n');

    const prompt = `请写一篇关于 Claude Code 的中文介绍，字数控制在 1000 到 2000 字（汉字）之间。请严格控制字数，不要超出这个范围。

介绍内容应涵盖：
1. Claude Code 是什么及其核心目标
2. 主要功能和特性
3. 工作原理（架构概述）
4. 使用场景和目标用户
5. 与其他工具的集成
6. 与类似工具的对比
7. 快速入门指南
8. 使用技巧和最佳实践

请用清晰、信息丰富的风格撰写，适合初次接触 Claude Code 的开发者阅读。`;

    const response = await fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        options: {
          env: {
            ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
            API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
          },
          tools: [],
          skills: [],
        },
      }),
    });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let charCount = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const json = JSON.parse(line.slice(5));
              logStream.write(JSON.stringify(json) + '\n');

              if (json.type === 'text' && json.content) {
                const inner = JSON.parse(json.content);
                if (inner.type === 'assistant' && inner.message?.content) {
                  for (const item of inner.message.content) {
                    if (item.type === 'text' && item.text) {
                      // 使用 console.error 实现实时流式输出
                      console.error(item.text);
                      charCount += item.text.length;
                    }
                  }
                }
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    }

    logStream.end();

    console.log('\n\n======================================');
    console.log(`✅ 完成！响应约 ${charCount} 字符`);
    console.log('======================================\n');

    expect(charCount).toBeGreaterThanOrEqual(1000);
    expect(charCount).toBeLessThanOrEqual(5000);
  });
});
