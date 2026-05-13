/**
 * CronDelete 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，CronDelete 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. CronDelete 的 tool_use input 格式？（仅 id 字段？）
 * 2. CronDelete 的 tool_result 返回值格式？（成功/失败各返回什么？）
 * 3. CronDelete 执行期间 SDK 推送哪些状态更新事件？tool_progress 频率？
 * 4. CronDelete 与 CronCreate 的事件序列有何不同？
 * 5. 删除不存在的 job ID 时 tool_result 如何？
 * 6. 前端用 Vue3 + Element Plus 如何渲染 CronDelete 调用过程？
 *
 * 方法论：
 * - Case 1: 先创建再删除 — 完整两步事件时间线
 * - Case 2: 仅删除已知 ID — 观察纯删除事件
 * - Case 3: 删除不存在的 ID — 错误场景
 * - Case 4: 纯文本基线 — 无工具调用对比
 * - Case 5: 通过 NestJS SSE — 前端视角
 * - Case 6: 关闭 includePartialMessages — 对比
 *
 * 注意：
 * - CronDelete 不需要权限（permissionMode 不需要 bypassPermissions）
 * - CronDelete 不需要 canUseTool 回调（SDK 自动执行）
 * - CronDelete 是瞬时工具（内存操作）
 * - 需要先创建任务获取 ID 才能删除
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// ====== 公共配置 ======

const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'http://10.1.3.115:4000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-LLM-NO-THINK-V1',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

// ====== 事件收集工具 ======

interface CapturedSDKEvent {
  index: number;
  type: string;
  subtype?: string;
  timestamp: number;
  eventType?: string;
  deltaType?: string;
  toolName?: string;
  toolUseId?: string;
  inputJsonSnippet?: string;
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
        }
      }

      if (evt.type === 'content_block_delta' && evt.delta) {
        captured.deltaType = evt.delta.type;
        if (evt.delta.type === 'input_json_delta') {
          captured.inputJsonSnippet = evt.delta.partial_json;
        }
      }

      if (evt.type === 'content_block_stop') {
        currentToolName = null;
      }
    }

    // 处理 system 消息
    if (type === 'system') {
      captured.subtype = msg.subtype;
    }

    // 处理 assistant 消息 — 提取 tool_use blocks
    if (type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          captured.toolName = block.name;
          captured.toolUseId = block.id;
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

/** 提取 CronDelete 工具相关事件 */
function extractCronDeleteEvents(events: CapturedSDKEvent[]) {
  let inCronDeleteBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';

  for (const e of events) {
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === 'CronDelete') {
      inCronDeleteBlock = true;
    }
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inCronDeleteBlock) {
      inCronDeleteBlock = false;
    }
    if (inCronDeleteBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
      if (e.inputJsonSnippet) fullInputJson += e.inputJsonSnippet;
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName === 'CronDelete'),
    assistantCronCreate: events.filter(e => e.type === 'assistant' && e.toolName === 'CronCreate'),
    userToolResult: events.filter(e => e.type === 'user'),
    toolProgress: events.filter(e => e.type === 'tool_progress'),
    toolUseSummary: events.filter(e => e.type === 'tool_use_summary'),
    systemStatuses: events.filter(e => e.type === 'system' && e.subtype === 'status'),
    inputDeltaCount: inputJsonDeltas.length,
  };
}

