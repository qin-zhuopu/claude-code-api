/**
 * Session Fork upToMessageId / resumeSessionAt 观察性测试
 *
 * 观察目标：
 * 1. forkSession() 独立函数 + upToMessageId 从指定 message 切片的行为
 * 2. query() resumeSessionAt + forkSession:true 一步截断+fork 的行为
 * 3. 截断边界的 inclusive 语义（截断点 message 本身是否保留）
 * 4. 两条路径截断后 messages 结构的差异
 * 5. 省略 upToMessageId 是否等同于完整拷贝（从最后一条 fork）
 *
 * 实验矩阵：
 * | case | 路径 | 方法                                        | 截断点                | 观察重点                     |
 * |------|------|---------------------------------------------|-----------------------|------------------------------|
 * | 1    | 基线 | conversation generator 3 轮历史              | 无                    | 收集每轮 assistant UUID      |
 * | 2    | B    | forkSession() + upToMessageId (round-1 asst)| 第 1 轮 assistant     | 截断后只有 round-1 内容      |
 * | 3    | B    | forkSession() + upToMessageId (round-2 asst)| 第 2 轮 assistant     | 截断后含 round-1+round-2     |
 * | 4    | A    | resumeSessionAt (round-1 asst) + fork:true  | 第 1 轮 assistant     | 一步截断+fork，ID 不同       |
 * | 5    | A    | resumeSessionAt (round-2 asst) + fork:true  | 第 2 轮 assistant     | 截断点差异对比                |
 * | 6    | B↔A  | 对比两条路径截断后的 messages 结构            | 同 round-2 assistant  | 结构一致性                    |
 * | 7    | 边界 | forkSession() 不传 upToMessageId            | 无（完整拷贝）         | 等同于从最后一条 fork         |
 */
import { describe, it, expect } from 'vitest';
import { query, forkSession, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
dotenv.config();

interface RoundInfo {
  roundIndex: number;
  assistantUuid: string;
  userUuid?: string;
  resultText: string;
}

interface SdkEvent {
  index: number;
  receivedAt: number;
  raw: any;
}

const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_BIGMODEL,
  ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

// ============================================================
// 运行单次 query 并收集 assistant UUID
// ============================================================
async function runSingleQuery(params: {
  prompt: string;
  options?: any;
  logDir?: string;
}): Promise<{ sessionId: string; assistantUuid: string; resultText: string; duration: number }> {
  const startTime = Date.now();
  let sessionId = '';
  let assistantUuid = '';
  let resultText = '';

  const env: any = { ...BASE_ENV, ...params.options?.env };
  if (params.logDir) {
    env.OTEL_LOG_RAW_API_BODIES = `file:${params.logDir}`;
  }

  const sdkQuery = query({
    prompt: params.prompt,
    options: {
      env,
      includePartialMessages: true,
      persistSession: true,
      effort: 'low',
      settingSources: [],
      ...params.options,
    },
  });

  for await (const message of sdkQuery) {
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      sessionId = message.session_id;
    }
    if (message.type === 'result' && message.session_id) {
      sessionId = message.session_id;
    }
    // 收集 assistant message UUID
    if (message.type === 'assistant' && message.uuid) {
      assistantUuid = message.uuid;
    }
    if (message.type === 'result' && message.result) {
      resultText = message.result;
    }
  }

  return { sessionId, assistantUuid, resultText, duration: Date.now() - startTime };
}

