/**
 * SDK 流式事件类型观察性测试
 *
 * 目标：系统性捕获 SDK 在 SSE 流中推送的所有事件类型，
 * 特别关注：
 * 1. 纯文本场景 vs 工具调用场景的事件类型差异
 * 2. stream_event (SDKPartialAssistantMessage) 内部的 event.type 分布
 * 3. 工具调用场景：assistant.message.content 中 tool_use / tool_result 的结构
 * 4. SDKToolProgressMessage 的推送频率
 * 5. includePartialMessages 开/关的对比
 *
 * 方式：通过 NestJS HTTP API (SSE) 收集事件
 * 断言策略：先 console.error 观察实际值，再写精确的结构断言
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
dotenv.config();

// ====== 公共配置 ======

const QUERY_OPTIONS = {
  env: getProfileEnv('bigmodel', { includeBehaviorEnv: false }),
  agent: 'simple',
  agents: {
    simple: {
      description: 'Simple fast agent',
      prompt: '你是一个简单的助手，按照用户要求执行操作。',
      model: 'haiku',
      tools: [],
      skills: [],
    },
  },
  persistSession: false,
  effort: 'low',
};

const QUERY_OPTIONS_WITH_TOOLS = {
  ...QUERY_OPTIONS,
  agents: {
    ...QUERY_OPTIONS.agents,
    simple: {
      ...QUERY_OPTIONS.agents.simple,
      tools: undefined,  // 使用默认工具集
    },
  },
  agent: undefined,      // 不指定 agent，使用默认
};

// ====== 通用工具函数 ======

interface CapturedEvent {
  index: number;
  serverTs: number;
  clientTs: number;
  raw: any;         // 原始 SSE data（已 JSON.parse）
  inner: any;       // 解析后的 content（如果有）
}

/** 通过 HTTP SSE 收集所有事件 */
async function collectSSEEvents(
  baseUrl: string,
  prompt: string,
  extraOptions?: Record<string, any>,
): Promise<{ events: CapturedEvent[]; duration: number }> {
  const requestStart = Date.now();

  const response = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      options: {
        ...QUERY_OPTIONS,
        includePartialMessages: true,
        ...extraOptions,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const events: CapturedEvent[] = [];
  let buffer = '';
  let eventIndex = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunkTs = Date.now();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const match = line.match(/^data:\s*(.+)$/);
      if (!match) continue;

      try {
        const raw = JSON.parse(match[1]);
        // 解析 inner content（NestJS 包装后的 content 字段）
        let inner = raw.content;
        if (typeof inner === 'string') {
          try { inner = JSON.parse(inner); } catch { /* keep as string */ }
        }

        events.push({
          index: eventIndex++,
          serverTs: raw.ts || chunkTs,
          clientTs: chunkTs,
          raw,
          inner,
        });
      } catch {
        // 忽略解析错误
      }
    }
  }

  return { events, duration: Date.now() - requestStart };
}

/** 从 inner 中提取 SDK 消息类型 */
function getSDKType(inner: any): string {
  if (!inner || typeof inner !== 'object') return '(string)';
  return inner.type || '(no type)';
}

/** 按 SDK 消息类型分组 */
function groupBySDKType(events: CapturedEvent[]): Map<string, CapturedEvent[]> {
  const groups = new Map<string, CapturedEvent[]>();
  for (const e of events) {
    const type = getSDKType(e.inner);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(e);
  }
  return groups;
}

/** 分析 stream_event 内部结构 */
function analyzeStreamEvents(events: CapturedEvent[]): {
  eventTypes: Map<string, number>;
  deltaTypes: Map<string, number>;
  blockTypes: Map<string, number>;
  toolUseSamples: any[];
} {
  const eventTypes = new Map<string, number>();
  const deltaTypes = new Map<string, number>();
  const blockTypes = new Map<string, number>();
  const toolUseSamples: any[] = [];

  const streamEvents = events.filter(e => getSDKType(e.inner) === 'stream_event');

  for (const e of streamEvents) {
    const evt = e.inner?.event;
    if (!evt) continue;

    const count1 = eventTypes.get(evt.type) || 0;
    eventTypes.set(evt.type, count1 + 1);

    if (evt.delta?.type) {
      const count2 = deltaTypes.get(evt.delta.type) || 0;
      deltaTypes.set(evt.delta.type, count2 + 1);
    }

    if (evt.type === 'content_block_start' && evt.content_block?.type) {
      const bt = evt.content_block.type;
      const count3 = blockTypes.get(bt) || 0;
      blockTypes.set(bt, count3 + 1);

      if (bt === 'tool_use') {
        toolUseSamples.push({
          id: evt.content_block.id,
          name: evt.content_block.name,
        });
      }
    }
  }

  return { eventTypes, deltaTypes, blockTypes, toolUseSamples };
}

