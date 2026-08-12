import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from './../../src/app.module';
import dotenv from 'dotenv';
import { getProfileEnv, ProfileName } from '../llm-profiles';
import fs from 'fs';
import path from 'path';

// 加载 .env 文件
dotenv.config();

describe('Simple Query Demo (简单查询)', () => {
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

  it('应该使用 .env 配置调用 Claude API 并返回 SSE 流', async () => {
    const server = app.getHttpServer();
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    console.log('\n========== Simple Query Demo ==========');
    console.log('Prompt: What is 2+2?');
    console.log('======================================\n');

    const response = await fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'What is 2+2? Answer in one short sentence.',
        options: {
          env: getProfileEnv((process.env.LLM_PROFILE as ProfileName) || 'bigmodel', { includeBehaviorEnv: false, includeModelNames: false }),
        }
      }),
    });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    // 创建日志文件目录和文件路径
    const logDir = path.join(process.cwd(), 'test', 'demos', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logDir, `stream-${timestamp}.jsonl`);
    const logStream = fs.createWriteStream(logFile);

    console.log('========== 流式响应 ==========');
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

        // 实时打印每个 SSE 数据块的内容
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const json = JSON.parse(line.slice(5));
              // 保存原始 JSON 到日志文件
              logStream.write(JSON.stringify(json) + '\n');

              if (json.type === 'text' && json.content) {
                // content 是字符串化的 JSON，需要再解析一次
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

    console.log('================================\n');

    expect(fullText).toContain('data:');
    expect(fullText).toContain('done');
  });
});
