/**
 * ReadMcpResourceTool 流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，ReadMcpResourceTool 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. ReadMcpResourceTool 的 tool_use input 格式？（server + uri 必需参数？）
 * 2. ReadMcpResourceTool 的 tool_result 返回值格式？（contents 数组？）
 * 3. 执行期间 SDK 推送哪些状态更新事件？tool_progress 频率？
 * 4. ReadMcpResourceTool 是瞬时工具还是有执行时间？
 * 5. input_json_delta 推送模式？（几次？拼接后完整 JSON？）
 * 6. 读取不存在的 URI 时的返回值？错误字符串？
 * 7. 前端用 Vue3 + Element Plus 如何渲染？
 *
 * SDK 类型定义：
 * - Input:  { server: string; uri: string }
 * - Output: { contents: Array<{uri, mimeType?, text?, blobSavedTo?}> }
 * - 权限:   No permission required
 *
 * 方法论：
 * - Case 1: 读取文本资源 (test://resource/hello) — 基础场景
 * - Case 2: 读取 JSON 资源 (test://resource/config) — JSON 内容场景
 * - Case 3: 读取 Markdown 资源 (test://resource/readme) — Markdown 内容场景
 * - Case 4: 读取不存在的 URI — 错误场景
 * - Case 5: ReadMcpResourceTool 通过 SSE — 前端视角
 * - Case 6: 关闭 includePartialMessages — 对比
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
// MCP 服务器配置 — 提供 3 个测试资源
const MCP_SERVER_CONFIG = {
  'test-mcp-server': {
    type: 'stdio' as const,
    command: 'node',
    args: [require('path').resolve(__dirname, 'fixtures/mcp-server/server.mjs')],
    alwaysLoad: true, // 确保 ReadMcpResourceTool 在启动时可用
  },
};

async function collectSDKEvents(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  logDir?: string;
  bypassPermissions?: boolean;
  mcpServers?: boolean;
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

  // 如果需要 MCP 服务器，添加 mcpServers 配置
  if (options.mcpServers !== false) {
    queryOptions.mcpServers = MCP_SERVER_CONFIG;
  }

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
          inputJsonBuffer = '';
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

    // 处理 assistant 消息
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

    // 处理 user 消息
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
                ? b.content.substring(0, 2000)
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => c.type === 'text' ? c.text?.substring(0, 1000) : c.type)
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
      if (e.inputJsonSnippet !== undefined) detail += ` "${e.inputJsonSnippet.substring(0, 80)}"`;
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

/** 提取 ReadMcpResource 工具相关事件 */
function extractReadMcpResourceEvents(events: CapturedSDKEvent[]) {
  let inToolBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';

  for (const e of events) {
    // content_block_start 标记进入 tool block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === 'ReadMcpResourceTool') {
      inToolBlock = true;
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inToolBlock) {
      inToolBlock = false;
    }
    // input_json_delta 在 tool block 内
    if (inToolBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
      if (e.inputJsonSnippet !== undefined) fullInputJson += e.inputJsonSnippet;
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName === 'ReadMcpResourceTool'),
    userToolResult: events.filter(e => e.type === 'user'),
    toolProgress: events.filter(e => e.type === 'tool_progress'),
    toolUseSummary: events.filter(e => e.type === 'tool_use_summary'),
    systemStatuses: events.filter(e => e.type === 'system' && e.subtype === 'status'),
    inputDeltaCount: inputJsonDeltas.length,
    allToolNames: events.filter(e => e.toolName).map(e => e.toolName),
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
        mcpServers: MCP_SERVER_CONFIG,
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

/** 打印 SSE 分析报告 — ReadMcpResourceTool 专用 */
function printSSEAnalysisForReadMcpResource(label: string, events: CapturedSSEEvent[], duration: number) {
  console.error(`\n${'='.repeat(70)}`);
  console.error(`📊 ${label}`);
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
        console.error(`  input_schema: ${JSON.stringify(evt.content_block?.input_schema)?.substring(0, 500)}`);
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
      console.error(`  完整 input JSON: "${inputJsonBuffer}"`);
      try {
        const parsed = JSON.parse(inputJsonBuffer);
        console.error(`  parsed: ${JSON.stringify(parsed, null, 2)}`);
      } catch {
        console.error(`  (JSON 不完整或为空)`);
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
          console.error(`    input: ${JSON.stringify(block.input)}`);
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
            console.error(`  content (string): "${block.content.substring(0, 2000)}"`);
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text') {
                console.error(`  content[0].text: "${c.text?.substring(0, 2000)}"`);
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
      console.error(`  tool_use_result: ${JSON.stringify(e.inner.tool_use_result, null, 2)?.substring(0, 2000)}`);
    }
  }

  // 提取 tool_progress
  const toolProgressEvents = events.filter(e => e.sdkType === 'tool_progress');
  console.error('\n── tool_progress 消息 ──');
  console.error(`  事件数: ${toolProgressEvents.length}`);

  // 提取 result
  const resultEvents = events.filter(e => e.sdkType === 'result');
  if (resultEvents.length > 0) {
    console.error('\n── result 消息 ──');
    const r = resultEvents[0].inner;
    console.error(`  subtype: ${r.subtype}`);
    console.error(`  num_turns: ${r.num_turns}`);
    console.error(`  duration_ms: ${r.duration_ms}`);
  }
}