/** 分析 assistant 消息的 content blocks */
function analyzeAssistantMessages(events: CapturedEvent[]): any[] {
  return events
    .filter(e => getSDKType(e.inner) === 'assistant')
    .map(e => {
      const msg = e.inner?.message;
      const blocks = msg?.content || [];
      return {
        index: e.index,
        blockCount: blocks.length,
        blockTypes: blocks.map((b: any) => b.type),
        stopReason: msg?.stop_reason,
        toolUseBlocks: blocks
          .filter((b: any) => b.type === 'tool_use')
          .map((b: any) => ({ id: b.id, name: b.name, input_keys: Object.keys(b.input || {}) })),
        textBlocks: blocks
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text?.slice(0, 100)),
      };
    });
}

/** 分析 result 消息 */
function analyzeResult(events: CapturedEvent[]): any {
  const result = events.find(e => getSDKType(e.inner) === 'result');
  if (!result) return null;
  const r = result.inner;
  return {
    subtype: r.subtype,
    result: r.result?.slice(0, 200),
    numTurns: r.num_turns,
    durationMs: r.duration_ms,
    costUsd: r.total_cost_usd,
    stopReason: r.stop_reason,
  };
}

/** 打印完整诊断报告 */
function printReport(label: string, events: CapturedEvent[], duration: number) {
  const byType = groupBySDKType(events);
  const streamAnalysis = analyzeStreamEvents(events);
  const assistantMsgs = analyzeAssistantMessages(events);
  const resultAnalysis = analyzeResult(events);

  console.error(`\n${'='.repeat(60)}`);
  console.error(`📊 ${label}`);
  console.error(`${'='.repeat(60)}`);
  console.error(`总事件数: ${events.length}`);
  console.error(`总时长: ${duration}ms`);
  console.error('');

  // 1. 按 SDK 类型分组
  console.error('── SDK 消息类型分布 ──');
  for (const [type, evts] of byType) {
    console.error(`  ${type}: ${evts.length}`);
  }
  console.error('');

  // 2. stream_event 内部分析
  if (streamAnalysis.eventTypes.size > 0) {
    console.error('── stream_event → event.type ──');
    for (const [type, count] of streamAnalysis.eventTypes) {
      console.error(`  ${type}: ${count}`);
    }
    console.error('');
  }

  if (streamAnalysis.deltaTypes.size > 0) {
    console.error('── delta.type 分布 ──');
    for (const [type, count] of streamAnalysis.deltaTypes) {
      console.error(`  ${type}: ${count}`);
    }
    console.error('');
  }

  if (streamAnalysis.blockTypes.size > 0) {
    console.error('── content_block 类型 ──');
    for (const [type, count] of streamAnalysis.blockTypes) {
      console.error(`  ${type}: ${count}`);
    }
    console.error('');
  }

  if (streamAnalysis.toolUseSamples.length > 0) {
    console.error('── tool_use 样本 ──');
    for (const s of streamAnalysis.toolUseSamples) {
      console.error(`  ${JSON.stringify(s)}`);
    }
    console.error('');
  }

  // 3. assistant 消息
  if (assistantMsgs.length > 0) {
    console.error('── SDKAssistantMessage ──');
    for (const msg of assistantMsgs) {
      console.error(`  [${msg.index}] blocks: ${msg.blockCount}, types: [${msg.blockTypes.join(', ')}], stop: ${msg.stopReason}`);
      if (msg.toolUseBlocks.length > 0) {
        console.error(`    tool_use: ${JSON.stringify(msg.toolUseBlocks)}`);
      }
      if (msg.textBlocks.length > 0) {
        console.error(`    text: ${msg.textBlocks.join(' | ')}`);
      }
    }
    console.error('');
  }

  // 4. Result
  if (resultAnalysis) {
    console.error('── SDKResultMessage ──');
    console.error(`  subtype: ${resultAnalysis.subtype}`);
    console.error(`  result: ${resultAnalysis.result}`);
    console.error(`  num_turns: ${resultAnalysis.numTurns}`);
    console.error(`  duration_ms: ${resultAnalysis.durationMs}`);
    console.error('');
  }

  // 5. 事件时间线
  console.error('── 事件时间线 ──');
  const limit = Math.min(20, events.length);
  for (let i = 0; i < limit; i++) {
    const e = events[i];
    const sdkType = getSDKType(e.inner);
    const detail = sdkType === 'stream_event'
      ? e.inner?.event?.type || ''
      : sdkType === 'system'
        ? e.inner?.subtype || ''
        : '';
    console.error(`  [${String(i).padStart(3)}] ${sdkType} ${detail}`);
  }
  if (events.length > 30) {
    console.error(`  ... (${events.length - 30} omitted) ...`);
    for (let i = events.length - 10; i < events.length; i++) {
      const e = events[i];
      const sdkType = getSDKType(e.inner);
      const detail = sdkType === 'stream_event'
        ? e.inner?.event?.type || ''
        : sdkType === 'system'
          ? e.inner?.subtype || ''
          : '';
      console.error(`  [${String(i).padStart(3)}] ${sdkType} ${detail}`);
    }
  }
  console.error('');
}

