#!/usr/bin/env node

/**
 * 流式输出 Demo
 * - 自动启动/关闭测试服务器（随机端口）
 * - 断言响应是 SSE 格式
 * - 在屏幕上实时打印流式输出效果
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const PROMPT = `请用 100 字左右简单介绍一下 Claude Code 是什么。`;

async function main() {
  console.log('🔨 正在构建项目...\n');

  // 构建项目
  await runCommand('npm', ['run', 'build', '--silent']);

  console.log('🚀 正在启动测试服务器...\n');

  // 启动服务器（PORT=0 表示随机端口）
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverPort = '';
  let serverOutput = '';

  // 监听服务器输出，获取端口
  const readline = createInterface({ input: server.stdout });
  readline.on('line', (line) => {
    serverOutput += line + '\n';
    const match = line.match(/Application is running on http:\/\/localhost:(\d+)/);
    if (match) {
      serverPort = match[1];
    }
  });

  server.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  // 等待服务器启动
  await new Promise(resolve => setTimeout(resolve, 2000));

  if (!serverPort) {
    console.error('❌ 无法获取服务器端口');
    console.error('服务器输出:', serverOutput);
    server.kill();
    process.exit(1);
  }

  console.log(`✓ 服务器已启动: http://localhost:${serverPort}\n`);
  console.log('========== Claude Code 流式输出 Demo ==========');
  console.log('断言: 验证 SSE 流式输出格式');
  console.log('==============================================\n');

  try {
    // 发送请求
    const response = await fetch(`http://localhost:${serverPort}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: PROMPT,
        options: {},
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 错误: ${response.status} - ${errorText}`);
    }

    // 断言: 检查 Content-Type 是否为 text/event-stream
    const contentType = response.headers.get('content-type') || '';
    const isSSE = contentType.includes('text/event-stream');

    console.log(`📡 Content-Type: ${contentType}`);
    console.log(`✓ 断言通过: ${isSSE ? '是 SSE 流式输出' : '警告: 不是 SSE 格式'}\n`);

    if (!response.body) {
      throw new Error('响应体为空');
    }

    // 读取流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let charCount = 0;
    let eventCount = 0;
    let buffer = '';

    console.log('流式响应:\n');
    console.log('----------------------------------------------\n');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data:')) {
          eventCount++;
          try {
            const json = JSON.parse(line.slice(5).trim());

            if (json.type === 'text' && json.content) {
              // 尝试解析嵌套的内容
              let textToPrint = '';
              try {
                const inner = typeof json.content === 'string'
                  ? JSON.parse(json.content)
                  : json.content;

                if (inner.type === 'assistant' && inner.message?.content) {
                  for (const item of inner.message.content) {
                    if (item.type === 'text' && item.text) {
                      textToPrint = item.text;
                    }
                  }
                }
              } catch {
                // 如果解析失败，直接使用 content
                textToPrint = json.content;
              }

              // 逐字符输出，实现流式效果
              for (const char of textToPrint) {
                process.stdout.write(char);
                charCount++;
                await new Promise(r => setTimeout(r, 10));
              }
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      }
    }

    console.log('\n\n----------------------------------------------');
    console.log('==============================================');
    console.log(`✅ 完成!`);
    console.log(`   - 接收到 ${eventCount} 个 SSE 事件`);
    console.log(`   - 共 ${charCount} 字符`);
    console.log(`   - 使用随机端口: ${serverPort}`);
    console.log('==============================================\n');

  } catch (error) {
    console.error('❌ 错误:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    server.kill();
    console.log('👋 服务器已关闭\n');
  }
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码: ${code}`));
    });
  });
}

main().catch(console.error);
