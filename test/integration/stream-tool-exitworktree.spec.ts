/**
 * ExitWorktree 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，ExitWorktree 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. ExitWorktree 的 tool_use input 格式？（action: "keep"|"remove", discard_changes?）
 * 2. ExitWorktree 的 tool_result 返回值格式？（action, originalCwd, worktreePath, worktreeBranch?, tmuxSessionName?, discardedFiles?, discardedCommits?, message）
 * 3. ExitWorktree 执行期间 SDK 推送哪些状态更新事件？tool_progress 频率？
 * 4. ExitWorktree 失败时（不在 worktree 中、有未提交更改等）的 tool_result 格式？
 * 5. ExitWorktree 的 input_json_delta 推送模式？
 * 6. 前端用 Vue3 + Element Plus 如何渲染 ExitWorktree 调用过程？
 *
 * 方法论：
 * - Case 1: 先 EnterWorktree 再 ExitWorktree(action=keep) — 成功场景（两步工作流）
 * - Case 2: 先 EnterWorktree 再 ExitWorktree(action=remove) — 成功删除场景
 * - Case 3: 不在 worktree 中直接调用 ExitWorktree — 失败场景
 * - Case 4: 纯文本基线 — 无工具调用对比
 * - Case 5: 通过 NestJS SSE — 前端视角
 * - Case 6: 关闭 includePartialMessages — 对比
 *
 * 注意：
 * - ExitWorktree 不需要权限
 * - ExitWorktree 只在已处于 worktree 中的会话里有效
 * - ExitWorktreeInput 有 action("keep"|"remove") 和可选的 discard_changes(boolean)
 * - 测试需要通过 prompt 引导 LLM 先创建 worktree 再退出
 * - action="keep" 保留 worktree 和分支；action="remove" 删除二者
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
  cwd?: string;
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

  if (options.cwd) {
    queryOptions.cwd = options.cwd;
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

/** 提取 ExitWorktree 工具相关事件 */
function extractExitWorktreeEvents(events: CapturedSDKEvent[]) {
  // 跟踪所有 tool_use blocks（包括 EnterWorktree 和 ExitWorktree）
  let inExitWorktreeBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';

  // 跟踪 EnterWorktree 的事件（两步工作流）
  const enterWorktreeBlocks: CapturedSDKEvent[] = [];
  const exitWorktreeBlocks: CapturedSDKEvent[] = [];

  let currentBlockToolName: string | null = null;

  for (const e of events) {
    // content_block_start 标记进入 tool_use block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName) {
      currentBlockToolName = e.toolName;
      if (e.toolName === 'ExitWorktree') {
        inExitWorktreeBlock = true;
      }
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop') {
      if (currentBlockToolName === 'ExitWorktree') {
        inExitWorktreeBlock = false;
      }
      currentBlockToolName = null;
    }
    // input_json_delta 在 ExitWorktree block 内
    if (inExitWorktreeBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
      if (e.inputJsonSnippet !== undefined) fullInputJson += e.inputJsonSnippet;
    }

    // assistant tool_use blocks
    if (e.type === 'assistant' && e.toolName === 'EnterWorktree') {
      enterWorktreeBlocks.push(e);
    }
    if (e.type === 'assistant' && e.toolName === 'ExitWorktree') {
      exitWorktreeBlocks.push(e);
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    // assistant tool_use blocks
    enterWorktreeBlocks,
    exitWorktreeBlocks,
    // user tool_result 消息
    userToolResults: events.filter(e => e.type === 'user'),
    // tool_progress 消息
    toolProgress: events.filter(e => e.type === 'tool_progress'),
    // tool_use_summary 消息
    toolUseSummary: events.filter(e => e.type === 'tool_use_summary'),
    // system status 消息
    systemStatuses: events.filter(e => e.type === 'system' && e.subtype === 'status'),
    // input_json_delta 推送次数（仅 ExitWorktree）
    exitInputDeltaCount: inputJsonDeltas.length,
    // 所有工具名称
    allToolNames: events.filter(e => e.toolName).map(e => e.toolName),
    // num_turns
    numTurns: (() => {
      const r = events.find(e => e.type === 'result');
      return r?.raw?.num_turns;
    })(),
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

describe('ExitWorktree 工具流式事件观察', () => {

  /**
   * Case 1: 先 EnterWorktree 再 ExitWorktree(action=keep) — 成功场景
   *
   * 观察目标：
   * - ExitWorktree 的 input_json_delta 如何推送
   * - ExitWorktree 成功时的 tool_result 格式（action, originalCwd, worktreePath, message）
   * - ExitWorktree 执行期间是否有 tool_progress 事件
   * - 两步工作流：num_turns 应为 3（enter → exit → reply）
   */
  it('case-1 EnterWorktree → ExitWorktree(keep) — 成功场景', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-1-exit-keep');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: [
        'Do the following two steps in order:',
        '1. Use the EnterWorktree tool to create a new worktree with the name "exit-test-keep".',
        '2. After the worktree is created, use the ExitWorktree tool with action="keep" to leave it.',
        'Tell me what happened in each step.',
      ].join(' '),
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: EnterWorktree → ExitWorktree(keep)', events, duration);

    // 提取 ExitWorktree 相关事件
    const wtEvents = extractExitWorktreeEvents(events);
    console.error('── ExitWorktree 相关事件 ──');
    console.error(`  所有工具名称: ${wtEvents.allToolNames.join(', ')}`);
    console.error(`  EnterWorktree blocks: ${wtEvents.enterWorktreeBlocks.length}`);
    console.error(`  ExitWorktree blocks: ${wtEvents.exitWorktreeBlocks.length}`);
    console.error(`  ExitWorktree input_json_delta 事件数: ${wtEvents.exitInputDeltaCount}`);
    console.error(`  user tool_result 事件数: ${wtEvents.userToolResults.length}`);
    console.error(`  tool_progress 事件数: ${wtEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${wtEvents.toolUseSummary.length}`);
    console.error(`  system status 事件数: ${wtEvents.systemStatuses.length}`);
    console.error(`  num_turns: ${wtEvents.numTurns}`);

    // 打印 ExitWorktree 完整 input JSON
    console.error('\n── ExitWorktree 完整 input JSON ──');
    console.error(`  raw: "${wtEvents.fullInputJson}"`);
    console.error(`  length: ${wtEvents.fullInputJson.length}`);
    if (wtEvents.fullInputJson) {
      try {
        const parsed = JSON.parse(wtEvents.fullInputJson);
        console.error(`  parsed: ${JSON.stringify(parsed, null, 2)}`);
        console.error(`  字段: ${Object.keys(parsed).join(', ') || '(无字段)'}`);
      } catch {
        console.error(`  (JSON 不完整: ${wtEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 打印 input_json_delta 推送详情
    if (wtEvents.inputJsonDeltas.length > 0) {
      console.error('\n── ExitWorktree input_json_delta 推送序列 ──');
      for (let i = 0; i < wtEvents.inputJsonDeltas.length; i++) {
        const d = wtEvents.inputJsonDeltas[i];
        console.error(`  [${i+1}] "${d.inputJsonSnippet}"`);
      }
    }

    // 打印 assistant tool_use blocks 详情
    for (const blockList of [
      { name: 'EnterWorktree', blocks: wtEvents.enterWorktreeBlocks },
      { name: 'ExitWorktree', blocks: wtEvents.exitWorktreeBlocks },
    ]) {
      if (blockList.blocks.length > 0) {
        console.error(`\n── assistant tool_use 详情 (${blockList.name}) ──`);
        for (const e of blockList.blocks) {
          console.error(`  toolUseId: ${e.toolUseId}`);
          if (e.raw?.toolInput !== undefined) {
            console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
          }
        }
      }
    }

    // 打印 user 消息详情（tool_result）— 这是最关键的
    if (wtEvents.userToolResults.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (let i = 0; i < wtEvents.userToolResults.length; i++) {
        const e = wtEvents.userToolResults[i];
        console.error(`\n  === user message ${i+1} ===`);
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (wtEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of wtEvents.toolProgress) {
        console.error(`  [${e.index}] tool_name=${e.raw?.tool_name}, elapsed=${e.raw?.elapsed_time_seconds}s`);
      }
    }

    // 保存完整事件日志
    writeFileSync(
      `${dir}/sdk-events.json`,
      JSON.stringify(events, null, 2),
    );

    // 结构断言
    expect(events.length).toBeGreaterThan(0);

    // 检查 result 消息
    const resultEvent = events.find(e => e.type === 'result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.raw) {
      console.error(`\n── result ──`);
      console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
      console.error(`  duration_ms: ${resultEvent.raw.duration_ms}`);
      console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: 先 EnterWorktree 再 ExitWorktree(action=remove) — 删除场景
   *
   * 观察目标：
   * - action="remove" 时 ExitWorktree 的 tool_result 格式差异
   * - discardedFiles / discardedCommits 字段是否出现
   * - 删除时 tool_result 的 message 内容
   */
  it('case-2 EnterWorktree → ExitWorktree(remove) — 删除场景', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-2-exit-remove');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: [
        'Do the following two steps in order:',
        '1. Use the EnterWorktree tool to create a new worktree with the name "exit-test-remove".',
        '2. After the worktree is created, use the ExitWorktree tool with action="remove" to delete it.',
        'Tell me what happened in each step.',
      ].join(' '),
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: EnterWorktree → ExitWorktree(remove)', events, duration);

    const wtEvents = extractExitWorktreeEvents(events);

    console.error('── ExitWorktree 分析 ──');
    console.error(`  所有工具名称: ${wtEvents.allToolNames.join(', ')}`);
    console.error(`  EnterWorktree blocks: ${wtEvents.enterWorktreeBlocks.length}`);
    console.error(`  ExitWorktree blocks: ${wtEvents.exitWorktreeBlocks.length}`);
    console.error(`  ExitWorktree input_json_delta 数: ${wtEvents.exitInputDeltaCount}`);
    console.error(`  user 消息数: ${wtEvents.userToolResults.length}`);
    console.error(`  tool_progress 数: ${wtEvents.toolProgress.length}`);
    console.error(`  num_turns: ${wtEvents.numTurns}`);

    // ExitWorktree input JSON
    console.error('\n── ExitWorktree input JSON ──');
    console.error(`  raw: "${wtEvents.fullInputJson}"`);
    if (wtEvents.fullInputJson) {
      try {
        const parsed = JSON.parse(wtEvents.fullInputJson);
        console.error(`  parsed: ${JSON.stringify(parsed, null, 2)}`);
      } catch {
        console.error(`  (JSON 不完整)`);
      }
    }

    // input_json_delta 推送序列
    if (wtEvents.inputJsonDeltas.length > 0) {
      console.error('\n── ExitWorktree input_json_delta 推送序列 ──');
      for (let i = 0; i < wtEvents.inputJsonDeltas.length; i++) {
        const d = wtEvents.inputJsonDeltas[i];
        console.error(`  [${i+1}] "${d.inputJsonSnippet}"`);
      }
    }

    // ExitWorktree tool_use block
    if (wtEvents.exitWorktreeBlocks.length > 0) {
      console.error('\n── ExitWorktree assistant tool_use ──');
      for (const e of wtEvents.exitWorktreeBlocks) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput !== undefined) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // user 消息（tool_result）
    if (wtEvents.userToolResults.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (let i = 0; i < wtEvents.userToolResults.length; i++) {
        const e = wtEvents.userToolResults[i];
        console.error(`\n  === user message ${i+1} ===`);
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
   * Case 3: 不在 worktree 中直接调用 ExitWorktree — no-op 场景
   *
   * 观察目标：
   * - 不在 worktree 中调用 ExitWorktree 的行为
   * - LLM 可能拒绝调用（no-op），或 SDK 返回错误
   * - 注意：这个 case 可能超时（SDK 等待交互），所以只做宽松断言
   */
  it('case-3 ExitWorktree 不在 worktree 中 — no-op 场景', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-3-not-in-worktree');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'If possible, use the ExitWorktree tool with action="keep" to exit the current worktree. If you cannot (because we are not in a worktree), just explain why.',
      logDir: dir,
    });

    printTimeline('Case 3: ExitWorktree 不在 worktree 中', events, duration);

    const wtEvents = extractExitWorktreeEvents(events);

    console.error('── 分析 ──');
    console.error(`  所有工具名称: ${wtEvents.allToolNames.join(', ') || '(无工具)'}`);
    console.error(`  ExitWorktree blocks: ${wtEvents.exitWorktreeBlocks.length}`);
    console.error(`  user 消息数: ${wtEvents.userToolResults.length}`);
    console.error(`  num_turns: ${wtEvents.numTurns}`);

    // ExitWorktree tool_use block
    if (wtEvents.exitWorktreeBlocks.length > 0) {
      console.error('\n── ExitWorktree assistant tool_use ──');
      for (const e of wtEvents.exitWorktreeBlocks) {
        console.error(`  toolUseId: ${e.toolUseId}`);
        if (e.raw?.toolInput !== undefined) {
          console.error(`  toolInput: ${JSON.stringify(e.raw.toolInput, null, 2)}`);
        }
      }
    }

    // user 消息（tool_result）
    if (wtEvents.userToolResults.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of wtEvents.userToolResults) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 120000);

  /**
   * Case 4: 纯文本基线 — 无工具调用对比
   */
  it('case-4 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-4-baseline');

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

    console.error('── 与工具调用场景对比 ──');
    console.error(`  has tool_use: ${hasToolUse}`);
    console.error(`  has input_json_delta: ${hasInputJsonDelta}`);
    console.error(`  has user message: ${hasUser}`);
    console.error(`  has tool_progress: ${hasToolProgress}`);

    expect(hasToolUse).toBe(false);
    expect(hasInputJsonDelta).toBe(false);
    expect(hasUser).toBe(false);
    expect(hasToolProgress).toBe(false);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
  }, 120000);
});

// ====== NestJS SSE 测试 ======

describe('ExitWorktree 工具 SSE 深度事件分析', () => {
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
   * Case 5: EnterWorktree → ExitWorktree 通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构（id, name）
   * - input_json_delta 拼接后的完整 JSON
   * - user 消息中 tool_result 的完整结构
   * - 两步工作流在 SSE 中的表现
   */
  it('case-5 ExitWorktree SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-5-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      [
        'Do the following two steps in order:',
        '1. Use the EnterWorktree tool to create a new worktree with the name "sse-exit-test".',
        '2. After the worktree is created, use the ExitWorktree tool with action="keep" to leave it.',
        'Tell me the worktree path and what happened.',
      ].join(' '),
      { permissionMode: 'bypassPermissions' },
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: ExitWorktree SSE 数据格式 — 前端解析参考');
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
          console.error(`  [${e.index}] ${currentToolName} input_json_delta += "${evt.delta.partial_json?.substring(0, 100)}"`);
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
    for (let i = 0; i < userEvents.length; i++) {
      const e = userEvents[i];
      const msg = e.inner?.message;
      console.error(`\n  === user message ${i+1} ===`);
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
        console.error(`  tool_use_result: ${JSON.stringify(e.inner.tool_use_result, null, 2)?.substring(0, 3000)}`);
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

    // 保存
    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(sdkTypes.has('system')).toBe(true);
    expect(sdkTypes.has('result')).toBe(true);
  }, 300000);

  /**
   * Case 6: 关闭 includePartialMessages — 对比
   */
  it('case-6 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-exitworktree/case-6-no-partial');

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: [
          'Do the following two steps in order:',
          '1. Use the EnterWorktree tool to create a new worktree with the name "no-partial-exit".',
          '2. After the worktree is created, use the ExitWorktree tool with action="remove" to delete it.',
          'Tell me what happened.',
        ].join(' '),
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

    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );
  }, 300000);
});
