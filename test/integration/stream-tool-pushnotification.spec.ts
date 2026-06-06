/**
 * PushNotification 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，PushNotification 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. PushNotification 的 tool_use input 格式？（message 字段？title 字段？）
 * 2. PushNotification 的 tool_result 返回值格式？（成功/失败结构）
 * 3. PushNotification 执行期间 SDK 推送哪些状态更新事件？tool_progress 频率？
 * 4. PushNotification 是瞬时工具还是需要等待推送完成？
 * 5. 前端用 Vue3 + Element Plus 如何渲染 PushNotification 调用过程？
 *
 * 方法论：
 * - Case 1: 触发 PushNotification — 完整事件时间线
 * - Case 2: 带 title 的 PushNotification — 对比 input 差异
 * - Case 3: 纯文本基线 — 无工具调用对比
 * - Case 4: 通过 NestJS SSE — 前端视角
 * - Case 5: 关闭 includePartialMessages 对比
 * - Case 6: 工具不可用时的回退行为
 *
 * 注意：
 * - PushNotification 不需要权限（No permission required）
 * - PushNotification 依赖 Anthropic 直连端点（Bedrock/Vertex/Foundry 不可用）
 * - 本地 LLM 可能不调用 PushNotification，使用宽松断言
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';

dotenv.config();

// ====== 公共配置 ======

const BASE_ENV = getProfileEnv('local');

// ====== 事件收集工具 ======

interface CapturedSDKEvent {
  index: number;
  type: string;             // SDK 消息 type
  subtype?: string;         // system 消息的 subtype
  timestamp: number;
  // stream_event 详情
  eventType?: string;       // event.type: message_start, content_block_start, etc.
  deltaType?: string;       // delta.type: text_delta, thinking_delta, input_json_delta
  // tool_use 详情
  toolName?: string;
  toolUseId?: string;
  inputJsonSnippet?: string; // input_json_delta 的 partial_json 片段
  // 完整原始消息（可选，用于调试）
  raw?: any;
}

/**
 * 直接调用 SDK 并收集所有事件（含 stream_event）
 */