/** SSE 事件收集（通过 NestJS HTTP） */
interface CapturedSSEEvent {
  index: number;
  serverWrap: string;
  sdkType: string;
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

describe('CronDelete 工具流式事件观察', () => {

  /**
   * Case 1: 先创建再删除 — 完整两步事件时间线
   *
   * 观察目标：
   * - CronCreate 和 CronDelete 的事件流差异
   * - CronDelete 的 input 只有 id 字段
   * - CronDelete 的 tool_result 格式（成功删除）
   * - 两个工具调用之间的事件序列
   * - 整个过程是否有 tool_progress
   */
  it('case-1 先创建再删除 — 完整两步事件时间线', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-1-create-then-delete');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the CronCreate tool to create a recurring job with cron expression "*/5 * * * *" and the prompt "Check the build status". After creating it, immediately use the CronDelete tool to cancel it using the job ID returned by CronCreate. Tell me the job ID and confirm it was deleted.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: 先创建再删除', events, duration);

    const deleteEvents = extractCronDeleteEvents(events);
    console.error('── CronDelete 相关事件 ──');
    console.error(`  input_json_delta 事件数: ${deleteEvents.inputDeltaCount}`);
    console.error(`  assistant CronCreate 数: ${deleteEvents.assistantCronCreate.length}`);
    console.error(`  assistant CronDelete 数: ${deleteEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${deleteEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${deleteEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${deleteEvents.toolUseSummary.length}`);
    console.error('');

    // 打印 CronDelete 完整 input JSON
    if (deleteEvents.fullInputJson) {
      console.error('── 完整 CronDelete input JSON ──');
      try {
        const parsed = JSON.parse(deleteEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
        console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
      } catch {
        console.error(`  (JSON 不完整: ${deleteEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 打印所有 assistant tool_use blocks 详情
    const allToolUses = events.filter(e => e.type === 'assistant' && e.toolName);
    if (allToolUses.length > 0) {
      console.error('\n── 所有 assistant tool_use 详情 ──');
      for (const e of allToolUses) {
        console.error(`  toolName: ${e.toolName}, toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // 打印 user 消息详情（tool_result）
    if (deleteEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of deleteEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (deleteEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of deleteEvents.toolProgress) {
        console.error(`  [${e.index}] tool_name=${e.raw?.tool_name}, elapsed=${e.raw?.elapsed_time_seconds}s`);
      }
    }

    // 保存完整事件日志
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    // 如果 LLM 成功调用了两个工具
    if (deleteEvents.assistantCronCreate.length > 0 && deleteEvents.assistantToolUse.length > 0) {
      expect(deleteEvents.inputDeltaCount).toBeGreaterThan(0);
      expect(deleteEvents.userToolResult.length).toBeGreaterThanOrEqual(2); // 至少 2 个 user 消息（CronCreate + CronDelete）
      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent).toBeDefined();
      if (resultEvent?.raw) {
        console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
        console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
      }
    } else {
      console.error('⚠️ LLM 未完整执行两步操作');
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: 仅删除 — 在同一会话中明确要求使用 CronDelete
   *
   * 观察目标：
   * - CronDelete 单独调用的事件流
   * - 与 Case 1 对比事件数量差异
   * - input_json_delta 的推送模式
   */
  it('case-2 仅删除任务 — 单工具调用事件流', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-2-delete-only');

    // 使用一个假的 job ID 来测试删除（LLM 可能会拒绝不存在的 ID）
    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the CronDelete tool to cancel the scheduled task with id "deadbeef". Just call the tool with that exact id.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: 仅删除任务', events, duration);

    const deleteEvents = extractCronDeleteEvents(events);

    // 打印 CronDelete input JSON
    if (deleteEvents.fullInputJson) {
      console.error('── 完整 CronDelete input JSON ──');
      try {
        const parsed = JSON.parse(deleteEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
      } catch {
        console.error(`  (JSON 不完整: ${deleteEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // assistant tool_use 详情
    if (deleteEvents.assistantToolUse.length > 0) {
      console.error('\n── CronDelete assistant tool_use 详情 ──');
      for (const e of deleteEvents.assistantToolUse) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // user 消息
    if (deleteEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of deleteEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 3: 删除不存在的 ID — 错误场景观察
   *
   * 观察目标：
   * - 删除不存在的 job ID 时 tool_result 的格式
   * - 是否有 is_error 字段
   * - 错误消息格式
   */
  it('case-3 删除不存在的 ID — 错误场景', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-3-delete-nonexistent');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the CronDelete tool to cancel the job with id "00000000" (this ID does not exist). Tell me what happened.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 3: 删除不存在的 ID', events, duration);

    const deleteEvents = extractCronDeleteEvents(events);

    // user 消息 — 重点观察 tool_result 是否有 is_error
    if (deleteEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result — 错误场景）──');
      for (const e of deleteEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 对比成功 vs 失败
    console.error('\n── 错误 vs 成功对比 ──');
    console.error(`  user 消息数: ${deleteEvents.userToolResult.length}`);
    console.error(`  tool_progress 数: ${deleteEvents.toolProgress.length}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 4: 纯文本基线 — 无工具调用对比
   */
  it('case-4 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-4-baseline');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Say exactly: "baseline test". Nothing else.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 4: 纯文本基线', events, duration);

    const hasToolUse = events.some(e => e.type === 'assistant' && e.toolName);
    const hasInputJsonDelta = events.some(e => e.deltaType === 'input_json_delta');
    const hasUser = events.some(e => e.type === 'user');
    const hasToolProgress = events.some(e => e.type === 'tool_progress');

    expect(hasToolUse).toBe(false);
    expect(hasInputJsonDelta).toBe(false);
    expect(hasUser).toBe(false);
    expect(hasToolProgress).toBe(false);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
  }, 120000);
});

// ====== NestJS SSE 测试 ======

describe('CronDelete 工具 SSE 深度事件分析', () => {
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
   * Case 5: CronDelete 通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构
   * - input_json_delta 拼接后的完整 JSON
   * - user 消息中 tool_result 的完整结构
   * - CronDelete 与 CronCreate 的 SSE 差异
   */
  it('case-5 CronDelete SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-5-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the CronCreate tool to create a recurring job with cron "*/10 * * * *" and prompt "Health check". Then immediately use the CronDelete tool to cancel it using the returned job ID. Tell me what happened.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: CronDelete SSE 数据格式 — 前端解析参考');
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
    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);
  }, 240000);

  /**
   * Case 6: 关闭 includePartialMessages — 对比
   */
  it('case-6 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-crondelete/case-6-no-partial');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Use the CronDelete tool to cancel the job with id "abc12345". Tell me what happened.',
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
    console.error('📊 Case 6: 关闭 includePartialMessages');
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

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));
  }, 240000);
});