// ====== SDK 直连测试用例 ======

describe('ReadMcpResourceTool 流式事件观察', () => {

  /**
   * Case 1: 读取文本资源 (test://resource/hello) — 基础场景
   *
   * 观察目标：
   * - ReadMcpResourceTool 的 input_json_delta 推送（几次？server + uri 参数？）
   * - ReadMcpResourceTool 的 tool_result 格式（contents 数组？）
   * - 执行期间是否有 tool_progress 事件
   * - 是瞬时工具吗？
   */
  it('case-1 ReadMcpResourceTool 读取文本资源 — 基础场景', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-1-text-resource');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'IMPORTANT: You must call the tool named ReadMcpResourceTool (do NOT use Grep, Read, Glob, or any other tool). Call it with server="test-mcp-server" and uri="test://resource/hello" and tell me the result.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: ReadMcpResourceTool 读取文本资源', events, duration);

    const toolEvents = extractReadMcpResourceEvents(events);
    console.error('── ReadMcpResource 相关事件 ──');
    console.error(`  所有工具名称: ${toolEvents.allToolNames.join(', ')}`);
    console.error(`  ReadMcpResource input_json_delta 事件数: ${toolEvents.inputDeltaCount}`);
    console.error(`  ReadMcpResource assistant tool_use 事件数: ${toolEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${toolEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${toolEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${toolEvents.toolUseSummary.length}`);
    console.error(`  system status 事件数: ${toolEvents.systemStatuses.length}`);
    console.error('');

    // 打印完整 input JSON
    console.error('── ReadMcpResource 完整 input JSON ──');
    console.error(`  raw: "${toolEvents.fullInputJson}"`);
    console.error(`  length: ${toolEvents.fullInputJson.length}`);
    if (toolEvents.fullInputJson) {
      try {
        const parsed = JSON.parse(toolEvents.fullInputJson);
        console.error(`  parsed: ${JSON.stringify(parsed)}`);
        console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
      } catch {
        console.error(`  (JSON 不完整: ${toolEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 打印 input_json_delta 详情
    if (toolEvents.inputJsonDeltas.length > 0) {
      console.error('\n── ReadMcpResource input_json_delta 推送序列 ──');
      for (let i = 0; i < toolEvents.inputJsonDeltas.length; i++) {
        const d = toolEvents.inputJsonDeltas[i];
        console.error(`  [${i+1}] "${d.inputJsonSnippet}"`);
      }
    }

    // 打印 assistant tool_use blocks 详情
    if (toolEvents.assistantToolUse.length > 0) {
      console.error('\n── ReadMcpResource assistant tool_use 详情 ──');
      for (const e of toolEvents.assistantToolUse) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput !== undefined) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // 打印 user 消息详情（tool_result）
    if (toolEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of toolEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (toolEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of toolEvents.toolProgress) {
        console.error(`  [${e.index}] tool_name=${e.raw?.tool_name}, elapsed=${e.raw?.elapsed_time_seconds}s`);
      }
    }

    // 保存完整事件日志
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    const resultEvent = events.find(e => e.type === 'result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.raw) {
      console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
      console.error(`  duration_ms: ${resultEvent.raw.duration_ms}`);
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: 读取 JSON 资源 (test://resource/config) — JSON 内容场景
   */
  it('case-2 ReadMcpResourceTool 读取 JSON 资源 — JSON 内容场景', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-2-json-resource');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'IMPORTANT: You must call the tool named ReadMcpResourceTool with server="test-mcp-server" and uri="test://resource/config" (do NOT use any other tool like Grep, Read, or Glob). Just call it and tell me the result.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: ReadMcpResourceTool 读取 JSON 资源', events, duration);

    const toolEvents = extractReadMcpResourceEvents(events);

    console.error('── ReadMcpResource input JSON（JSON 资源）──');
    console.error(`  raw: "${toolEvents.fullInputJson}"`);

    if (toolEvents.inputJsonDeltas.length > 0) {
      console.error('\n── input_json_delta 推送序列 ──');
      for (let i = 0; i < toolEvents.inputJsonDeltas.length; i++) {
        const d = toolEvents.inputJsonDeltas[i];
        console.error(`  [${i+1}] "${d.inputJsonSnippet}"`);
      }
    }

    if (toolEvents.assistantToolUse.length > 0) {
      console.error('\n── assistant tool_use 详情 ──');
      for (const e of toolEvents.assistantToolUse) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput !== undefined) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    if (toolEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of toolEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    console.error('\n── 对比分析 ──');
    console.error(`  input_json_delta 数: ${toolEvents.inputDeltaCount}`);
    console.error(`  user 消息数: ${toolEvents.userToolResult.length}`);
    console.error(`  tool_progress 数: ${toolEvents.toolProgress.length}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 3: 读取 Markdown 资源 (test://resource/readme) — Markdown 内容场景
   */
  it('case-3 ReadMcpResourceTool 读取 Markdown 资源 — Markdown 内容场景', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-3-markdown-resource');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'IMPORTANT: You must call the tool named ReadMcpResourceTool with server="test-mcp-server" and uri="test://resource/readme" (do NOT use any other tool like Grep, Read, or Glob). Just call it and tell me the result.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 3: ReadMcpResourceTool 读取 Markdown 资源', events, duration);

    const toolEvents = extractReadMcpResourceEvents(events);

    console.error('── ReadMcpResource input JSON（Markdown 资源）──');
    console.error(`  raw: "${toolEvents.fullInputJson}"`);

    if (toolEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of toolEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    console.error('\n── 统计 ──');
    console.error(`  input_json_delta 数: ${toolEvents.inputDeltaCount}`);
    console.error(`  user 消息数: ${toolEvents.userToolResult.length}`);
    console.error(`  tool_progress 数: ${toolEvents.toolProgress.length}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 4: 读取不存在的 URI — 错误场景
   */
  it('case-4 ReadMcpResourceTool 读取不存在的 URI — 错误场景', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-4-not-found');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'IMPORTANT: You must call the tool named ReadMcpResourceTool with server="test-mcp-server" and uri="test://resource/nonexistent" (do NOT use any other tool like Grep, Read, or Glob). Just call it and tell me the result.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 4: ReadMcpResourceTool 读取不存在的 URI', events, duration);

    const toolEvents = extractReadMcpResourceEvents(events);

    if (toolEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（错误 tool_result）──');
      for (const e of toolEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    console.error('\n── 统计 ──');
    console.error(`  input_json_delta 数: ${toolEvents.inputDeltaCount}`);
    console.error(`  user 消息数: ${toolEvents.userToolResult.length}`);
    console.error(`  tool_progress 数: ${toolEvents.toolProgress.length}`);
    console.error(`  所有工具名称: ${toolEvents.allToolNames.join(', ')}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);
});

// ====== NestJS SSE 测试 ======

describe('ReadMcpResourceTool SSE 深度事件分析', () => {
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
   * Case 5: ReadMcpResourceTool 通过 SSE — 前端视角
   */
  it('case-5 ReadMcpResourceTool SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-5-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'IMPORTANT: You must call the tool named ReadMcpResourceTool with server="test-mcp-server" and uri="test://resource/hello" (do NOT use any other tool like Grep, Read, or Glob). Just call it and tell me the result.',
      { permissionMode: 'bypassPermissions' },
    );

    printSSEAnalysisForReadMcpResource('Case 5: ReadMcpResourceTool SSE 数据格式', events, duration);

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));

    const sdkTypes = new Map<string, number>();
    for (const e of events) {
      sdkTypes.set(e.sdkType, (sdkTypes.get(e.sdkType) || 0) + 1);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);
  }, 240000);

  /**
   * Case 6: 关闭 includePartialMessages — 对比
   */
  it('case-6 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-readmcpresource/case-6-no-partial');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'IMPORTANT: You must call the tool named ReadMcpResourceTool with server="test-mcp-server" and uri="test://resource/hello" (do NOT use any other tool like Grep, Read, or Glob). Just call it and tell me the result.',
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

    // 打印 assistant 消息中的 tool_use block
    const assistantEvents = events.filter(e => e.sdkType === 'assistant');
    console.error('\n── assistant 消息（无 partial）──');
    for (const e of assistantEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            console.error(`  tool_use: name=${block.name}, input=${JSON.stringify(block.input)}`);
          }
        }
      }
    }

    // 打印 user 消息
    const userEvents = events.filter(e => e.sdkType === 'user');
    console.error('\n── user 消息（无 partial）──');
    for (const e of userEvents) {
      if (e.inner?.tool_use_result !== undefined) {
        console.error(`  tool_use_result: ${JSON.stringify(e.inner.tool_use_result, null, 2)?.substring(0, 2000)}`);
      }
    }

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));
  }, 240000);
});
