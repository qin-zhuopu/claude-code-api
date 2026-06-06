/**
 * 实验：验证直接用 CLI 进程（--input-format stream-json）实现 REST API 的可行性
 *
 * 不使用 SDK 的 query()，而是直接 spawn claude 进程，
 * 通过 stdin/stdout 的 JSON 行协议进行通信。
 *
 * 这个实验证明了：可以把一个 claude CLI 进程转成 REST API。
 */
import { describe, it, expect } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';
dotenv.config();

// ===== JSON 行协议辅助 =====

/** 发送 JSON 消息到 CLI stdin */
function sendJson(proc: ChildProcess, msg: object) {
  const line = JSON.stringify(msg) + '\n';
  proc.stdin!.write(line);
}

/** 等待 stdout 中匹配特定条件的 JSON 消息 */
function waitForMessage(
  proc: ChildProcess,
  predicate: (msg: any) => boolean,
  timeoutMs = 30000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (predicate(msg)) {
          clearTimeout(timer);
          rl.close();
          resolve(msg);
        }
      } catch {}
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      rl.close();
      if (code !== 0 && code !== null) {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

/** 收集所有 stdout 消息直到条件满足 */
function collectUntil(
  proc: ChildProcess,
  stopPredicate: (msg: any) => boolean,
  timeoutMs = 60000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms. Collected ${messages.length} messages so far.`));
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
        if (stopPredicate(msg)) {
          clearTimeout(timer);
          rl.close();
          resolve(messages);
        }
      } catch {}
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      rl.close();
      resolve(messages); // 进程退出也返回已收集的消息
    });
  });
}

// ===== 启动 CLI 进程 =====

function spawnCliProcess(): ChildProcess {
  const env = {
    ...process.env,
    ...getProfileEnv('bigmodel', { includeBehaviorEnv: false }),
    CLAUDE_CODE_ENTRYPOINT: 'cli-rest-api-experiment',
  };

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--system-prompt', '你是一个简单的助手，简短回答，不使用工具。',
    '--tools', '',
    '--permission-mode', 'bypassPermissions',
    '--setting-sources=',
    '--no-session-persistence',
  ];

  // Windows 上 spawn 需要用 shell 模式来解析 .cmd 扩展名
  const proc = spawn('claude', args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
  });

  // stderr 日志输出到 console.error 方便调试
  proc.stderr!.on('data', (data: Buffer) => {
    const text = data.toString();
    // 只打印关键行，过滤掉太长的 debug 输出
    for (const line of text.split('\n')) {
      if (line.trim() && !line.includes('DEBUG') && line.length < 200) {
        console.error('[CLI stderr]', line);
      }
    }
  });

  return proc;
}

// ===== 测试 =====

describe('CLI 进程直接通信实验', () => {
  it('case 1: initialize 握手 → 发 user 消息 → 收到完整响应', async () => {
    const proc = spawnCliProcess();

    try {
      // ── Step 1: Initialize 握手 ──
      console.error('\n━━ Step 1: 发送 initialize 消息 ━━');
      sendJson(proc, {
        type: 'control_request',
        request_id: 'init_1',
        request: { subtype: 'initialize', hooks: null },
      });

      const initResponse = await waitForMessage(
        proc,
        (msg) => msg.type === 'control_response' && msg.response?.subtype === 'success',
      );

      console.error('✅ Initialize 成功:', JSON.stringify(initResponse.response).slice(0, 200));
      expect(initResponse.type).toBe('control_response');
      expect(initResponse.response.subtype).toBe('success');

      // ── Step 2: 发送 user 消息 ──
      console.error('\n━━ Step 2: 发送 user 消息 ━━');
      sendJson(proc, {
        type: 'user',
        session_id: '',
        message: { role: 'user', content: '简单回答：1+1等于几？只回答数字。' },
        parent_tool_use_id: null,
      });

      // ── Step 3: 收集所有消息直到 result ──
      const messages = await collectUntil(
        proc,
        (msg) => msg.type === 'result',
      );

      // ── 诊断报告 ──
      console.error('\n📊 消息流分析');
      console.error('═══════════════════════════════════');
      console.error(`总消息数: ${messages.length}`);

      const messageTypes: Record<string, number> = {};
      for (const m of messages) {
        const key = m.type + (m.subtype ? `/${m.subtype}` : '');
        messageTypes[key] = (messageTypes[key] || 0) + 1;
      }
      console.error('消息类型分布:', JSON.stringify(messageTypes, null, 2));

      // 提取 assistant 文本
      const assistantMsgs = messages.filter((m) => m.type === 'assistant');
      const resultMsg = messages.find((m) => m.type === 'result');

      if (assistantMsgs.length > 0) {
        console.error(`\nassistant 消息数: ${assistantMsgs.length}`);
        for (const am of assistantMsgs) {
          const content = am.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                console.error(`  文本: "${block.text?.slice(0, 200)}"`);
              }
            }
          }
        }
      }

      if (resultMsg) {
        console.error(`\nresult: is_error=${resultMsg.is_error}, subtype=${resultMsg.subtype}`);
        console.error(`  result text: "${(resultMsg.result || '').slice(0, 200)}"`);
      }

      // ── 断言 ──
      // 1. 应该有 result 消息
      expect(messages.some((m) => m.type === 'result')).toBe(true);
      console.error(`${messages.some((m) => m.type === 'result') ? '✅' : '❌'} 收到 result 消息`);

      // 2. result 不应该是错误
      if (resultMsg) {
        const notError = !resultMsg.is_error;
        console.error(`${notError ? '✅' : '❌'} result 不是错误`);
        expect(notError).toBe(true);
      }

      // 3. 应该有 assistant 消息
      console.error(`${assistantMsgs.length > 0 ? '✅' : '❌'} 收到 assistant 消息: ${assistantMsgs.length} 条`);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    } finally {
      // 清理：关闭进程
      proc.stdin!.end();
      proc.kill('SIGTERM');
      // 给进程一点时间退出
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3000);
        proc.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 120000);
});
