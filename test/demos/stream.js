#!/usr/bin/env node

/**
 * 流式输出 Demo - 自动启动/关闭测试服务器
 */

const { spawn } = require('child_process');
const path = require('path');

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

async function main() {
  console.log('正在启动测试服务器...\n');

  // 启动开发服务器
  const server = spawn('npx', ['tsx', 'src/main.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env }
  });

  let serverOutput = '';
  server.stdout.on('data', (data) => {
    const text = data.toString();
    serverOutput += text;
    // 等待服务器启动完成
    if (text.includes('Application is running on')) {
      startRequest();
    }
  });

  server.stderr.on('data', (data) => {
    console.error(data.toString());
  });

  async function startRequest() {
    // 等待服务器完全启动
    await new Promise(r => setTimeout(r, 2000));

    console.log('✓ 服务器已启动\n');
    console.log('========== Claude Code 流式输出 Demo ==========');
    console.log('==============================================\n');

    // 发送请求
    const curl = spawn('curl', ['-N', '-X', 'POST', 'http://localhost:3000/api/query',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({
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
      })
    ], {
      stdio: 'inherit'
    });

    curl.on('close', (code) => {
      console.log('\n\n==============================================');
      console.log('✅ 完成！正在关闭服务器...\n');
      server.kill();
      process.exit(code);
    });
  }

  server.on('error', (err) => {
    console.error('服务器启动失败:', err.message);
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`服务器异常退出，代码: ${code}`);
      process.exit(code);
    }
  });
}

main();
