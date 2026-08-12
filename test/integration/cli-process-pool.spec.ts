/**
 * 实验：验证多 CLI 进程池 + 进程复用 + 输出流路由
 *
 * 关键问题：
 * 1. 单进程收到 result 后，能接收第二条 user 消息吗？（进程复用）
 * 2. 多个 CLI 进程能并发运行吗？
 * 3. stdout 消息带不带 session 标识？（输出流路由）
 */
import { describe, it, expect } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
dotenv.config();

// ===== 辅助函数 =====

function sendJson(proc: ChildProcess, msg: object) {
  const line = JSON.stringify(msg) + '\n';
  proc.stdin!.write(line);
}

function spawnCliProcess(label: string): ChildProcess {
  const env = {
    ...process.env,
    ...getProfileEnv('bigmodel', { includeBehaviorEnv: false, includeModelNames: false }),
    CLAUDE_CODE_ENTRYPOINT: 'cli-pool-experiment',
  };

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--system-prompt', '你是一个简单的助手，简短回答，不使用工具。每次回答不超过10个字。',
    '--tools', '',
    '--permission-mode', 'bypassPermissions',
    '--setting-sources=',
    '--no-session-persistence',
  ];

  const proc = spawn('claude', args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
  });

  proc.stderr!.on('data', (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.trim() && !line.includes('DEBUG') && line.length < 200) {
        console.error(`[${label} stderr]`, line);
      }
    }
  });

  return proc;
}

/** initialize 握手 */
async function initialize(proc: ChildProcess, label: string): Promise<any> {
  sendJson(proc, {
    type: 'control_request',
    request_id: `${label}_init`,
    request: { subtype: 'initialize', hooks: null },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${label}] init timeout`)), 30000);
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'control_response' && msg.response?.subtype === 'success') {
          clearTimeout(timer);
          rl.close();
          resolve(msg);
        }
      } catch {}
    });
  });
}

/** 发 user 消息并收集到 result 为止的所有消息 */
async function sendAndCollect(
  proc: ChildProcess,
  prompt: string,
  label: string,
  timeoutMs = 60000,
): Promise<{ messages: any[]; result: any; sessionId: string | null }> {
  sendJson(proc, {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  });

  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    let sessionId: string | null = null;
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] timeout after ${timeoutMs}ms, got ${messages.length} messages`));
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        messages.push(msg);

        // 捕获 sessionId
        if (msg.type === 'system' && msg.subtype === 'init' && msg.sessionId) {
          sessionId = msg.sessionId;
        }
        if (msg.session_id) {
          sessionId = msg.session_id;
        }

        if (msg.type === 'result') {
          clearTimeout(timer);
          rl.close();
          resolve({ messages, result: msg, sessionId });
        }
      } catch {}
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      rl.close();
      reject(new Error(`[${label}] process exited with code ${code}`));
    });
  });
}