async function collectSDKEvents(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  logDir?: string;
  bypassPermissions?: boolean;
}): Promise<{
  events: CapturedSDKEvent[];
  resultText: string;
  duration: number;
}> {
  const startTime = Date.now();
  const events: CapturedSDKEvent[] = [];
  let resultText = '';
  let index = 0;
  let inputJsonBuffer = '';
  let currentToolName: string | null = null;

  const env = options.logDir
    ? { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` }
    : (options.env || BASE_ENV);

  const queryOptions: any = {
    env,
    includePartialMessages: true,
    persistSession: false,
    settingSources: [],
    effort: 'low',
  };

  if (options.bypassPermissions) {
    queryOptions.permissionMode = 'bypassPermissions';
  }

  const sdkQuery = query({
    prompt: options.prompt,
    options: queryOptions,
  });

  for await (const message of sdkQuery) {
    const msg = message as any;
    const type = msg.type || 'unknown';
    const captured: CapturedSDKEvent = {
      index: index++,
      type,
      timestamp: Date.now(),
    };

    // 处理 stream_event 内部结构
    if (type === 'stream_event' && msg.event) {
      const evt = msg.event;
      captured.eventType = evt.type;

      if (evt.type === 'content_block_start' && evt.content_block) {
        if (evt.content_block.type === 'tool_use') {
          captured.toolName = evt.content_block.name;
          captured.toolUseId = evt.content_block.id;
          currentToolName = evt.content_block.name;
          inputJsonBuffer = ''; // 重置 JSON 拼接缓冲
        }
      }

      if (evt.type === 'content_block_delta' && evt.delta) {
        captured.deltaType = evt.delta.type;
        if (evt.delta.type === 'input_json_delta') {
          captured.inputJsonSnippet = evt.delta.partial_json;
          inputJsonBuffer += evt.delta.partial_json || '';
        }
      }

      if (evt.type === 'content_block_stop') {
        currentToolName = null;
      }
    }

    // 处理 system 消息
    if (type === 'system') {
      captured.subtype = msg.subtype;
      // system init 消息中包含工具列表
      if (msg.subtype === 'init' && msg.tools) {
        const pushNotifTool = (msg.tools as any[]).find(
          (t: any) => t.name === 'PushNotification',
        );
        if (pushNotifTool) {
          captured.raw = {
            pushNotifToolSchema: pushNotifTool,
          };
        }
      }
    }

    // 处理 assistant 消息 — 提取 tool_use blocks
    if (type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          captured.toolName = block.name;
          captured.toolUseId = block.id;
          // 保存完整的 tool input
          if (!captured.raw) captured.raw = {};
          captured.raw.toolInput = block.input;
        }
        if (block.type === 'text') {
          if (!captured.raw) captured.raw = {};
          captured.raw.textSnippet = block.text?.substring(0, 200);
        }
      }
    }

    // 处理 user 消息 — 提取 tool_result
    if (type === 'user') {
      captured.raw = {
        parent_tool_use_id: msg.parent_tool_use_id,
        tool_use_result: msg.tool_use_result,
        messageContentTypes: Array.isArray(msg.message?.content)
          ? msg.message.content.map((b: any) => ({
              type: b.type,
              tool_use_id: b.tool_use_id,
              contentType: typeof b.content === 'string' ? 'string' : Array.isArray(b.content) ? 'array' : typeof b.content,
              contentSnippet: typeof b.content === 'string'
                ? b.content.substring(0, 1000)
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => c.type === 'text' ? c.text?.substring(0, 500) : c.type)
                  : undefined,
            }))
          : undefined,
      };
    }

    // 处理 tool_progress 消息
    if (type === 'tool_progress') {
      captured.toolName = msg.tool_name;
      captured.toolUseId = msg.tool_use_id;
      captured.raw = {
        tool_name: msg.tool_name,
        elapsed_time_seconds: msg.elapsed_time_seconds,
        parent_tool_use_id: msg.parent_tool_use_id,
      };
    }

    // 处理 tool_use_summary 消息
    if (type === 'tool_use_summary') {
      captured.raw = {
        summary: msg.summary,
        preceding_tool_use_ids: msg.preceding_tool_use_ids,
      };
    }

    // 处理 result 消息
    if (type === 'result') {
      resultText = msg.result || '';
      captured.raw = {
        subtype: msg.subtype,
        num_turns: msg.num_turns,
        duration_ms: msg.duration_ms,
        stop_reason: msg.stop_reason,
        total_cost_usd: msg.total_cost_usd,
      };
    }

    events.push(captured);

    // 打印 text_delta 到 stderr
    if (type === 'stream_event' && msg.event?.type === 'content_block_delta') {
      const delta = msg.event.delta;
      if (delta?.type === 'text_delta') {
        process.stderr.write(delta.text);
      }
    }
  }

  return { events, resultText, duration: Date.now() - startTime };
}

/** 打印完整事件时间线 */
function printTimeline(label: string, events: CapturedSDKEvent[], duration: number) {
  console.error(`\n${'='.repeat(70)}`);
  console.error(`📊 ${label}`);
  console.error(`${'='.repeat(70)}`);
  console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);
  console.error('');

  // 按 type 分组统计
  const typeCount = new Map<string, number>();
  for (const e of events) {
    let key = e.type;
    if (e.eventType) key += ` → ${e.eventType}`;
    if (e.deltaType) key += ` [${e.deltaType}]`;
    typeCount.set(key, (typeCount.get(key) || 0) + 1);
  }

  console.error('── 事件类型分布 ──');
  for (const [key, count] of typeCount) {
    console.error(`  ${key}: ${count}`);
  }
  console.error('');

  // 完整时间线
  console.error('── 事件时间线 ──');
  for (const e of events) {
    let detail = '';
    if (e.type === 'stream_event') {
      detail = e.eventType || '';
      if (e.deltaType) detail += ` (${e.deltaType})`;
      if (e.toolName) detail += ` [${e.toolName}]`;
      if (e.inputJsonSnippet) detail += ` "${e.inputJsonSnippet.substring(0, 80)}"`;
    } else if (e.type === 'system') {
      detail = e.subtype || '';
    } else if (e.type === 'assistant') {
      if (e.toolName) detail = `[tool_use: ${e.toolName}]`;
      else if (e.raw?.textSnippet) detail = `[text: "${e.raw.textSnippet.substring(0, 50)}"]`;
    } else if (e.type === 'user') {
      detail = 'tool_result';
    } else if (e.type === 'tool_progress') {
      detail = `${e.toolName} (${e.raw?.elapsed_time_seconds}s)`;
    } else if (e.type === 'tool_use_summary') {
      detail = `"${e.raw?.summary?.substring(0, 80)}"`;
    }

    console.error(`  [${String(e.index).padStart(3)}] ${e.type} ${detail}`);
  }
  console.error('');
}

/** 提取 PushNotification 工具相关事件 */
function extractPushNotifEvents(events: CapturedSDKEvent[]) {
  let inPushNotifBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';

  // 查找 init 消息中 PushNotification 的 input_schema
  const initEvent = events.find(e => e.type === 'system' && e.subtype === 'init');
  const pushNotifSchema = initEvent?.raw?.pushNotifToolSchema || null;

  for (const e of events) {
    // content_block_start 标记进入 PushNotification block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === 'PushNotification') {
      inPushNotifBlock = true;
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inPushNotifBlock) {
      inPushNotifBlock = false;
    }
    // input_json_delta 在 PushNotification block 内
    if (inPushNotifBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
      if (e.inputJsonSnippet) fullInputJson += e.inputJsonSnippet;
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    pushNotifSchema,
    // assistant tool_use block
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName === 'PushNotification'),
    // user tool_result 消息
    userToolResult: events.filter(e => e.type === 'user'),
    // tool_progress 消息
    toolProgress: events.filter(e => e.type === 'tool_progress'),
    // tool_use_summary 消息
    toolUseSummary: events.filter(e => e.type === 'tool_use_summary'),
    // system status 消息
    systemStatuses: events.filter(e => e.type === 'system' && e.subtype === 'status'),
    // input_json_delta 推送次数
    inputDeltaCount: inputJsonDeltas.length,
  };
}

/** SSE 事件收集（通过 NestJS HTTP） */
interface CapturedSSEEvent {
  index: number;
  serverWrap: string; // 'text' | 'partial' | 'done' | 'error'
  sdkType: string;    // 解析后的 SDK type
  sdkSubtype?: string;
  raw: any;
  inner: any;
}

async function collectSSEEvents(
  baseUrl: string,
  prompt: string,
  extraOptions?: Record<string, any>,
): Promise<{ events: CapturedSSEEvent[]; duration: number }> {
  const startTime = Date.now();

  const response = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      options: {
        env: BASE_ENV,
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        effort: 'low',
        ...extraOptions,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: CapturedSSEEvent[] = [];
  let buffer = '';
  let index = 0;

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
        if (typeof inner === 'string') {
          try { inner = JSON.parse(inner); } catch { /* keep as string */ }
        }

        events.push({
          index: index++,
          serverWrap: raw.type || 'unknown',
          sdkType: inner?.type || '(no type)',
          sdkSubtype: inner?.subtype,
          raw,
          inner,
        });
      } catch {}
    }
  }

  return { events, duration: Date.now() - startTime };
}

// ====== 测试用例 ======

describe('PushNotification 工具流式事件观察', () => {

  /**
   * Case 1: 触发 PushNotification — 完整事件时间线
   *
   * 观察目标：
   * - PushNotification 是否出现在 SDK init 的 tools 列表中
   * - PushNotification 的 input_schema 结构
   * - PushNotification 的 input_json_delta 如何流式构建参数
   * - PushNotification 的 tool_result 格式（成功/失败）
   * - PushNotification 执行期间是否有 tool_progress 事件
   * - PushNotification 是否是瞬时工具
   */
  it('case-1 PushNotification 触发 — 完整事件时间线', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-1-basic');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the PushNotification tool to send a notification with the message "Test notification from Claude Code". Tell me what happened.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: PushNotification 触发', events, duration);

    // 提取 PushNotification 相关事件
    const pushEvents = extractPushNotifEvents(events);
    console.error('── PushNotification 相关事件 ──');
    console.error(`  PushNotification in tools list: ${pushEvents.pushNotifSchema ? 'YES' : 'NO'}`);
    if (pushEvents.pushNotifSchema) {
      console.error(`  input_schema: ${JSON.stringify(pushEvents.pushNotifSchema.input_schema, null, 2)}`);
    }
    console.error(`  input_json_delta 事件数: ${pushEvents.inputDeltaCount}`);
    console.error(`  assistant tool_use 事件数: ${pushEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${pushEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${pushEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${pushEvents.toolUseSummary.length}`);
    console.error(`  system status 事件数: ${pushEvents.systemStatuses.length}`);
    console.error('');

    // 打印完整 input JSON
    if (pushEvents.fullInputJson) {
      console.error('── 完整 PushNotification input JSON ──');
      try {
        const parsed = JSON.parse(pushEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
        console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
      } catch {
        console.error(`  (JSON 不完整: ${pushEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 打印 assistant tool_use blocks 详情
    if (pushEvents.assistantToolUse.length > 0) {
      console.error('\n── assistant tool_use 详情 ──');
      for (const e of pushEvents.assistantToolUse) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // 打印 user 消息详情（tool_result）
    if (pushEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of pushEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (pushEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of pushEvents.toolProgress) {
        console.error(`  [${e.index}] tool_name=${e.raw?.tool_name}, elapsed=${e.raw?.elapsed_time_seconds}s, tool_use_id=${e.raw?.tool_use_id}`);
      }
    }

    // 保存完整事件日志
    writeFileSync(
      `${dir}/sdk-events.json`,
      JSON.stringify(events, null, 2),
    );

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    // 如果 LLM 成功调用了 PushNotification
    if (pushEvents.assistantToolUse.length > 0) {
      // 应该有 input_json_delta
      expect(pushEvents.inputDeltaCount).toBeGreaterThan(0);

      // 应该有 user tool_result
      expect(pushEvents.userToolResult.length).toBeGreaterThan(0);

      // 验证有 result 消息
      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent).toBeDefined();
      if (resultEvent?.raw) {
        console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
        console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
      }
    } else {
      console.error('⚠️ LLM 未调用 PushNotification（直接文本回答或使用其他工具）');

      // 检查 LLM 使用了什么替代工具
      const allToolUse = events.filter(e => e.type === 'assistant' && e.toolName);
      if (allToolUse.length > 0) {
        console.error('  LLM 实际调用的工具:');
        for (const e of allToolUse) {
          console.error(`    - ${e.toolName}`);
        }
      }
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: 显式要求使用 PushNotification — 更强的指令
   *
   * 观察目标：
   * - 更强的 prompt 是否能引导 LLM 调用 PushNotification
   * - PushNotification 的 input schema 字段名
   */
  it('case-2 显式要求 PushNotification — input schema 观察', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-2-explicit');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'You must use the PushNotification tool exactly as specified. Call PushNotification with a message that says "Build completed successfully". Do not use any other approach. After calling the tool, report what it returned.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: 显式要求 PushNotification', events, duration);

    const pushEvents = extractPushNotifEvents(events);

    // 打印 input schema（如果有的话）
    if (pushEvents.pushNotifSchema) {
      console.error('── PushNotification input_schema ──');
      console.error(JSON.stringify(pushEvents.pushNotifSchema, null, 2));
    }

    // 打印完整 input JSON
    if (pushEvents.fullInputJson) {
      console.error('── 完整 PushNotification input JSON ──');
      try {
        const parsed = JSON.parse(pushEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
      } catch {
        console.error(`  (JSON 不完整: ${pushEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // user 消息中的 tool_result 详情
    if (pushEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of pushEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 所有工具调用
    const allToolUse = events.filter(e => e.type === 'assistant' && e.toolName);
    console.error('\n── 所有工具调用 ──');
    for (const e of allToolUse) {
      console.error(`  ${e.toolName}: ${JSON.stringify(e.raw?.toolInput)}`);
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 3: 纯文本基线 — 无工具调用对比
   */
  it('case-3 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-3-baseline');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Say exactly: "baseline test". Nothing else.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 3: 纯文本基线', events, duration);

    const hasToolUse = events.some(e => e.type === 'assistant' && e.toolName);
    const hasInputJsonDelta = events.some(e => e.deltaType === 'input_json_delta');
    const hasUser = events.some(e => e.type === 'user');
    const hasToolProgress = events.some(e => e.type === 'tool_progress');

    console.error('── 与工具调用场景对比 ──');
    console.error(`  has tool_use: ${hasToolUse}`);
    console.error(`  has input_json_delta: ${hasInputJsonDelta}`);
    console.error(`  has user message: ${hasUser}`);
    console.error(`  has tool_progress: ${hasToolProgress}`);

    // 纯文本场景不应有这些事件
    expect(hasToolUse).toBe(false);
    expect(hasInputJsonDelta).toBe(false);
    expect(hasUser).toBe(false);
    expect(hasToolProgress).toBe(false);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
  }, 120000);
});

// ====== NestJS SSE 测试 ======

describe('PushNotification 工具 SSE 深度事件分析', () => {
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

  /**
   * Case 4: PushNotification 通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构（id, name）
   * - input_json_delta 拼接后的完整 JSON
   * - user 消息中 tool_result 的完整结构
   * - tool_progress 在 SSE 中的表现
   */
  it('case-4 PushNotification SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-4-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the PushNotification tool to send a notification saying "Your task is complete". Tell me the result.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 4: PushNotification SSE 数据格式 — 前端解析参考');
    console.error(`${'='.repeat(70)}`);
    console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);

    // SSE 包装类型统计
    const wrapTypes = new Map<string, number>();
    const sdkTypes = new Map<string, number>();

    for (const e of events) {
      wrapTypes.set(e.serverWrap, (wrapTypes.get(e.serverWrap) || 0) + 1);
      sdkTypes.set(e.sdkType, (sdkTypes.get(e.sdkType) || 0) + 1);
    }

    console.error('\n── SSE 包装类型 ──');
    for (const [type, count] of wrapTypes) {
      console.error(`  ${type}: ${count}`);
    }
    console.error('\n── SDK 消息类型 ──');
    for (const [type, count] of sdkTypes) {
      console.error(`  ${type}: ${count}`);
    }

    // 查找 system init 消息中 PushNotification 的定义
    const systemInitEvents = events.filter(e => e.sdkType === 'system' && e.sdkSubtype === 'init');
    if (systemInitEvents.length > 0) {
      const initInner = systemInitEvents[0].inner;
      if (initInner?.tools) {
        const pushNotifTool = (initInner.tools as any[]).find(
          (t: any) => t.name === 'PushNotification',
        );
        if (pushNotifTool) {
          console.error('\n── PushNotification 工具定义（来自 system init）──');
          console.error(JSON.stringify(pushNotifTool, null, 2));
        } else {
          console.error('\n⚠️ PushNotification 不在 tools 列表中');
          // 列出所有工具名
          console.error('  可用工具: ' + initInner.tools.map((t: any) => t.name).join(', '));
        }
      }
    }

    // 跟踪工具 block 上下文
    let currentBlockType: string | null = null;
    let currentToolName: string | null = null;
    let inputJsonBuffer = '';
    let toolUseStartIndex = -1;

    const streamEvents = events.filter(e => e.sdkType === 'stream_event');
    const innerTypes = new Map<string, number>();

    for (const e of streamEvents) {
      const evt = e.inner?.event;
      if (!evt) continue;

      innerTypes.set(evt.type, (innerTypes.get(evt.type) || 0) + 1);

      if (evt.type === 'content_block_start') {
        currentBlockType = evt.content_block?.type || null;
        currentToolName = evt.content_block?.name || null;
        if (currentBlockType === 'tool_use') {
          toolUseStartIndex = e.index;
          inputJsonBuffer = '';
          console.error(`\n── content_block_start: tool_use ──`);
          console.error(`  name: ${currentToolName}`);
          console.error(`  id: ${evt.content_block?.id}`);
          console.error(`  event index: ${e.index}`);
        }
      }

      if (evt.type === 'content_block_delta' && currentBlockType === 'tool_use') {
        if (evt.delta?.type === 'input_json_delta') {
          inputJsonBuffer += evt.delta.partial_json || '';
          console.error(`  [${e.index}] input_json_delta += "${evt.delta.partial_json?.substring(0, 100)}"`);
        }
      }

      if (evt.type === 'content_block_stop' && currentBlockType === 'tool_use') {
        console.error(`\n── content_block_stop: tool_use (${currentToolName}) ──`);
        console.error(`  tool_use block 跨越事件数: ${e.index - toolUseStartIndex}`);
        console.error(`  完整 input JSON:`);
        try {
          const parsed = JSON.parse(inputJsonBuffer);
          console.error(JSON.stringify(parsed, null, 2));
        } catch {
          console.error(`  (JSON 不完整: ${inputJsonBuffer.substring(0, 300)})`);
        }
        currentBlockType = null;
        currentToolName = null;
      }
    }

    console.error('\n── stream_event 内部 event.type 分布 ──');
    for (const [type, count] of innerTypes) {
      console.error(`  ${type}: ${count}`);
    }

    // 提取 assistant 消息中的 tool_use block
    const assistantEvents = events.filter(e => e.sdkType === 'assistant');
    console.error('\n── assistant 消息 ──');
    for (const e of assistantEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        const blocks = msg.content;
        console.error(`  [${e.index}] blocks: ${blocks.length}, types: [${blocks.map((b: any) => b.type).join(', ')}]`);
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            console.error(`    tool_use: name=${block.name}, id=${block.id}`);
            console.error(`    input: ${JSON.stringify(block.input, null, 2)}`);
          }
          if (block.type === 'text') {
            console.error(`    text: "${block.text?.substring(0, 200)}"`);
          }
        }
      }
    }

    // 提取 user 消息（tool_result）
    const userEvents = events.filter(e => e.sdkType === 'user');
    console.error('\n── user 消息（tool_result）──');
    for (const e of userEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            console.error(`  tool_use_id: ${block.tool_use_id}`);
            console.error(`  content type: ${typeof block.content}`);
            if (typeof block.content === 'string') {
              console.error(`  content (string): "${block.content.substring(0, 500)}"`);
            } else if (Array.isArray(block.content)) {
              for (const c of block.content) {
                if (c.type === 'text') {
                  console.error(`  content[0].text: "${c.text?.substring(0, 500)}"`);
                } else {
                  console.error(`  content[0].type: ${c.type}`);
                }
              }
            }
          }
        }
      }
      // tool_use_result
      if (e.inner?.tool_use_result !== undefined) {
        console.error(`  tool_use_result type: ${typeof e.inner.tool_use_result}`);
        console.error(`  tool_use_result: ${JSON.stringify(e.inner.tool_use_result, null, 2)?.substring(0, 500)}`);
      }
    }

    // 提取 tool_progress
    const toolProgressEvents = events.filter(e => e.sdkType === 'tool_progress');
    console.error('\n── tool_progress 消息 ──');
    console.error(`  事件数: ${toolProgressEvents.length}`);
    for (const e of toolProgressEvents) {
      console.error(`  [${e.index}] tool_name=${e.inner?.tool_name}, elapsed=${e.inner?.elapsed_time_seconds}s`);
    }

    // 提取 tool_use_summary
    const toolUseSummaryEvents = events.filter(e => e.sdkType === 'tool_use_summary');
    console.error('\n── tool_use_summary 消息 ──');
    console.error(`  事件数: ${toolUseSummaryEvents.length}`);
    for (const e of toolUseSummaryEvents) {
      console.error(`  [${e.index}] summary: "${e.inner?.summary?.substring(0, 200)}"`);
      console.error(`  preceding_tool_use_ids: ${JSON.stringify(e.inner?.preceding_tool_use_ids)}`);
    }

    // 提取 result
    const resultEvents = events.filter(e => e.sdkType === 'result');
    if (resultEvents.length > 0) {
      console.error('\n── result 消息 ──');
      const r = resultEvents[0].inner;
      console.error(`  subtype: ${r.subtype}`);
      console.error(`  num_turns: ${r.num_turns}`);
      console.error(`  duration_ms: ${r.duration_ms}`);
      console.error(`  stop_reason: ${r.stop_reason}`);
    }

    // 保存
    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);
  }, 240000);

  /**
   * Case 5: 关闭 includePartialMessages — 对比
   */
  it('case-5 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-5-no-partial');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Use the PushNotification tool to send a notification saying "Hello". Tell me what happened.',
        options: {
          env: BASE_ENV,
          includePartialMessages: false,
          persistSession: false,
          settingSources: [],
          effort: 'low',
          permissionMode: 'bypassPermissions',
        },
      }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: CapturedSSEEvent[] = [];
    let buffer = '';
    let index = 0;

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
          events.push({ index: index++, serverWrap: raw.type || 'unknown', sdkType: inner?.type || '(no type)', sdkSubtype: inner?.subtype, raw, inner });
        } catch {}
      }
    }
    const duration = Date.now() - requestStart;

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: 关闭 includePartialMessages');
    console.error(`${'='.repeat(70)}`);
    console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);

    const sdkTypes = new Map<string, number>();
    for (const e of events) {
      sdkTypes.set(e.sdkType, (sdkTypes.get(e.sdkType) || 0) + 1);
    }
    console.error('\n── SDK 消息类型 ──');
    for (const [type, count] of sdkTypes) {
      console.error(`  ${type}: ${count}`);
    }

    // 关闭 partial 后不应有 stream_event
    expect(sdkTypes.has('stream_event')).toBe(false);

    // 但仍应有 system, assistant, result
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('assistant')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);

    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );
  }, 240000);

  /**
   * Case 6: 工具不可用时的回退行为分析
   *
   * 观察目标：
   * - PushNotification 不在 tools 列表时 LLM 的回退策略
   * - 与 Monitor/LSP 等条件性工具的回退行为对比
   */
  it('case-6 PushNotification 工具不可用/回退分析', async () => {
    const dir = createTimestampDir('stream-tool-pushnotification/case-6-fallback');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'I need to send a push notification to the user telling them "The deployment is done". What tools do you have available? Can you see PushNotification in your tools? List all tools you can use.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 6: PushNotification 工具不可用/回退', events, duration);

    // 检查 system init 中的工具列表
    const initEvent = events.find(e => e.type === 'system' && e.subtype === 'init');
    if (initEvent?.raw?.pushNotifToolSchema) {
      console.error('── PushNotification 在工具列表中 ──');
      console.error(JSON.stringify(initEvent.raw.pushNotifToolSchema, null, 2));
    } else {
      console.error('── PushNotification 不在工具列表中 ──');

      // 检查 system init 消息中可用的工具
      const systemInitRaw = (initEvent as any)?.raw;
      if (systemInitRaw) {
        console.error('  system init raw keys:', Object.keys(systemInitRaw));
      }

      // 直接从 SDK query 原始消息获取工具列表
      // 通过 stderr 已经输出了完整时间线，可以在那里看到工具列表
    }

    // 分析 LLM 的回退行为
    const allToolUse = events.filter(e => e.type === 'assistant' && e.toolName);
    console.error('\n── LLM 调用的所有工具 ──');
    if (allToolUse.length === 0) {
      console.error('  无工具调用（纯文本回答）');
    }
    for (const e of allToolUse) {
      console.error(`  ${e.toolName}: ${JSON.stringify(e.raw?.toolInput)?.substring(0, 200)}`);
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);
});
