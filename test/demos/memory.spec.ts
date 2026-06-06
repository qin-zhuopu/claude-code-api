import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
import fs from 'fs';
import path from 'path';

// 加载 .env 文件
dotenv.config();

describe('Memory Demo (对话记忆)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  async function streamQuery(prompt: string, options: any, roundLabel: string) {
    const server = app.getHttpServer();
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, options }),
    });

    // 创建日志文件
    const logDir = path.join(process.cwd(), 'test', 'demos', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logDir, `memory-${roundLabel}-${timestamp}.jsonl`);
    const logStream = fs.createWriteStream(logFile);
    console.log(`(日志保存到: ${logFile})\n`);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        // 实时打印每个 SSE 数据块
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const json = JSON.parse(line.slice(5));
              // 保存原始 JSON 到日志文件
              logStream.write(JSON.stringify(json) + '\n');

              if (json.type === 'text' && json.content) {
                const inner = JSON.parse(json.content);
                if (inner.type === 'assistant' && inner.message?.content) {
                  for (const item of inner.message.content) {
                    if (item.type === 'text' && item.text) {
                      process.stderr.write(item.text);
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
    console.log(); // 换行
    return fullText;
  }

  it('应该记住对话上下文，知道用户是小明', async () => {
    const envConfig = getProfileEnv('bigmodel', { includeBehaviorEnv: false });

    console.log('\n========== Memory Demo ==========');
    console.log('第一轮：告诉 AI "我是小明"');
    console.log('================================\n');

    const text1 = await streamQuery('我是小明，请记住这个名字。', { env: envConfig }, 'round1');
    expect(text1).toContain('data:');
    expect(text1).toContain('done');

    console.log('\n第二轮：问 AI "我是谁？"（使用 continue 继续对话）');
    console.log('================================\n');

    const text2 = await streamQuery('我是谁？请简短回答。', { continue: true, env: envConfig }, 'round2');
    expect(text2).toContain('data:');
    expect(text2).toContain('done');
    expect(text2).toMatch(/小明|Xiaoming|xiaoming/);

    console.log('\n✅ AI 记住了用户是小明！');
    console.log('================================\n');
  });
});