/** 清理进程 */
async function cleanup(proc: ChildProcess, label: string) {
  proc.stdin?.end();
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** 分析消息中的 session 标识字段 */
function analyzeSessionFields(messages: any[], label: string) {
  console.error(`\n  [${label}] 消息 session 标识分析:`);
  for (const msg of messages) {
    const fields: string[] = [];
    if (msg.session_id) fields.push(`session_id=${msg.session_id}`);
    if (msg.sessionId) fields.push(`sessionId=${msg.sessionId}`);
    if (msg.uuid) fields.push(`uuid=${msg.uuid}`);
    if (msg.request_id) fields.push(`request_id=${msg.request_id}`);

    const typeKey = msg.type + (msg.subtype ? `/${msg.subtype}` : '');
    console.error(`    ${typeKey}: ${fields.length > 0 ? fields.join(', ') : '(无标识)'}`);
  }
}

// ===== 测试 =====

describe('CLI 多进程池验证', () => {

  it('case 1: 进程复用 — 单进程连续两条消息', async () => {
    const proc = spawnCliProcess('P1');

    try {
      // Init
      console.error('\n━━ Case 1: 进程复用 ━━');
      const initResp = await initialize(proc, 'P1');
      console.error('  ✅ init 成功');

      // 第 1 条消息
      console.error('  ── 发第 1 条消息 ──');
      const r1 = await sendAndCollect(proc, '1+1=? 只回答数字', 'P1-msg1');

      const text1 = r1.result?.result || '';
      console.error(`  第 1 条 result: "${text1}"`);
      console.error(`  第 1 条消息数: ${r1.messages.length}`);
      expect(r1.result.type).toBe('result');
      expect(r1.result.is_error).toBeFalsy();

      // 分析第 1 条消息的 session 标识
      analyzeSessionFields(r1.messages, 'P1-msg1');

      // 第 2 条消息 — 关键：进程是否还能接受？
      console.error('  ── 发第 2 条消息（进程复用） ──');
      const r2 = await sendAndCollect(proc, '2+2=? 只回答数字', 'P1-msg2');

      const text2 = r2.result?.result || '';
      console.error(`  第 2 条 result: "${text2}"`);
      console.error(`  第 2 条消息数: ${r2.messages.length}`);
      expect(r2.result.type).toBe('result');
      expect(r2.result.is_error).toBeFalsy();

      // 分析第 2 条消息的 session 标识
      analyzeSessionFields(r2.messages, 'P1-msg2');

      // 对比两次的 session 标识
      console.error(`\n  📊 Session 对比:`);
      console.error(`    msg1 sessionId: ${r1.sessionId}`);
      console.error(`    msg2 sessionId: ${r2.sessionId}`);
      console.error(`    相同? ${r1.sessionId === r2.sessionId}`);

      console.error(`\n  ✅ 进程复用成功 — 两条消息都收到了响应`);

    } finally {
      await cleanup(proc, 'P1');
    }
  }, 120000);

  it('case 2: 多进程并发 — 两个进程同时运行', async () => {
    console.error('\n━━ Case 2: 多进程并发 ━━');

    const procA = spawnCliProcess('PA');
    const procB = spawnCliProcess('PB');

    try {
      // 两个进程同时 init
      const [initA, initB] = await Promise.all([
        initialize(procA, 'PA'),
        initialize(procB, 'PB'),
      ]);
      console.error('  ✅ 两个进程 init 成功');

      // 同时发不同消息
      console.error('  ── 同时发消息 ──');
      const [rA, rB] = await Promise.all([
        sendAndCollect(procA, '中国的首都是哪？只回答城市名', 'PA'),
        sendAndCollect(procB, '法国的首都是哪？只回答城市名', 'PB'),
      ]);

      const textA = rA.result?.result || '';
      const textB = rB.result?.result || '';
      console.error(`\n  PA result: "${textA}"`);
      console.error(`  PB result: "${textB}"`);
      console.error(`  PA 消息数: ${rA.messages.length}`);
      console.error(`  PB 消息数: ${rB.messages.length}`);

      // 断言：各自收到 result
      expect(rA.result.type).toBe('result');
      expect(rA.result.is_error).toBeFalsy();
      expect(rB.result.type).toBe('result');
      expect(rB.result.is_error).toBeFalsy();

      console.error(`\n  ✅ 多进程并发成功 — 两个进程独立收发，互不干扰`);

    } finally {
      await cleanup(procA, 'PA');
      await cleanup(procB, 'PB');
    }
  }, 120000);

  it('case 3: 输出流路由 — 消息标识字段全景分析', async () => {
    console.error('\n━━ Case 3: 输出流路由分析 ━━');

    const proc = spawnCliProcess('P3');

    try {
      await initialize(proc, 'P3');

      // 收集一轮完整消息
      const { messages } = await sendAndCollect(
        proc, '你好，说一句话', 'P3',
      );

      console.error(`\n  总消息数: ${messages.length}`);

      // 逐消息分析所有可能的标识字段
      console.error('\n  📊 每条消息的字段分析:');
      console.error('  ─────────────────────────────────────');

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const typeKey = msg.type + (msg.subtype ? `/${msg.subtype}` : '');

        // 收集所有可能的标识字段
        const idFields: Record<string, string> = {};
        for (const [key, val] of Object.entries(msg)) {
          if (typeof val === 'string' && (
            key.includes('session') || key.includes('id') || key === 'uuid'
            || key === 'request_id' || key === 'timestamp'
          )) {
            idFields[key] = val.length > 20 ? val.slice(0, 20) + '...' : val;
          }
        }

        console.error(`  [${i}] ${typeKey}`);
        console.error(`      标识字段: ${Object.keys(idFields).length > 0 ? JSON.stringify(idFields) : '(无)'}`);

        // 对 result 消息做深度字段扫描
        if (msg.type === 'result') {
          console.error(`      result 完整字段: ${JSON.stringify(Object.keys(msg))}`);
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          console.error(`      init 完整字段: ${JSON.stringify(Object.keys(msg))}`);
        }
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            console.error(`      assistant content blocks: ${content.length}`);
            for (const block of content) {
              console.error(`        - type=${block.type}, text="${(block.text || '').slice(0, 50)}"`);
            }
          }
        }
      }

      // 关键结论
      console.error('\n  📋 路由可行性结论:');
      const hasSessionId = messages.some(m => m.session_id || m.sessionId);
      const hasUuid = messages.some(m => m.uuid);
      console.error(`    消息带 session_id/sessionId? ${hasSessionId ? '✅' : '❌'}`);
      console.error(`    消息带 uuid? ${hasUuid ? '✅' : '❌'}`);

      // 对 result 消息做断言
      const resultMsg = messages.find(m => m.type === 'result');
      expect(resultMsg).toBeTruthy();

    } finally {
      await cleanup(proc, 'P3');
    }
  }, 120000);
});