// ====== 测试用例 ======

describe('SDK 流式事件类型全景观察', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  /** Case 1: 纯文本回复（无工具调用）— 事件类型基线 */
  it('case-1 纯文本回复的完整事件流', async () => {
    const dir = createTimestampDir('stream-event-types/case-1-text-only');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      '回复"Hello World"这几个字，不要回复其他任何内容。不要使用任何工具。',
    );

    printReport('Case 1: 纯文本回复（基线）', events, duration);

    const byType = groupBySDKType(events);
    const streamAnalysis = analyzeStreamEvents(events);

    // 保存完整事件日志
    writeFileSync(
      `${dir}/events.json`,
      JSON.stringify(events.map(e => ({ i: e.index, sdkType: getSDKType(e.inner), raw: e.raw })), null, 2),
    );

    // 结构断言
    expect(byType.has('system')).toBe(true);        // SDKSystemMessage (init)
    expect(byType.has('assistant')).toBe(true);     // SDKAssistantMessage
    expect(byType.has('result')).toBe(true);        // SDKResultMessage

    // 有 partial 才会有 stream_event
    const hasPartial = events.some(e => e.raw.type === 'partial');
    if (hasPartial) {
      expect(byType.has('stream_event')).toBe(true);
      expect(streamAnalysis.deltaTypes.has('text_delta')).toBe(true);
    }
  }, 120000);

  /** Case 2: 触发 Glob 工具 — 观察工具调用的事件流 */
  it('case-2 工具调用场景（通过默认 agent 不限制工具）', async () => {
    const dir = createTimestampDir('stream-event-types/case-2-with-tools');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      '请阅读 ./package.json 文件的内容，然后告诉我项目名称。',
      QUERY_OPTIONS_WITH_TOOLS,
    );

    printReport('Case 2: 工具调用场景', events, duration);

    const byType = groupBySDKType(events);
    const streamAnalysis = analyzeStreamEvents(events);
    const assistantMsgs = analyzeAssistantMessages(events);

    // 保存
    writeFileSync(
      `${dir}/events.json`,
      JSON.stringify(events.map(e => ({ i: e.index, sdkType: getSDKType(e.inner), raw: e.raw })), null, 2),
    );

    // 基本结构断言
    expect(byType.has('system')).toBe(true);
    expect(byType.has('assistant')).toBe(true);
    expect(byType.has('result')).toBe(true);

    // 观察是否有 tool_use
    if (streamAnalysis.toolUseSamples.length > 0) {
      console.error('✅ 检测到 tool_use content_block');
      expect(streamAnalysis.deltaTypes.has('input_json_delta')).toBe(true);
    } else {
      console.error('⚠️ 未检测到 tool_use（LLM 可能直接回答）');
    }

    // 观察多轮
    console.error(`  assistant 消息数: ${assistantMsgs.length}`);
  }, 120000);

  /** Case 3: 关闭 includePartialMessages — 对比 */
  it('case-3 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-event-types/case-3-no-partial');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '回复"Test"这两个字，不要回复其他任何内容。不要使用任何工具。',
        options: {
          ...QUERY_OPTIONS,
          includePartialMessages: false,
        },
      }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: CapturedEvent[] = [];
    let buffer = '';
    let eventIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^data:\s*(.+)$/);
        if (!match) continue;
        try {
          const raw = JSON.parse(match[1]);
          let inner = raw.content;
          if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch {} }
          events.push({ index: eventIndex++, serverTs: raw.ts || Date.now(), clientTs: Date.now(), raw, inner });
        } catch {}
      }
    }
    const duration = Date.now() - requestStart;

    printReport('Case 3: 无流式 (includePartialMessages=false)', events, duration);

    const byType = groupBySDKType(events);

    // 关闭 partial 后不应有 stream_event
    expect(byType.has('stream_event')).toBe(false);

    // 仍应有 system, assistant, result
    expect(byType.has('system')).toBe(true);
    expect(byType.has('assistant')).toBe(true);
    expect(byType.has('result')).toBe(true);

    writeFileSync(
      `${dir}/events.json`,
      JSON.stringify(events.map(e => ({ i: e.index, sdkType: getSDKType(e.inner), raw: e.raw })), null, 2),
    );
  }, 120000);

  /** Case 4: 观察所有 system subtype 的分布 */
  it('case-4 system 消息 subtype 分布', async () => {
    const { events } = await collectSSEEvents(
      baseUrl,
      '回复"OK"这两个字，不要回复其他任何内容。不要使用任何工具。',
    );

    const systemEvents = events.filter(e => getSDKType(e.inner) === 'system');
    const subtypes = new Map<string, number>();
    for (const e of systemEvents) {
      const sub = e.inner?.subtype || '(no subtype)';
      subtypes.set(sub, (subtypes.get(sub) || 0) + 1);
    }

    console.error('\n📊 system 消息 subtype 分布');
    console.error('═══════════════════════════════════');
    for (const [sub, count] of subtypes) {
      console.error(`  ${sub}: ${count}`);
    }

    // init 应该总是存在
    expect(subtypes.has('init')).toBe(true);
  }, 120000);

  /** Case 5: 完整事件类型目录（静态参考，不做 API 调用） */
  it('case-5 SDK 消息类型完整目录（静态参考）', async () => {
    console.error('\n📋 SDK 消息类型完整目录（来自 sdk.d.ts）');
    console.error('═══════════════════════════════════');
    console.error('');
    console.error('SDKMessage = 以下类型的联合（共 27 种）：');
    console.error('');

    const sdkTypes: { type: string; subtype?: string; tsType: string; desc: string }[] = [
      { type: 'assistant',            tsType: 'SDKAssistantMessage',         desc: '完整 assistant 消息（包含完整 BetaMessage，含 content blocks）' },
      { type: 'user',                 tsType: 'SDKUserMessage',             desc: '用户消息' },
      { type: 'user',                 tsType: 'SDKUserMessageReplay',       desc: '用户消息回放（含 isReplay=true）' },
      { type: 'result',               tsType: 'SDKResultSuccess',           desc: '成功结果（含 result 文本、cost、usage）' },
      { type: 'result',               tsType: 'SDKResultError',             desc: '错误结果（含 errors 列表）' },
      { type: 'stream_event',         tsType: 'SDKPartialAssistantMessage', desc: '流式片段（BetaRawMessageStreamEvent：message_start/delta/stop 等）' },
      { type: 'system',  subtype: 'init',             tsType: 'SDKSystemMessage',           desc: '会话初始化（含 tools、model、skills 列表）' },
      { type: 'system',  subtype: 'api_retry',        tsType: 'SDKAPIRetryMessage',         desc: 'API 重试通知' },
      { type: 'system',  subtype: 'compact_boundary', tsType: 'SDKCompactBoundaryMessage',  desc: '上下文压缩边界' },
      { type: 'system',  subtype: 'status',           tsType: 'SDKStatusMessage',           desc: '状态更新（loading 等）' },
      { type: 'system',  subtype: 'task_started',     tsType: 'SDKTaskStartedMessage',      desc: '后台任务启动' },
      { type: 'system',  subtype: 'task_updated',     tsType: 'SDKTaskUpdatedMessage',      desc: '后台任务状态更新' },
      { type: 'system',  subtype: 'task_progress',    tsType: 'SDKTaskProgressMessage',     desc: '后台任务进度' },
      { type: 'system',  subtype: 'task_notification', tsType: 'SDKTaskNotificationMessage', desc: '后台任务完成通知' },
      { type: 'system',  subtype: 'plugin_install',   tsType: 'SDKPluginInstallMessage',    desc: '插件安装进度' },
      { type: 'system',  subtype: 'files_persisted',  tsType: 'SDKFilesPersistedEvent',     desc: '文件持久化事件' },
      { type: 'system',  subtype: 'mirror_error',     tsType: 'SDKMirrorErrorMessage',      desc: 'Mirror 写入失败' },
      { type: 'system',  subtype: 'elicitation_complete', tsType: 'SDKElicitationCompleteMessage', desc: 'MCP Elicitation 完成' },
      { type: 'system',  subtype: 'session_state_changed', tsType: 'SDKSessionStateChangedMessage', desc: '会话状态变更' },
      { type: 'system',  subtype: 'hook_started',     tsType: 'SDKHookStartedMessage',      desc: 'Hook 开始执行' },
      { type: 'system',  subtype: 'hook_progress',    tsType: 'SDKHookProgressMessage',     desc: 'Hook 执行进度' },
      { type: 'system',  subtype: 'hook_response',    tsType: 'SDKHookResponseMessage',     desc: 'Hook 执行结果' },
      { type: 'system',  subtype: 'settings_parse_error', tsType: 'SDKSettingsParseError',  desc: '配置解析错误' },
      { type: 'tool_progress',        tsType: 'SDKToolProgressMessage',     desc: '工具执行进度（tool_name、elapsed_time_seconds）' },
      { type: 'tool_use_summary',     tsType: 'SDKToolUseSummaryMessage',   desc: '工具使用摘要（summary 文本）' },
      { type: 'auth_status',          tsType: 'SDKAuthStatusMessage',       desc: '认证状态变更' },
      { type: 'rate_limit_event',     tsType: 'SDKRateLimitEvent',          desc: '速率限制事件' },
      { type: 'notification',         tsType: 'SDKNotificationMessage',     desc: '文本通知（key/priority/timeout）' },
      { type: 'local_command_output', tsType: 'SDKLocalCommandOutputMessage', desc: '本地命令输出' },
      { type: 'memory_recall',        tsType: 'SDKMemoryRecallMessage',     desc: 'Agent memory 召回' },
      { type: 'prompt_suggestion',    tsType: 'SDKPromptSuggestionMessage', desc: '建议的下一条 prompt' },
    ];

    for (const t of sdkTypes) {
      const subStr = t.subtype ? ` [${t.subtype}]` : '';
      console.error(`  ${t.type}${subStr}`);
      console.error(`    → ${t.tsType}`);
      console.error(`    ${t.desc}`);
      console.error('');
    }

    // stream_event 内部的 BetaRawMessageStreamEvent 类型
    console.error('── stream_event 内部的 event.type ──');
    console.error('');
    const streamEventTypes = [
      { type: 'message_start',         desc: '消息开始，含 model、usage' },
      { type: 'content_block_start',   desc: '内容块开始（type: text | tool_use），含 block id/name/schema' },
      { type: 'content_block_delta',   desc: '内容块增量（text_delta | thinking_delta | input_json_delta）' },
      { type: 'content_block_stop',    desc: '内容块结束' },
      { type: 'message_delta',         desc: '消息级增量（stop_reason、usage）' },
      { type: 'message_stop',          desc: '消息结束' },
    ];
    for (const t of streamEventTypes) {
      console.error(`  ${t.type}`);
      console.error(`    ${t.desc}`);
      console.error('');
    }

    expect(true).toBe(true);
  }, 10000);

  /** Case 6: tool_progress 事件观察 */
  it('case-6 tool_progress 事件频率观察', async () => {
    const { events, duration } = await collectSSEEvents(
      baseUrl,
      '回复"OK"这两个字，不要回复其他任何内容。不要使用任何工具。',
    );

    const byType = groupBySDKType(events);
    const toolProgress = byType.get('tool_progress') || [];

    console.error('\n📊 tool_progress 事件分析');
    console.error('═══════════════════════════════════');
    console.error(`  tool_progress 事件数: ${toolProgress.length}`);

    if (toolProgress.length > 0) {
      for (const e of toolProgress) {
        console.error(`  tool_name: ${e.inner?.tool_name}, elapsed: ${e.inner?.elapsed_time_seconds}s, tool_use_id: ${e.inner?.tool_use_id}`);
      }
    } else {
      console.error('  (无 tool_progress 事件，因为纯文本场景不执行工具)');
    }
    console.error('');

    // 纯文本场景不应有 tool_progress
    expect(toolProgress.length).toBe(0);
  }, 120000);
});
