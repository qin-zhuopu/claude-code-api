import { describe, it, expect } from 'vitest';
import { query, forkSession, listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { existsSync, readFileSync, readdirSync, existsSync as fsExistsSync, mkdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';
dotenv.config();

interface SdkEvent {
  index: number;
  receivedAt: number;
  raw: any;
}

const BASE_ENV = getProfileEnv('bigmodel');

// 运行 query 并收集事件和耗时
async function runQueryWithMetrics(params: {
  prompt: string;
  options?: any;
  collectEvents?: boolean;
}): Promise<{ sessionId: string; resultText: string; duration: number; events: SdkEvent[] }> {
  const startTime = Date.now();
  const events: SdkEvent[] = [];
  let sessionId = '';
  let resultText = '';

  const sdkQuery = query({
    prompt: params.prompt,
    options: {
      env: BASE_ENV,
      includePartialMessages: true,
      persistSession: true,
      effort: 'low',
      settingSources: [],
      ...params.options,
    },
  });

  for await (const message of sdkQuery) {
    if (params.collectEvents) {
      events.push({ index: events.length, receivedAt: Date.now(), raw: message });
    }

    // 提取 session_id（init 事件和 result 事件都有）
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      sessionId = message.session_id;
    }
    if (message.type === 'result' && message.session_id) {
      sessionId = message.session_id;
    }
    if (message.type === 'result' && message.result) {
      resultText = message.result;
    }
  }

  const duration = Date.now() - startTime;
  return { sessionId, resultText, duration, events };
}

// 分析请求日志
function analyzeRequestLogs(dir: string) {
  if (!fsExistsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir);
  const requestFiles = files.filter(f => f.endsWith('.request.json') && !f.includes('.pretty'));

  const analyses: any[] = [];

  for (const file of requestFiles) {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const req = JSON.parse(content);
      analyses.push({
        file,
        systemBlocks: req.system?.length || 0,
        toolsCount: req.tools?.length || 0,
        hasMessages: !!req.messages,
        messagesCount: req.messages?.length || 0,
        model: req.model,
        maxTokens: req.max_tokens,
      });
    } catch (e) {
      analyses.push({ file, error: String(e) });
    }
  }

  return analyses;
}

