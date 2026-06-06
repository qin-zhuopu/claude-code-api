/**
 * Edit 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，Edit 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. Edit 工具的 tool_use 调用格式？input 有哪些字段？（file_path, old_string, new_string, replace_all）
 * 2. Edit 工具的 tool_result 返回值格式？structuredPatch 如何包装？
 * 3. Edit 工具执行期间 SDK 推送哪些状态更新事件？频率如何？
 * 4. tool_progress 的推送频率和内容？
 * 5. Edit 的 read-before-edit 机制是否影响事件序列？（需要先 Read 再 Edit）
 * 6. 与 Bash 等需要权限的工具相比，Edit 的事件序列有何不同？
 *
 * 方法论：
 * - Case 1: 简单编辑（先 Read 再 Edit）— 完整事件时间线
 * - Case 2: Edit 失败场景（old_string 不匹配）— 观察错误 tool_result
 * - Case 3: replace_all 模式 — 观察批量替换
 * - Case 4: 纯文本基线 — 无工具调用对比
 * - Case 5: 通过 NestJS SSE — 前端视角
 * - Case 6: 关闭 includePartialMessages 对比
 *
 * 注意：Edit 工具需要权限 + read-before-edit。通过 bypassPermissions 授权。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync, mkdirSync, writeFileSync as writeFile } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';

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
 * 创建测试用临时文件
 */
function createTestFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 直接调用 SDK 并收集所有事件（含 stream_event）
 */
