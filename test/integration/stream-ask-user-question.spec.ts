/**
 * AskUserQuestion 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，AskUserQuestion 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. AskUserQuestion 的 input 如何通过 input_json_delta 流式构建？
 * 2. canUseTool 回调返回 answers 后，tool_result 的具体格式是什么？
 * 3. AskUserQuestion 调用期间 SDK 推送哪些状态更新事件？频率如何？
 * 4. 如果用 Vue3 + Element Plus 渲染，需要处理哪些事件类型？
 *
 * 方法论：
 * - Case 1-2: 直接 SDK 调用（可以挂 canUseTool 回调），收集完整事件时间线
 * - Case 3-4: 通过 NestJS SSE，观察前端实际收到的包装格式
 * - Case 5: 多问题 + 多选场景，观察复杂 input 结构
 *
 * 注意：本地 LLM 不一定遵循指令调用 AskUserQuestion，
 * 因此对 LLM 行为使用宽松断言，重点断言事件结构。
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
 * 支持 canUseTool 回调
 */
async function collectSDKEvents(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  logDir?: string;
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

  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env || BASE_ENV,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
      ...(options.logDir ? { env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` } } : {}),
    } as any,
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
                ? b.content.substring(0, 200)
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => c.type === 'text' ? c.text?.substring(0, 200) : c.type)
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

    // 处理 result 消息
    if (type === 'result') {
      resultText = msg.result || '';
      captured.raw = {
        subtype: msg.subtype,
        num_turns: msg.num_turns,
        duration_ms: msg.duration_ms,
        stop_reason: msg.stop_reason,
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
      if (e.inputJsonSnippet) detail += ` "${e.inputJsonSnippet.substring(0, 50)}"`;
    } else if (e.type === 'system') {
      detail = e.subtype || '';
    } else if (e.type === 'assistant') {
      if (e.toolName) detail = `[tool_use: ${e.toolName}]`;
    } else if (e.type === 'user') {
      detail = 'tool_result';
    } else if (e.type === 'tool_progress') {
      detail = `${e.toolName} (${e.raw?.elapsed_time_seconds}s)`;
    }

    console.error(`  [${String(e.index).padStart(3)}] ${e.type} ${detail}`);
  }
  console.error('');
}

/** 提取 AskUserQuestion 相关事件（需要跟踪 block 上下文） */
function extractAskUserQuestionEvents(events: CapturedSDKEvent[]) {
  let inAskBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];

  for (const e of events) {
    // content_block_start 标记进入 AskUserQuestion block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === 'AskUserQuestion') {
      inAskBlock = true;
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inAskBlock) {
      inAskBlock = false;
    }
    // input_json_delta 在 AskUserQuestion block 内
    if (inAskBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
    }
  }

  return {
    inputJsonDeltas,
    // assistant tool_use block
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName === 'AskUserQuestion'),
    // user tool_result 消息
    userToolResult: events.filter(e => e.type === 'user'),
    // tool_progress 消息
    toolProgress: events.filter(e => e.type === 'tool_progress'),
    // system status 消息
    systemStatuses: events.filter(e => e.type === 'system' && e.subtype === 'status'),
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

describe('AskUserQuestion 流式事件观察', () => {

  /**
   * Case 1: 触发 AskUserQuestion + canUseTool 单选回答 — 直接 SDK 调用
   *
   * 观察目标：
   * - input_json_delta 如何流式构建 questions 参数
   * - canUseTool 回调的触发时机（在 content_block_stop 之后？）
   * - tool_result 的具体格式
   * - AskUserQuestion 期间是否有 tool_progress 事件
   */
  it('case-1 AskUserQuestion 单选 — 完整事件时间线', async () => {
    const dir = createTimestampDir('stream-ask-user-question/case-1-single-select');

    // 记录 canUseTool 调用
    const canUseToolCalls: Array<{
      toolName: string;
      input: any;
      timestamp: number;
      eventIndexBefore: number; // 在回调触发前的最后一个事件 index
    }> = [];
    let lastEventIndex = -1;

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the AskUserQuestion tool to ask me which testing framework I prefer: Jest, Vitest, or Mocha. Then tell me my choice.',
      logDir: dir,
      canUseTool: async (toolName, input) => {
        canUseToolCalls.push({
          toolName,
          input: JSON.parse(JSON.stringify(input)),
          timestamp: Date.now(),
          eventIndexBefore: lastEventIndex,
        });
        console.error(`\n[canUseTool] toolName=${toolName}, input keys=${Object.keys(input).join(',')}`);

        if (toolName === 'AskUserQuestion') {
          const questions = (input as any).questions || [];
          const answers: Record<string, string> = {};
          for (const q of questions) {
            if (q.options && q.options.length > 0) {
              answers[q.question] = q.options[0].label;
            }
          }
          console.error(`[canUseTool] answers:`, JSON.stringify(answers));
          return { behavior: 'allow', updatedInput: { questions, answers } };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    });

    // 重写 lastEventIndex 跟踪
    // 注意：上面的闭包捕获有 timing 问题，我们直接用 events 分析

    printTimeline('Case 1: AskUserQuestion 单选', events, duration);

    // 提取 AskUserQuestion 相关事件
    const askEvents = extractAskUserQuestionEvents(events);
    console.error('── AskUserQuestion 相关事件 ──');
    console.error(`  input_json_delta 事件数: ${askEvents.inputJsonDeltas.length}`);
    console.error(`  assistant tool_use 事件数: ${askEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${askEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${askEvents.toolProgress.length}`);
    console.error(`  system status 事件数: ${askEvents.systemStatuses.length}`);
    console.error('');

    // 打印 canUseTool 调用信息
    console.error('── canUseTool 回调 ──');
    console.error(`  调用次数: ${canUseToolCalls.length}`);
    for (const call of canUseToolCalls) {
      console.error(`  toolName: ${call.toolName}`);
      console.error(`  input: ${JSON.stringify(call.input, null, 2)}`);
    }
    console.error('');

    // 打印 user 消息详情（tool_result）
    if (askEvents.userToolResult.length > 0) {
      console.error('── user 消息详情 ──');
      for (const e of askEvents.userToolResult) {
        console.error(`  [${e.index}]`, JSON.stringify(e.raw, null, 2));
      }
      console.error('');
    }

    // 保存完整事件日志
    writeFileSync(
      `${dir}/sdk-events.json`,
      JSON.stringify(events, null, 2),
    );

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    // 如果 LLM 成功调用了 AskUserQuestion
    if (askEvents.assistantToolUse.length > 0) {
      // 应该有 input_json_delta
      expect(askEvents.inputJsonDeltas.length).toBeGreaterThan(0);

      // 应该有 user tool_result（SDK 自动注入 answers 后回传）
      expect(askEvents.userToolResult.length).toBeGreaterThan(0);

      // 检查 user 消息中的 tool_result 内容
      const firstUser = askEvents.userToolResult[0];
      if (firstUser.raw?.messageContentTypes) {
        const toolResultBlocks = firstUser.raw.messageContentTypes.filter(
          (b: any) => b.type === 'tool_result'
        );
        console.error(`  tool_result blocks: ${toolResultBlocks.length}`);
        if (toolResultBlocks.length > 0) {
          const trb = toolResultBlocks[0];
          console.error(`  tool_result content type: ${trb.contentType}`);
          if (trb.contentSnippet) {
            console.error(`  tool_result content snippet: ${JSON.stringify(trb.contentSnippet)}`);
          }
        }
      }

      // 验证有 result 消息
      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent).toBeDefined();
      if (resultEvent?.raw) {
        console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
        console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
      }
    } else {
      console.error('⚠️ LLM 未调用 AskUserQuestion（直接文本回答）');
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: AskUserQuestion 多选 + 多问题 — 观察 input 结构
   *
   * 观察目标：
   * - 多问题场景下 input_json_delta 的拼接过程
   * - questions 数组中每个问题的完整结构
   * - multiSelect=true 时 tool_result 的格式
   */
  it('case-2 AskUserQuestion 多选多问题 — input 结构', async () => {
    const dir = createTimestampDir('stream-ask-user-question/case-2-multi-select');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the AskUserQuestion tool to ask me two questions: 1) Which testing framework? (Jest or Vitest) 2) Which features to enable? (TypeScript, ESLint, Prettier, Husky). Set multiSelect to true for the second question. Then summarize my choices.',
      logDir: dir,
      canUseTool: async (toolName, input) => {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as any).questions || [];
          const answers: Record<string, string> = {};
          for (const q of questions) {
            if (q.options && q.options.length >= 2) {
              if (q.multiSelect) {
                // 多选：用 ", " 连接前两个选项
                answers[q.question] = `${q.options[0].label}, ${q.options[1].label}`;
              } else {
                answers[q.question] = q.options[0].label;
              }
            }
          }
          console.error(`\n[canUseTool] answers:`, JSON.stringify(answers));
          return { behavior: 'allow', updatedInput: { questions, answers } };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    });

    printTimeline('Case 2: AskUserQuestion 多选多问题', events, duration);

    // 拼接完整的 input JSON
    const inputDeltas = events.filter(
      e => e.type === 'stream_event' && e.deltaType === 'input_json_delta' && e.inputJsonSnippet
    );
    const fullInputJson = inputDeltas.map(e => e.inputJsonSnippet).join('');
    console.error('── 完整 input JSON ──');
    try {
      const parsed = JSON.parse(fullInputJson);
      console.error(JSON.stringify(parsed, null, 2));

      // 断言 questions 结构
      if (parsed.questions && Array.isArray(parsed.questions)) {
        console.error(`\n  问题数: ${parsed.questions.length}`);
        for (let i = 0; i < parsed.questions.length; i++) {
          const q = parsed.questions[i];
          console.error(`  Q${i + 1}: ${q.question}`);
          console.error(`    header: ${q.header}`);
          console.error(`    multiSelect: ${q.multiSelect}`);
          console.error(`    options: ${q.options?.map((o: any) => o.label).join(', ')}`);
        }
      }
    } catch {
      console.error(`  (JSON 不完整: ${fullInputJson.substring(0, 200)})`);
    }

    // user 消息中的 tool_result
    const userEvents = events.filter(e => e.type === 'user');
    if (userEvents.length > 0) {
      console.error('\n── user 消息详情 ──');
      for (const e of userEvents) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 保存
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 3: AskUserQuestion 通过 NestJS SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式（type: partial/text）
   * - AskUserQuestion 工具在 SSE 中如何表现
   * - 前端能否识别 AskUserQuestion 的 input_json_delta
   *
   * 注意：NestJS SSE 不支持 canUseTool 回调，
   * 所以 AskUserQuestion 会触发 SDK 的默认行为（等待用户输入 → 超时或跳过）。
   * 但可以观察到 input_json_delta 的流式构建过程。
   */
  it('case-3 AskUserQuestion 通过 SSE — 前端视角', async () => {
    // 启动 NestJS 应用
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    app.enableCors();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    const baseUrl = await app.getUrl();

    try {
      const { events, duration } = await collectSSEEvents(
        baseUrl,
        'Use the AskUserQuestion tool to ask me which language I prefer: TypeScript or JavaScript. Then tell me my choice.',
      );

      console.error(`\n${'='.repeat(70)}`);
      console.error('📊 Case 3: AskUserQuestion 通过 SSE（前端视角）');
      console.error(`${'='.repeat(70)}`);
      console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);
      console.error('');

      // SSE 包装类型统计
      const wrapTypes = new Map<string, number>();
      const sdkTypes = new Map<string, number>();
      for (const e of events) {
        wrapTypes.set(e.serverWrap, (wrapTypes.get(e.serverWrap) || 0) + 1);
        sdkTypes.set(e.sdkType, (sdkTypes.get(e.sdkType) || 0) + 1);
      }

      console.error('── SSE 包装类型 ──');
      for (const [type, count] of wrapTypes) {
        console.error(`  ${type}: ${count}`);
      }
      console.error('');
      console.error('── SDK 消息类型 ──');
      for (const [type, count] of sdkTypes) {
        console.error(`  ${type}: ${count}`);
      }
      console.error('');

      // 找 AskUserQuestion 相关的 stream_event
      const askStreamEvents = events.filter(e => {
        if (e.sdkType !== 'stream_event') return false;
        const evt = e.inner?.event;
        if (!evt) return false;
        // content_block_start 中 name === 'AskUserQuestion'
        if (evt.type === 'content_block_start' && evt.content_block?.name === 'AskUserQuestion') return true;
        // input_json_delta（属于 AskUserQuestion block）
        // 注意：delta 本身不包含 tool name，需要跟踪 block 上下文
        return false;
      });

      console.error(`── AskUserQuestion 相关事件 ──`);
      console.error(`  明确匹配事件数: ${askStreamEvents.length}`);

      // 打印完整时间线
      console.error('\n── SSE 事件时间线 ──');
      for (const e of events) {
        let detail = `${e.sdkType}`;
        if (e.sdkSubtype) detail += ` [${e.sdkSubtype}]`;
        if (e.sdkType === 'stream_event') {
          const evt = e.inner?.event;
          if (evt?.type) detail += ` → ${evt.type}`;
          if (evt?.delta?.type) detail += ` [${evt.delta.type}]`;
          if (evt?.content_block?.name) detail += ` (${evt.content_block.name})`;
          if (evt?.delta?.partial_json) detail += ` "${evt.delta.partial_json.substring(0, 50)}"`;
        }
        console.error(`  [${String(e.index).padStart(3)}] ${e.serverWrap}: ${detail}`);
      }

      // 保存
      const dir = createTimestampDir('stream-ask-user-question/case-3-sse');
      writeFileSync(
        `${dir}/sse-events.json`,
        JSON.stringify(events.map(e => ({ i: e.index, wrap: e.serverWrap, sdkType: e.sdkType, raw: e.raw })), null, 2),
      );

      // 基本断言
      expect(events.length).toBeGreaterThan(0);
      expect(sdkTypes.has('system')).toBe(true);
      expect(sdkTypes.has('result')).toBe(true);

    } finally {
      await app.close();
    }
  }, 240000);

  /**
   * Case 4: 纯文本基线 — 无工具调用的流式事件对比
   *
   * 对比基准：不触发 AskUserQuestion 时的事件序列，
   * 用于和 case-1/2 对比，凸显 AskUserQuestion 的增量事件。
   */
  it('case-4 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-ask-user-question/case-4-baseline');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Say exactly: "baseline test". Nothing else.',
      logDir: dir,
    });

    printTimeline('Case 4: 纯文本基线', events, duration);

    // 对比分析
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

    // 但应有 text_delta
    const hasTextDelta = events.some(e => e.deltaType === 'text_delta');
    console.error(`  has text_delta: ${hasTextDelta}`);
    expect(hasTextDelta).toBe(true);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
  }, 120000);
});

// ====== NestJS 应用级测试（case-3 使用独立 describe）======

describe('AskUserQuestion SSE 深度事件分析', () => {
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
   * Case 5: AskUserQuestion 的 SSE 数据格式 — 前端解析视角
   *
   * 观察目标：
   * - content_block_start(tool_use) 的完整结构
   * - input_json_delta 拼接后的完整 JSON
   * - content_block_stop 后的事件序列
   * - 是否有 system status 更新
   */
  it('case-5 SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-ask-user-question/case-5-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the AskUserQuestion tool to ask me which testing framework to use: Jest, Vitest, or Mocha. Then tell me my choice.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: SSE 数据格式 — 前端解析参考');
    console.error(`${'='.repeat(70)}`);
    console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);

    // 提取所有 stream_event
    const streamEvents = events.filter(e => e.sdkType === 'stream_event');
    console.error(`\nstream_event 总数: ${streamEvents.length}`);

    // 按内部 event.type 分组
    const innerTypes = new Map<string, number>();
    let currentBlockType: string | null = null;
    let currentToolName: string | null = null;
    let inputJsonBuffer = '';

    for (const e of streamEvents) {
      const evt = e.inner?.event;
      if (!evt) continue;

      innerTypes.set(evt.type, (innerTypes.get(evt.type) || 0) + 1);

      if (evt.type === 'content_block_start') {
        currentBlockType = evt.content_block?.type || null;
        currentToolName = evt.content_block?.name || null;
        if (currentBlockType === 'tool_use') {
          inputJsonBuffer = '';
          console.error(`\n── content_block_start: tool_use ──`);
          console.error(`  name: ${currentToolName}`);
          console.error(`  id: ${evt.content_block?.id}`);
        }
      }

      if (evt.type === 'content_block_delta' && currentBlockType === 'tool_use') {
        if (evt.delta?.type === 'input_json_delta') {
          inputJsonBuffer += evt.delta.partial_json || '';
        }
      }

      if (evt.type === 'content_block_stop' && currentBlockType === 'tool_use') {
        console.error(`\n── content_block_stop: tool_use (${currentToolName}) ──`);
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
        console.error(`  blocks: ${blocks.length}, types: [${blocks.map((b: any) => b.type).join(', ')}]`);
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            console.error(`    tool_use: name=${block.name}, id=${block.id}`);
            console.error(`    input: ${JSON.stringify(block.input, null, 2)}`);
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
              console.error(`  content: "${block.content}"`);
            } else if (Array.isArray(block.content)) {
              for (const c of block.content) {
                if (c.type === 'text') {
                  console.error(`  content.text: "${c.text}"`);
                }
              }
            }
          }
        }
      }
    }

    // 保存
    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );

    expect(events.length).toBeGreaterThan(0);
  }, 240000);
});
