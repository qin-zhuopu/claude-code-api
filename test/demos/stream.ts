#!/usr/bin/env node

/**
 * Claude Code 流式输出 Demo
 * 独立脚本，脱离 vitest 框架，实现真正的实时流式输出
 *
 * 使用方法: node test/demos/stream.js
 * (需要先运行 npm run build 编译项目)
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../dist/app.module.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

async function main() {
  console.log('正在启动测试服务器...');

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors();
  await app.init();
  await app.listen(0); // 随机端口

  const server = app.getHttpServer();
  const address = server.address() as any;
  const serverUrl = `http://127.0.0.1:${address.port}`;

  // 创建日志目录
  const logDir = path.join(process.cwd(), 'test', 'demos', 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `stream-${timestamp}.jsonl`);

  console.log(`✓ 服务器已启动: ${serverUrl}`);
  console.log(`✓ 日志文件: ${logFile}\n`);

  console.log('========== Claude Code 流式输出 Demo ==========');
  console.log('提示: 此脚本演示真正的实时流式输出');
  console.log('你会看到文本逐字逐句地出现，而不是一次性显示\n');
  console.log('==============================================\n');

  const prompt = `请写一篇关于 Claude Code 的中文介绍，字数控制在 1000 到 2000 字（汉字）之间。

内容应包括：
1. Claude Code 是什么及其核心目标
2. 主要功能和特性
3. 工作原理（架构概述）
4. 使用场景和目标用户
5. 与其他工具的集成
6. 与类似工具的对比
7. 快速入门指南
8. 使用技巧和最佳实践

请用清晰、信息丰富的风格撰写。`;

  try {
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

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 错误: ${response.status} - ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const logStream = fs.createWriteStream(logFile);
    let charCount = 0;

    console.log('流式响应:\n');

    // 真正的实时流式输出
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
                    // 逐字符输出，实现真正的流式效果
                    for (const char of item.text) {
                      process.stdout.write(char);
                      charCount++;
                      // 微小延迟，让流式效果更明显
                      await new Promise(r => setTimeout(r, 3));
                    }
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

    logStream.end();

    console.log('\n\n==============================================');
    console.log(`✅ 完成！共 ${charCount} 字符`);
    console.log('==============================================\n');

  } catch (error) {
    console.error('错误:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await app.close();
    console.log('服务器已关闭');
  }
}

main().catch(console.error);