async function collectSDKEvents(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  logDir?: string;
  bypassPermissions?: boolean;
  cwd?: string;
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

  if (options.cwd) {
    queryOptions.cwd = options.cwd;
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
                ? b.content.substring(0, 500)
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

/** 提取 Edit 和 Read 工具相关事件 */
function extractToolEvents(events: CapturedSDKEvent[], toolName: string = 'Edit') {
  let inBlock = false;
  let blockToolName: string | null = null;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';
  const toolBlocks: { name: string; deltas: CapturedSDKEvent[]; fullJson: string }[] = [];
  let currentDeltas: CapturedSDKEvent[] = [];
  let currentJson = '';

  for (const e of events) {
    // content_block_start 标记进入 tool block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName) {
      inBlock = true;
      blockToolName = e.toolName;
      currentDeltas = [];
      currentJson = '';
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inBlock) {
      if (blockToolName) {
        toolBlocks.push({
          name: blockToolName,
          deltas: currentDeltas,
          fullJson: currentJson,
        });
      }
      inBlock = false;
      blockToolName = null;
    }
    // input_json_delta 在 tool block 内
    if (inBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      currentDeltas.push(e);
      if (e.inputJsonSnippet) currentJson += e.inputJsonSnippet;
      if (blockToolName === toolName) {
        inputJsonDeltas.push(e);
        fullInputJson += e.inputJsonSnippet || '';
      }
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    // assistant tool_use blocks
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName),
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
    // 所有工具 blocks（含 Read、Edit）
    allToolBlocks: toolBlocks,
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
        permissionMode: 'bypassPermissions',
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

describe('Edit 工具流式事件观察', () => {

  /**
   * Case 1: 简单编辑（先 Read 再 Edit）— 完整事件时间线
   *
   * 观察目标：
   * - Edit 工具的 input_json_delta 如何流式构建 file_path/old_string/new_string 参数
   * - Edit 的 read-before-edit 要求是否导致先调用 Read 工具
   * - tool_result 的具体格式（filePath, structuredPatch, userModified 等）
   * - Edit 执行期间是否有 tool_progress 事件
   * - 与 Bash 工具的事件序列对比
   */
  it('case-1 Edit 简单编辑 — 完整事件时间线（先 Read 再 Edit）', async () => {
    const dir = createTimestampDir('stream-tool-edit/case-1-simple-edit');

    // 创建测试文件
    const testFile = createTestFile(dir, 'test-edit.txt', 'Hello World\nThis is a test file\nGoodbye World\n');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the file ${testFile.replace(/\\/g, '/')}, then use the Edit tool to replace "Hello World" with "Hello Claude". Tell me what you changed.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: Edit 简单编辑（先 Read 再 Edit）', events, duration);

    // 提取工具相关事件
    const toolEvents = extractToolEvents(events);
    console.error('── 工具相关事件 ──');
    console.error(`  所有 tool blocks: ${toolEvents.allToolBlocks.map(b => b.name).join(', ')}`);
    console.error(`  assistant tool_use 事件数: ${toolEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${toolEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${toolEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${toolEvents.toolUseSummary.length}`);
    console.error(`  system status 事件数: ${toolEvents.systemStatuses.length}`);
    console.error('');

    // 分析所有工具 blocks 的 input_json_delta
    console.error('── 各工具 block 的 input_json_delta ──');
    for (const block of toolEvents.allToolBlocks) {
      console.error(`  ${block.name}: ${block.deltas.length} 个 delta`);
      try {
        const parsed = JSON.parse(block.fullJson);
        console.error(`    字段: ${Object.keys(parsed).join(', ')}`);
        if (parsed.file_path) console.error(`    file_path: "${parsed.file_path}"`);
        if (parsed.old_string) console.error(`    old_string: "${parsed.old_string.substring(0, 80)}"`);
        if (parsed.new_string) console.error(`    new_string: "${parsed.new_string.substring(0, 80)}"`);
        if (parsed.replace_all !== undefined) console.error(`    replace_all: ${parsed.replace_all}`);
        if (parsed.command) console.error(`    command: "${parsed.command}"`);
      } catch {
        console.error(`    (JSON 不完整: ${block.fullJson.substring(0, 200)})`);
      }
    }
    console.error('');

    // 分析 Edit 工具的 input
    if (toolEvents.fullInputJson) {
      console.error('── Edit 工具完整 input JSON ──');
      try {
        const parsed = JSON.parse(toolEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
        console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
      } catch {
        console.error(`  (JSON 不完整: ${toolEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 分析 user 消息详情（tool_result）— 重点看 Edit 的结果
    if (toolEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of toolEvents.userToolResult) {
        console.error(`  [index=${e.index}] tool_use_result type: ${typeof e.raw?.tool_use_result}`);
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (toolEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of toolEvents.toolProgress) {
        console.error(`  [${e.index}] tool_name=${e.raw?.tool_name}, elapsed=${e.raw?.elapsed_time_seconds}s, tool_use_id=${e.raw?.tool_use_id}`);
      }
    }

    // 打印 result 详情
    const resultEvent = events.find(e => e.type === 'result');
    if (resultEvent?.raw) {
      console.error('\n── result 详情 ──');
      console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
      console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
      console.error(`  duration_ms: ${resultEvent.raw.duration_ms}`);
    }

    // 保存完整事件日志
    writeFileSync(
      `${dir}/sdk-events.json`,
      JSON.stringify(events, null, 2),
    );

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    // 检查是否有 Read + Edit 的工具调用
    const toolNames = toolEvents.allToolBlocks.map(b => b.name);
    console.error(`\n调用的工具: ${toolNames.join(', ')}`);

    // 如果 LLM 成功调用了 Edit
    const editAssistant = toolEvents.assistantToolUse.filter(e => e.toolName === 'Edit');
    if (editAssistant.length > 0) {
      // Edit 工具应该有 input_json_delta
      expect(toolEvents.inputDeltaCount).toBeGreaterThan(0);

      // Edit 工具应该有 user tool_result
      expect(toolEvents.userToolResult.length).toBeGreaterThan(0);

      // 验证 result 消息
      expect(resultEvent).toBeDefined();

      // 检查 Edit 的 tool_result 内容
      // Edit 的结果应该在某个 user 消息中
      const editUserMsg = toolEvents.userToolResult.find(e => {
        const result = e.raw?.tool_use_result;
        return result && typeof result === 'object' && result.structuredPatch;
      });

      if (editUserMsg) {
        console.error('\n── Edit tool_use_result 分析 ──');
        const editResult = editUserMsg.raw.tool_use_result;
        console.error(`  filePath: ${editResult.filePath}`);
        console.error(`  userModified: ${editResult.userModified}`);
        console.error(`  structuredPatch: ${JSON.stringify(editResult.structuredPatch, null, 2)}`);
        console.error(`  originalFile: ${editResult.originalFile ? `"${editResult.originalFile.substring(0, 200)}..."` : 'null'}`);

        // 断言 Edit 结果结构
        expect(editResult).toHaveProperty('filePath');
        expect(editResult).toHaveProperty('structuredPatch');
        expect(Array.isArray(editResult.structuredPatch)).toBe(true);
      }
    } else {
      console.error('⚠️ LLM 未调用 Edit（直接文本回答或用了其他方式）');
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: Edit 失败场景（old_string 不匹配）— 观察错误 tool_result
   *
   * 观察目标：
   * - 当 old_string 不匹配时，tool_result 的格式
   * - 错误信息是否在 tool_use_result 中还是 tool_result 的 is_error 中
   * - 失败是否增加 num_turns
   */
  it('case-2 Edit 失败场景 — old_string 不匹配', async () => {
    const dir = createTimestampDir('stream-tool-edit/case-2-edit-fail');

    // 创建测试文件
    const testFile = createTestFile(dir, 'test-edit-fail.txt', 'Hello World\nThis is a test file\n');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the file ${testFile.replace(/\\/g, '/')}, then use the Edit tool to replace "NONEXISTENT_STRING_XYZ" with "replaced". Explain what happened.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: Edit 失败场景（old_string 不匹配）', events, duration);

    const toolEvents = extractToolEvents(events);

    // 重点分析 Edit 失败的 tool_result
    console.error('── Edit 失败场景分析 ──');
    console.error(`  assistant tool_use 事件: ${toolEvents.assistantToolUse.map(e => e.toolName).join(', ')}`);
    console.error(`  user tool_result 事件数: ${toolEvents.userToolResult.length}`);

    for (const e of toolEvents.userToolResult) {
      console.error(`\n  user 消息 [index=${e.index}]:`);
      console.error(`    tool_use_result type: ${typeof e.raw?.tool_use_result}`);
      if (typeof e.raw?.tool_use_result === 'string') {
        console.error(`    tool_use_result (string): "${e.raw.tool_use_result.substring(0, 500)}"`);
      } else {
        console.error(`    tool_use_result: ${JSON.stringify(e.raw?.tool_use_result, null, 2)?.substring(0, 500)}`);
      }
      // 检查 is_error
      if (e.raw?.messageContentTypes) {
        for (const b of e.raw.messageContentTypes) {
          if (b.type === 'tool_result') {
            console.error(`    is_error: ${b.is_error}`);
          }
        }
      }
    }

    // 保存
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 3: 纯文本基线 — 无工具调用对比
   */
  it('case-3 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-edit/case-3-baseline');

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

describe('Edit 工具 SSE 深度事件分析', () => {
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
   * Case 5: Edit 工具通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构（id, name）
   * - input_json_delta 拼接后的完整 JSON（含 old_string/new_string 大文本）
   * - user 消息中 tool_result 的完整结构（structuredPatch 格式）
   * - tool_progress 在 SSE 中的表现
   */
  it('case-5 Edit SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-edit/case-5-sse-format');

    // 创建测试文件
    const testFile = createTestFile(dir, 'test-sse-edit.txt', 'Line 1: Hello\nLine 2: World\nLine 3: Test\n');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      `Read the file ${testFile.replace(/\\/g, '/')}, then use the Edit tool to replace "Line 2: World" with "Line 2: Claude". Tell me what you changed.`,
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: Edit SSE 数据格式 — 前端解析参考');
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

    // 跟踪工具的 block 上下文
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
          // 对于 Edit 工具，打印关键字段
          if (currentToolName === 'Edit' || currentToolName === 'edit') {
            console.error(`  old_string length: ${parsed.old_string?.length}`);
            console.error(`  new_string length: ${parsed.new_string?.length}`);
          }
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
            if (block.name === 'Edit' || block.name === 'edit') {
              console.error(`    input.file_path: ${block.input?.file_path}`);
              console.error(`    input.old_string: "${block.input?.old_string?.substring(0, 100)}"`);
              console.error(`    input.new_string: "${block.input?.new_string?.substring(0, 100)}"`);
              console.error(`    input.replace_all: ${block.input?.replace_all}`);
            } else {
              console.error(`    input: ${JSON.stringify(block.input, null, 2)?.substring(0, 500)}`);
            }
          }
          if (block.type === 'text') {
            console.error(`    text: "${block.text?.substring(0, 200)}"`);
          }
        }
      }
    }

    // 提取 user 消息（tool_result）— 重点分析 Edit 的结果
    const userEvents = events.filter(e => e.sdkType === 'user');
    console.error('\n── user 消息（tool_result）──');
    for (const e of userEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            console.error(`  tool_use_id: ${block.tool_use_id}`);
            console.error(`  is_error: ${block.is_error}`);
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
      // tool_use_result — Edit 的结构化输出
      if (e.inner?.tool_use_result !== undefined) {
        console.error(`  tool_use_result type: ${typeof e.inner.tool_use_result}`);
        if (typeof e.inner.tool_use_result === 'object' && e.inner.tool_use_result !== null) {
          const tr = e.inner.tool_use_result;
          console.error(`  tool_use_result keys: ${Object.keys(tr).join(', ')}`);
          console.error(`  tool_use_result.filePath: ${tr.filePath}`);
          console.error(`  tool_use_result.userModified: ${tr.userModified}`);
          if (tr.structuredPatch) {
            console.error(`  tool_use_result.structuredPatch: ${JSON.stringify(tr.structuredPatch, null, 2)}`);
          }
          if (tr.originalFile !== undefined) {
            console.error(`  tool_use_result.originalFile: ${tr.originalFile ? `"${String(tr.originalFile).substring(0, 200)}..."` : 'null'}`);
          }
        } else {
          console.error(`  tool_use_result (string): "${String(e.inner.tool_use_result).substring(0, 500)}"`);
        }
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
    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);
  }, 240000);

  /**
   * Case 6: 关闭 includePartialMessages — 对比
   */
  it('case-6 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-edit/case-6-no-partial');

    // 创建测试文件
    const testFile = createTestFile(dir, 'test-no-partial.txt', 'Hello World\n');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Read the file ${testFile.replace(/\\/g, '/')}, then use the Edit tool to replace "Hello World" with "Hello NoPartial". Tell me what you changed.`,
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

    // 仍然应该有 user（工具结果）
    console.error(`  has user message: ${sdkTypes.has('user')}`);

    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );
  }, 240000);
});