// ============================================================
// 分析请求日志：提取 messages 结构
// ============================================================
function analyzeRequestLogs(dir: string) {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir);
  const requestFiles = files.filter(
    (f) => f.endsWith('.request.json') && !f.includes('.pretty'),
  );

  return requestFiles.map((file) => {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const req = JSON.parse(content);
      return {
        file,
        messagesCount: req.messages?.length || 0,
        systemBlocks: req.system?.length || 0,
        toolsCount: req.tools?.length || 0,
        model: req.model,
        // 提取每条 message 的 role 和内容摘要
        messagesSummary: (req.messages || []).map((m: any) => ({
          role: m.role,
          contentType:
            typeof m.content === 'string'
              ? 'text'
              : Array.isArray(m.content)
                ? m.content.map((c: any) => c.type).join(',')
                : 'unknown',
          contentPreview:
            typeof m.content === 'string'
              ? m.content.substring(0, 40)
              : Array.isArray(m.content)
                ? m.content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => (c.text || '').substring(0, 40))
                    .join(' | ')
                : '',
        })),
      };
    } catch (e) {
      return { file, error: String(e) };
    }
  });
}

// ============================================================
// 测试用例
// ============================================================
describe('Session Fork upToMessageId / resumeSessionAt 观察性测试', () => {
  // 共享变量：多轮历史的 session ID 和每轮 assistant UUID
  let originalSessionId: string;
  let round1AssistantUuid: string;
  let round2AssistantUuid: string;

  it('case-1: 基线 - 用 resume 建立 2 轮历史并收集 UUID', async () => {
    const baseDir = createTimestampDir('session-fork-uptomessage/case-1-establish-history');
    const r1Dir = join(baseDir, 'round-1');
    const r2Dir = join(baseDir, 'round-2');
    mkdirSync(r1Dir, { recursive: true });
    mkdirSync(r2Dir, { recursive: true });

    // Round 1: 创建新会话
    console.error('\n📝 Round 1: 创建新会话');
    const r1 = await runSingleQuery({
      prompt: '记住我的名字是阿猫。简短回复。',
      logDir: r1Dir,
    });
    originalSessionId = r1.sessionId;
    round1AssistantUuid = r1.assistantUuid;
    console.error(`  Session ID: ${originalSessionId}`);
    console.error(`  Assistant UUID: ${round1AssistantUuid}`);
    console.error(`  Result: ${r1.resultText}`);

    // Round 2: resume 继续对话
    console.error('\n📝 Round 2: resume 继续对话');
    const r2 = await runSingleQuery({
      prompt: '我的名字是什么？只回答名字。',
      options: { resume: originalSessionId },
      logDir: r2Dir,
    });
    round2AssistantUuid = r2.assistantUuid;
    console.error(`  Session ID: ${r2.sessionId}`);
    console.error(`  Assistant UUID: ${round2AssistantUuid}`);
    console.error(`  Result: ${r2.resultText}`);

    // 验证 session ID 不变（resume 是延续同一个 session）
    console.error(`\n  Session ID 保持一致: ${r1.sessionId === r2.sessionId}`);

    // 分析请求日志
    const r1Analyses = analyzeRequestLogs(r1Dir);
    const r2Analyses = analyzeRequestLogs(r2Dir);
    console.error(`\nRound 1 请求数: ${r1Analyses.length}, messages: ${r1Analyses[0]?.messagesCount || 'N/A'}`);
    console.error(`Round 2 请求数: ${r2Analyses.length}, messages: ${r2Analyses[0]?.messagesCount || 'N/A'}`);
    r2Analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    console.error('\n📊 Case 1: 建立 2 轮历史');
    console.error('═══════════════════════════════════');
    console.error(`Session ID: ${originalSessionId}`);
    console.error(`Round 1 UUID: ${round1AssistantUuid}`);
    console.error(`Round 2 UUID: ${round2AssistantUuid}`);

    expect(originalSessionId).toBeTruthy();
    expect(round1AssistantUuid).toBeTruthy();
    expect(round2AssistantUuid).toBeTruthy();

    prettyFormatJsonFiles(r1Dir);
    prettyFormatJsonFiles(r2Dir);
  }, 240000);

  it('case-2: 路径 B - forkSession() + upToMessageId (round-1 assistant)', async () => {
    if (!originalSessionId || !round1AssistantUuid) {
      console.error('⚠️  依赖 case-1 的数据，跳过');
      return;
    }

    const baseDir = createTimestampDir('session-fork-uptomessage/case-2-fork-at-round1');
    const resumeDir = join(baseDir, 'resume');
    mkdirSync(resumeDir, { recursive: true });

    // Step 1: forkSession() 切片到 round-1
    console.error('\n📝 forkSession() 切片到 round-1');
    console.error(`  Original session: ${originalSessionId}`);
    console.error(`  upToMessageId: ${round1AssistantUuid}`);

    const forkResult = await forkSession(originalSessionId, {
      upToMessageId: round1AssistantUuid,
    });
    const forkedId = forkResult.sessionId;
    console.error(`  Forked session ID: ${forkedId}`);
    console.error(`  ID 不同: ${forkedId !== originalSessionId}`);

    // Step 2: resume forked session，查看截断后的上下文
    console.error('\n📝 resume forked session');
    const resumeResult = await runSingleQuery({
      prompt: '告诉我你还记得什么？简短回复。',
      options: { resume: forkedId },
      logDir: resumeDir,
    });
    console.error(`  Session ID: ${resumeResult.sessionId}`);
    console.error(`  Result: ${resumeResult.resultText}`);

    // 分析请求日志：messages 结构
    const analyses = analyzeRequestLogs(resumeDir);
    console.error(`\n请求数: ${analyses.length}`);
    analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    console.error('\n📊 Case 2: forkSession() + upToMessageId (round-1)');
    console.error('═══════════════════════════════════');
    console.error(`截断到 round-1 后 messages 数: ${analyses[0]?.messagesCount || 'N/A'}`);

    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(originalSessionId);
    expect(resumeResult.sessionId).toBeTruthy();

    prettyFormatJsonFiles(resumeDir);
  }, 240000);

  it('case-3: 路径 B - forkSession() + upToMessageId (round-2 assistant)', async () => {
    if (!originalSessionId || !round2AssistantUuid) {
      console.error('⚠️  依赖 case-1 的数据（round-2 UUID），跳过');
      return;
    }

    const baseDir = createTimestampDir('session-fork-uptomessage/case-3-fork-at-round2');
    const resumeDir = join(baseDir, 'resume');
    mkdirSync(resumeDir, { recursive: true });

    // forkSession() 切片到 round-2
    console.error('\n📝 forkSession() 切片到 round-2');
    const forkResult = await forkSession(originalSessionId, {
      upToMessageId: round2AssistantUuid,
    });
    const forkedId = forkResult.sessionId;
    console.error(`  Forked ID: ${forkedId}`);

    // resume forked session
    const resumeResult = await runSingleQuery({
      prompt: '告诉我你还记得什么？简短回复。',
      options: { resume: forkedId },
      logDir: resumeDir,
    });

    const analyses = analyzeRequestLogs(resumeDir);
    console.error('\n📊 Case 3: forkSession() + upToMessageId (round-2)');
    console.error('═══════════════════════════════════');
    console.error(`截断到 round-2 后 messages 数: ${analyses[0]?.messagesCount || 'N/A'}`);
    analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    console.error('\n  期望: round-2 截断的 messages 数 > round-1 截断的 messages 数');

    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(originalSessionId);
    expect(resumeResult.sessionId).toBeTruthy();

    prettyFormatJsonFiles(resumeDir);
  }, 240000);

  it('case-4: 路径 A - resumeSessionAt (round-1 assistant) + forkSession:true', async () => {
    if (!originalSessionId || !round1AssistantUuid) {
      console.error('⚠️  依赖 case-1 的数据，跳过');
      return;
    }

    const dir = createTimestampDir('session-fork-uptomessage/case-4-resume-session-at-round1');

    console.error('\n📝 resumeSessionAt + forkSession:true (round-1)');
    console.error(`  Original session: ${originalSessionId}`);
    console.error(`  resumeSessionAt: ${round1AssistantUuid}`);

    let forkedId = '';
    let resultText = '';

    const env: any = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };

    const sdkQuery = query({
      prompt: '告诉我你还记得什么？简短回复。',
      options: {
        resume: originalSessionId,
        resumeSessionAt: round1AssistantUuid,
        forkSession: true,
        env,
        persistSession: true,
        effort: 'low',
        settingSources: [],
      },
    });

    for await (const message of sdkQuery) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        forkedId = message.session_id;
      }
      if (message.type === 'result' && message.result) {
        resultText = message.result;
      }
    }

    const analyses = analyzeRequestLogs(dir);
    console.error('\n📊 Case 4: resumeSessionAt (round-1) + forkSession:true');
    console.error('═══════════════════════════════════');
    console.error(`Forked ID: ${forkedId}`);
    console.error(`ID 不同: ${forkedId !== originalSessionId}`);
    console.error(`Result: ${resultText.substring(0, 80)}`);
    console.error(`请求数: ${analyses.length}`);
    analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(originalSessionId);

    prettyFormatJsonFiles(dir);
  }, 240000);

  it('case-5: 路径 A - resumeSessionAt (round-2 assistant) + forkSession:true', async () => {
    if (!originalSessionId || !round2AssistantUuid) {
      console.error('⚠️  依赖 case-1 的数据（round-2 UUID），跳过');
      return;
    }

    const dir = createTimestampDir('session-fork-uptomessage/case-5-resume-session-at-round2');

    console.error('\n📝 resumeSessionAt + forkSession:true (round-2)');

    let forkedId = '';
    let resultText = '';

    const env: any = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };

    const sdkQuery = query({
      prompt: '告诉我你还记得什么？简短回复。',
      options: {
        resume: originalSessionId,
        resumeSessionAt: round2AssistantUuid,
        forkSession: true,
        env,
        persistSession: true,
        effort: 'low',
        settingSources: [],
      },
    });

    for await (const message of sdkQuery) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        forkedId = message.session_id;
      }
      if (message.type === 'result' && message.result) {
        resultText = message.result;
      }
    }

    const analyses = analyzeRequestLogs(dir);
    console.error('\n📊 Case 5: resumeSessionAt (round-2) + forkSession:true');
    console.error('═══════════════════════════════════');
    console.error(`Forked ID: ${forkedId}`);
    console.error(`请求数: ${analyses.length}`);
    analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(originalSessionId);

    prettyFormatJsonFiles(dir);
  }, 240000);

  it('case-6: 路径 B↔A 对比 - 同截断点下两条路径的 messages 结构', async () => {
    if (!originalSessionId || !round2AssistantUuid) {
      console.error('⚠️  依赖 case-1 的数据（round-2 UUID），跳过');
      return;
    }

    const baseDir = createTimestampDir('session-fork-uptomessage/case-6-path-comparison');
    const pathBDir = join(baseDir, 'path-b-resume');
    const pathADir = join(baseDir, 'path-a');
    mkdirSync(pathBDir, { recursive: true });
    mkdirSync(pathADir, { recursive: true });

    // 路径 B: forkSession() + upToMessageId → resume
    console.error('\n📝 路径 B: forkSession() + upToMessageId');
    const forkResult = await forkSession(originalSessionId, {
      upToMessageId: round2AssistantUuid,
    });
    const pathBId = forkResult.sessionId;
    console.error(`  Path B forked ID: ${pathBId}`);

    const pathBResume = await runSingleQuery({
      prompt: '告诉我你还知道什么。简短回复。',
      options: { resume: pathBId },
      logDir: pathBDir,
    });

    // 路径 A: resumeSessionAt + forkSession:true
    console.error('\n📝 路径 A: resumeSessionAt + forkSession:true');
    let pathAId = '';

    const pathAEnv: any = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${pathADir}` };

    const sdkQuery = query({
      prompt: '告诉我你还知道什么。简短回复。',
      options: {
        resume: originalSessionId,
        resumeSessionAt: round2AssistantUuid,
        forkSession: true,
        env: pathAEnv,
        persistSession: true,
        effort: 'low',
        settingSources: [],
      },
    });

    for await (const message of sdkQuery) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        pathAId = message.session_id;
      }
    }

    // 对比两条路径的 messages 结构
    const pathBAnalyses = analyzeRequestLogs(pathBDir);
    const pathAAnalyses = analyzeRequestLogs(pathADir);

    console.error('\n📊 Case 6: 路径 B↔A 对比');
    console.error('═══════════════════════════════════');
    console.error(`Path B ID: ${pathBId}`);
    console.error(`Path A ID: ${pathAId}`);
    console.error(`Path B messages 数: ${pathBAnalyses[0]?.messagesCount || 'N/A'}`);
    console.error(`Path A messages 数: ${pathAAnalyses[0]?.messagesCount || 'N/A'}`);
    console.error(
      `两者是否一致: ${pathBAnalyses[0]?.messagesCount === pathAAnalyses[0]?.messagesCount}`,
    );

    if (pathBAnalyses[0] && !pathBAnalyses[0].error) {
      console.error('\n  Path B messages 详情:');
      pathBAnalyses[0].messagesSummary.forEach((m: any) => {
        console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
      });
    }
    if (pathAAnalyses[0] && !pathAAnalyses[0].error) {
      console.error('\n  Path A messages 详情:');
      pathAAnalyses[0].messagesSummary.forEach((m: any) => {
        console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
      });
    }

    expect(pathBId).toBeTruthy();
    expect(pathAId).toBeTruthy();
    expect(pathBId).not.toBe(originalSessionId);
    expect(pathAId).not.toBe(originalSessionId);
    console.error(`  Path B ID ≠ Path A ID: ${pathBId !== pathAId}`);

    prettyFormatJsonFiles(pathBDir);
    prettyFormatJsonFiles(pathADir);
  }, 240000);

  it('case-7: 边界 - forkSession() 不传 upToMessageId（完整拷贝）', async () => {
    if (!originalSessionId) {
      console.error('⚠️  依赖 case-1 的数据，跳过');
      return;
    }

    const baseDir = createTimestampDir('session-fork-uptomessage/case-7-fork-no-uptomessageid');
    const resumeDir = join(baseDir, 'resume');
    mkdirSync(resumeDir, { recursive: true });

    // forkSession() 不传 upToMessageId → 完整拷贝
    console.error('\n📝 forkSession() 不传 upToMessageId');
    const forkResult = await forkSession(originalSessionId);
    const forkedId = forkResult.sessionId;
    console.error(`  Forked ID: ${forkedId}`);

    // resume 验证完整上下文
    const resumeResult = await runSingleQuery({
      prompt: '告诉我你全部还记得什么。简短回复。',
      options: { resume: forkedId },
      logDir: resumeDir,
    });

    const analyses = analyzeRequestLogs(resumeDir);
    console.error('\n📊 Case 7: forkSession() 无 upToMessageId（完整拷贝）');
    console.error('═══════════════════════════════════');
    console.error(`Forked ID: ${forkedId}`);
    console.error(`请求数: ${analyses.length}`);
    console.error(`messages 数: ${analyses[0]?.messagesCount || 'N/A'}`);
    analyses.forEach((a, i) => {
      if (!a.error) {
        console.error(`  Request ${i + 1}: ${a.messagesCount} messages`);
        a.messagesSummary.forEach((m: any) => {
          console.error(`    [${m.role}] ${m.contentType}: ${m.contentPreview}`);
        });
      }
    });

    console.error('\n  期望: 完整拷贝 messages 数 >= 任何截断版本的 messages 数');

    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(originalSessionId);
    expect(resumeResult.sessionId).toBeTruthy();

    // 验证原始会话仍然存在且不受影响
    const originalInfo = await getSessionInfo(originalSessionId);
    console.error(`  原始会话存在: ${!!originalInfo}`);
    expect(originalInfo).toBeTruthy();

    prettyFormatJsonFiles(resumeDir);
  }, 240000);
});