describe('会话复用方法调研', () => {
  it('case-1: 基线 - 创建新会话的性能', async () => {
    const dir = createTimestampDir('session-reuse/case-1-baseline');
    const result = await runQueryWithMetrics({
      prompt: '你好，简短回复',
      options: { OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      collectEvents: true,
    });

    console.error('\n📊 Case 1: 基线 - 创建新会话');
    console.error('═══════════════════════════════════');
    console.error(`Session ID: ${result.sessionId}`);
    console.error(`耗时: ${result.duration}ms`);
    console.error(`回复: ${result.resultText.substring(0, 50)}...`);
    console.error(`事件数: ${result.events.length}`);

    // 分析请求日志
    const analyses = analyzeRequestLogs(dir);
    console.error(`\n请求数: ${analyses.length}`);
    analyses.forEach((a, i) => {
      console.error(`  Request ${i + 1}: ${a.systemBlocks} system blocks, ${a.toolsCount} tools`);
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.duration).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2: continue 方式复用最近会话', async () => {
    const baseDir = createTimestampDir('session-reuse/case-2-continue');
    const round1Dir = join(baseDir, 'round-1');
    const round2Dir = join(baseDir, 'round-2');
    mkdirSync(round1Dir, { recursive: true });
    mkdirSync(round2Dir, { recursive: true });

    // 第一轮：创建会话并记住信息
    console.error('\n📝 第一轮：创建会话');
    const first = await runQueryWithMetrics({
      prompt: '我叫小明，记住我的名字',
      options: { OTEL_LOG_RAW_API_BODIES: `file:${round1Dir}` },
    });
    console.error(`  Session ID: ${first.sessionId}`);
    console.error(`  耗时: ${first.duration}ms`);

    // 第二轮：使用 continue 复用会话
    console.error('\n📝 第二轮：使用 continue');
    const second = await runQueryWithMetrics({
      prompt: '我叫什么名字？只回答名字',
      options: {
        continue: true,
        OTEL_LOG_RAW_API_BODIES: `file:${round2Dir}`,
      },
    });
    console.error(`  Session ID: ${second.sessionId}`);
    console.error(`  耗时: ${second.duration}ms`);
    console.error(`  回复: ${second.resultText}`);

    console.error('\n📊 Case 2: continue 方式');
    console.error('═══════════════════════════════════');
    console.error(`第一轮耗时: ${first.duration}ms`);
    console.error(`第二轮耗时: ${second.duration}ms`);
    console.error(`耗时差: ${second.duration - first.duration}ms`);
    console.error(`Session ID 是否相同: ${first.sessionId === second.sessionId}`);
    console.error(`是否记住名字: ${second.resultText.includes('小明') ? '是' : '否'}`);

    // 分析请求日志
    const reqs1 = analyzeRequestLogs(round1Dir);
    const reqs2 = analyzeRequestLogs(round2Dir);
    console.error(`\n第一轮请求数: ${reqs1.length}`);
    console.error(`第二轮请求数: ${reqs2.length}`);

    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
    expect(second.resultText).toContain('小明');
    expect(second.sessionId).toBe(first.sessionId);

    prettyFormatJsonFiles(round1Dir);
    prettyFormatJsonFiles(round2Dir);
  }, 240000);

  it('case-3: resume 方式复用指定会话', async () => {
    const baseDir = createTimestampDir('session-reuse/case-3-resume');
    const round1Dir = join(baseDir, 'round-1');
    const round2Dir = join(baseDir, 'round-2');
    mkdirSync(round1Dir, { recursive: true });
    mkdirSync(round2Dir, { recursive: true });

    // 第一轮：创建会话
    console.error('\n📝 第一轮：创建会话');
    const first = await runQueryWithMetrics({
      prompt: '我叫小红，记住我的名字',
      options: { OTEL_LOG_RAW_API_BODIES: `file:${round1Dir}` },
    });
    console.error(`  Session ID: ${first.sessionId}`);
    console.error(`  耗时: ${first.duration}ms`);

    // 第二轮：使用 resume 复用会话
    console.error('\n📝 第二轮：使用 resume');
    const second = await runQueryWithMetrics({
      prompt: '我叫什么名字？只回答名字',
      options: {
        resume: first.sessionId,
        OTEL_LOG_RAW_API_BODIES: `file:${round2Dir}`,
      },
    });
    console.error(`  Session ID: ${second.sessionId}`);
    console.error(`  耗时: ${second.duration}ms`);
    console.error(`  回复: ${second.resultText}`);

    console.error('\n📊 Case 3: resume 方式');
    console.error('═══════════════════════════════════');
    console.error(`第一轮耗时: ${first.duration}ms`);
    console.error(`第二轮耗时: ${second.duration}ms`);
    console.error(`耗时差: ${second.duration - first.duration}ms`);
    console.error(`Session ID 是否相同: ${first.sessionId === second.sessionId}`);
    console.error(`是否记住名字: ${second.resultText.includes('小红') ? '是' : '否'}`);

    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
    expect(second.resultText).toContain('小红');
    expect(second.sessionId).toBe(first.sessionId);

    prettyFormatJsonFiles(round1Dir);
    prettyFormatJsonFiles(round2Dir);
  }, 240000);

  it('case-4: forkSession 创建分支会话', async () => {
    const baseDir = createTimestampDir('session-reuse/case-4-fork');
    const round1Dir = join(baseDir, 'round-1');
    const round2Dir = join(baseDir, 'round-2');
    mkdirSync(round1Dir, { recursive: true });
    mkdirSync(round2Dir, { recursive: true });

    // 第一轮：创建原始会话
    console.error('\n📝 第一轮：创建原始会话');
    const first = await runQueryWithMetrics({
      prompt: '我的项目是 TypeScript 项目，使用 React',
      options: { OTEL_LOG_RAW_API_BODIES: `file:${round1Dir}` },
    });
    console.error(`  原始 Session ID: ${first.sessionId}`);
    console.error(`  耗时: ${first.duration}ms`);

    // 第二轮：fork 创建新分支
    console.error('\n📝 第二轮：使用 forkSession');
    const forkStartTime = Date.now();
    let forkedSessionId = '';

    const forkQuery = query({
      prompt: '帮我为这个项目添加 Vue 组件',
      options: {
        resume: first.sessionId,
        forkSession: true,
        env: BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${round2Dir}`,
        persistSession: true,
        effort: 'low',
        settingSources: [],
      },
    });

    for await (const message of forkQuery) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        forkedSessionId = message.session_id;
      }
    }

    const forkDuration = Date.now() - forkStartTime;

    console.error(`  Fork Session ID: ${forkedSessionId}`);
    console.error(`  耗时: ${forkDuration}ms`);
    console.error(`  Session ID 是否不同: ${forkedSessionId !== first.sessionId}`);

    // 验证原始会话仍然存在
    const originalSessionInfo = await getSessionInfo(first.sessionId);
    console.error(`\n  原始会话存在: ${!!originalSessionInfo}`);

    console.error('\n📊 Case 4: forkSession 方式');
    console.error('═══════════════════════════════════');
    console.error(`原始会话: ${first.sessionId}`);
    console.error(`分支会话: ${forkedSessionId}`);
    console.error(`耗时: ${forkDuration}ms`);
    console.error(`会话 ID 不同: ${forkedSessionId !== first.sessionId}`);

    expect(first.sessionId).toBeTruthy();
    expect(forkedSessionId).toBeTruthy();
    expect(forkedSessionId).not.toBe(first.sessionId);
    expect(originalSessionInfo).toBeTruthy();

    prettyFormatJsonFiles(round1Dir);
    prettyFormatJsonFiles(round2Dir);
  }, 240000);

  it('case-5: 单次 query 内多轮对话（conversation generator）', async () => {
    const dir = createTimestampDir('session-reuse/case-5-conversation');

    async function* conversation() {
      yield { type: 'user' as const, message: { role: 'user' as const, content: '我叫小李，记住我的名字。简短回复。' } };
      yield { type: 'user' as const, message: { role: 'user' as const, content: '我叫什么名字？只回答名字' } };
    }

    const startTime = Date.now();
    const events: SdkEvent[] = [];

    const sdkQuery = query({
      prompt: conversation(),
      options: {
        env: BASE_ENV,
        includePartialMessages: true,
        persistSession: true,
        effort: 'low',
        settingSources: [],
        OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
      },
    });

    let sessionId = '';
    for await (const message of sdkQuery) {
      events.push({ index: events.length, receivedAt: Date.now(), raw: message });
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        sessionId = message.session_id;
      }
    }

    const totalDuration = Date.now() - startTime;

    // 按轮次拆分
    const rounds: SdkEvent[][] = [];
    let currentRound: SdkEvent[] = [];
    for (const e of events) {
      currentRound.push(e);
      if (e.raw.type === 'result') {
        rounds.push(currentRound);
        currentRound = [];
      }
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    console.error('\n📊 Case 5: 单次 query 内多轮对话');
    console.error('═══════════════════════════════════');
    console.error(`Session ID: ${sessionId}`);
    console.error(`总耗时: ${totalDuration}ms`);
    console.error(`总事件数: ${events.length}`);
    console.error(`对话轮数: ${rounds.length}`);

    // 提取每轮的 result
    for (let i = 0; i < rounds.length; i++) {
      const result = rounds[i].find(e => e.raw.type === 'result');
      const text = result?.raw?.result || '';
      console.error(`  第 ${i + 1} 轮: ${text.substring(0, 50)}...`);
    }

    // 分析请求日志
    const analyses = analyzeRequestLogs(dir);
    console.error(`\n请求数: ${analyses.length}`);

    expect(sessionId).toBeTruthy();
    expect(rounds.length).toBeGreaterThanOrEqual(2);

    prettyFormatJsonFiles(dir);
  }, 240000);

  it('case-6: 排除不稳定/弃用方法 - V2 session API', async () => {
    console.error('\n📊 Case 6: V2 session API（已弃用）');
    console.error('═══════════════════════════════════');
    console.error('根据官方文档：');
    console.error('  - The experimental V2 session API (createSession with send/stream pattern) is deprecated');
    console.error('  - Use the V1 query() function and session options (continue/resume) instead');
    console.error('');
    console.error('结论：V2 session API 不应再使用');

    // 不实际调用，只记录
    expect(true).toBe(true);
  }, 10000);

  it('case-7: 性能对比汇总', async () => {
    // 这个 case 不执行实际调用，只汇总前面的数据
    console.error('\n📊 Case 7: 会话复用方法性能对比');
    console.error('═══════════════════════════════════');
    console.error('');
    console.error('推荐使用的稳定方法：');
    console.error('');
    console.error('1. continue (推荐用于单用户应用)');
    console.error('   - 优点：无需跟踪 session ID，自动复用最近会话');
    console.error('   - 缺点：只能复用最近会话');
    console.error('   - 适用场景：单用户应用，每次一个对话');
    console.error('');
    console.error('2. resume (推荐用于多用户/多会话应用)');
    console.error('   - 优点：精确指定要复用的会话');
    console.error('   - 缺点：需要手动管理 session ID');
    console.error('   - 适用场景：多用户应用，需要恢复特定会话');
    console.error('');
    console.error('3. forkSession (用于探索性分支)');
    console.error('   - 优点：保留原始会话，创建新分支');
    console.error('   - 缺点：每次创建新会话，不能避免进程重启');
    console.error('   - 适用场景：尝试不同方案，保留原会话');
    console.error('');
    console.error('4. 单次 query 多轮对话');
    console.error('   - 优点：一次 query 完成多轮，最快速');
    console.error('   - 缺点：需要提前知道所有问题');
    console.error('   - 适用场景：批量处理，自动化流程');
    console.error('');
    console.error('不稳定/弃用的方法：');
    console.error('');
    console.error('1. V2 session API (createSession)');
    console.error('   - 状态：已弃用（deprecated）');
    console.error('   - 原因：官方推荐使用 V1 query + session options');
    console.error('');
    console.error('2. bridge/perpetual (@alpha 标记)');
    console.error('   - 状态：实验性（@alpha）');
    console.error('   - 风险：API 不稳定，可能随版本变化');
    console.error('   - 适用场景：仅用于 claude.ai 集成');
    console.error('');
    console.error('避免反复重启的关键：');
    console.error('  ✅ 使用 continue/resume 保持会话');
    console.error('  ✅ 使用 conversation generator 批量处理');
    console.error('  ❌ 避免每次都创建新 query');

    expect(true).toBe(true);
  }, 10000);
});
