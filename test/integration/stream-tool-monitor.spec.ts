/**
 * Monitor 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，Monitor 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. Monitor 工具的 tool_use 调用格式？input 有哪些字段？（command, description, timeout_ms?, persistent?）
 * 2. Monitor 工具的 tool_result 返回值格式？后台命令输出如何推送？
 * 3. Monitor 工具执行期间 SDK 推送哪些状态更新事件？频率如何？
 * 4. tool_progress 的推送频率和内容？（Monitor 是长时间运行的后台工具）
 * 5. 与 Bash 工具的 run_in_background 模式有何区别？
 *
 * 方法论：
 * - Case 1: 简单 Monitor 命令 — 完整事件时间线
 * - Case 2: 输出密集命令 — 观察 tool_progress 推送频率
 * - Case 3: 纯文本基线 — 无工具调用对比
 * - Case 4: 通过 NestJS SSE — 前端视角
 *
 * 注意：
 * - Monitor 工具需要权限（与 Bash 相同）。通过 permissionMode: 'bypassPermissions' 授权。
 * - Monitor 工具在 DISABLE_TELEMETRY 或 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 时不可用。
 * - 测试环境不设置这些变量，确保 Monitor 可用。
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

// 注意：Monitor 在 DISABLE_TELEMETRY 或 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 时不可用
// 所以这里不设置这两个环境变量
const BASE_ENV = getProfileEnv('local', { overrides: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined } });

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
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<any>;
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

  if (options.canUseTool) {
    queryOptions.canUseTool = options.canUseTool;
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
      // 对于 init 消息，记录工具列表
      if (msg.subtype === 'init' && msg.tools) {
        captured.raw = {
          toolNames: msg.tools.map((t: any) => t.name || t),
        };
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
      if (e.raw?.toolNames) detail += ` tools: [${e.raw.toolNames.slice(0, 10).join(', ')}${e.raw.toolNames.length > 10 ? '...' : ''}]`;
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

/** 提取 Monitor 工具相关事件 */
function extractMonitorEvents(events: CapturedSDKEvent[]) {
  let inMonitorBlock = false;
  const inputJsonDeltas: CapturedSDKEvent[] = [];
  let fullInputJson = '';

  for (const e of events) {
    // content_block_start 标记进入 Monitor block
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === 'Monitor') {
      inMonitorBlock = true;
    }
    // content_block_stop 标记退出 block
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inMonitorBlock) {
      inMonitorBlock = false;
    }
    // input_json_delta 在 Monitor block 内
    if (inMonitorBlock && e.type === 'stream_event' && e.deltaType === 'input_json_delta') {
      inputJsonDeltas.push(e);
      if (e.inputJsonSnippet) fullInputJson += e.inputJsonSnippet;
    }
  }

  return {
    inputJsonDeltas,
    fullInputJson,
    // assistant tool_use block
    assistantToolUse: events.filter(e => e.type === 'assistant' && e.toolName === 'Monitor'),
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
    // 检查 init 消息中的工具列表
    systemInit: events.find(e => e.type === 'system' && e.subtype === 'init'),
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

  // SSE 环境：不设置 DISABLE_TELEMETRY 和 DISABLE_NONESSENTIAL_TRAFFIC
  const sseEnv = getProfileEnv('local', { overrides: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined } });

  const response = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      options: {
        env: sseEnv,
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

describe('Monitor 工具流式事件观察', () => {

  /**
   * Case 1: 简单 Monitor 命令 — 完整事件时间线
   *
   * 观察目标：
   * - Monitor 工具是否在 init 消息的工具列表中
   * - Monitor 工具的 input_json_delta 如何流式构建 command/description 参数
   * - tool_result 的具体格式（后台任务输出）
   * - Monitor 执行期间是否有 tool_progress 事件
   * - 与 Bash 工具对比
   */
  it('case-1 Monitor 简单命令 — 完整事件时间线', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-1-simple-monitor');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Monitor tool to watch the output of the command "echo Monitor-Test-Output". Then tell me what was monitored.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: Monitor 简单命令', events, duration);

    // 检查 init 消息中是否有 Monitor 工具
    const monitorEvents = extractMonitorEvents(events);
    console.error('── 工具可用性检查 ──');
    if (monitorEvents.systemInit?.raw?.toolNames) {
      const toolNames = monitorEvents.systemInit.raw.toolNames as string[];
      const hasMonitor = toolNames.includes('Monitor');
      console.error(`  工具列表中是否有 Monitor: ${hasMonitor}`);
      console.error(`  工具列表（前15个）: ${toolNames.slice(0, 15).join(', ')}`);
    }
    console.error('');

    console.error('── Monitor 相关事件 ──');
    console.error(`  input_json_delta 事件数: ${monitorEvents.inputDeltaCount}`);
    console.error(`  assistant tool_use 事件数: ${monitorEvents.assistantToolUse.length}`);
    console.error(`  user tool_result 事件数: ${monitorEvents.userToolResult.length}`);
    console.error(`  tool_progress 事件数: ${monitorEvents.toolProgress.length}`);
    console.error(`  tool_use_summary 事件数: ${monitorEvents.toolUseSummary.length}`);
    console.error(`  system status 事件数: ${monitorEvents.systemStatuses.length}`);
    console.error('');

    // 打印完整 input JSON
    if (monitorEvents.fullInputJson) {
      console.error('── 完整 Monitor input JSON ──');
      try {
        const parsed = JSON.parse(monitorEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
        console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
        if (parsed.command) console.error(`  command: "${parsed.command}"`);
        if (parsed.description) console.error(`  description: "${parsed.description}"`);
        if (parsed.timeout_ms) console.error(`  timeout_ms: ${parsed.timeout_ms}`);
        if (parsed.persistent !== undefined) console.error(`  persistent: ${parsed.persistent}`);
      } catch {
        console.error(`  (JSON 不完整: ${monitorEvents.fullInputJson.substring(0, 300)})`);
      }
    }

    // 打印 user 消息详情（tool_result）
    if (monitorEvents.userToolResult.length > 0) {
      console.error('\n── user 消息详情（tool_result）──');
      for (const e of monitorEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    // 打印 tool_progress 详情
    if (monitorEvents.toolProgress.length > 0) {
      console.error('\n── tool_progress 详情 ──');
      for (const e of monitorEvents.toolProgress) {
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

    // 如果 LLM 成功调用了 Monitor
    if (monitorEvents.assistantToolUse.length > 0) {
      expect(monitorEvents.inputDeltaCount).toBeGreaterThan(0);
      expect(monitorEvents.userToolResult.length).toBeGreaterThan(0);

      // 验证有 result 消息
      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent).toBeDefined();
      if (resultEvent?.raw) {
        console.error(`  num_turns: ${resultEvent.raw.num_turns}`);
        console.error(`  stop_reason: ${resultEvent.raw.stop_reason}`);
      }
    } else {
      console.error('⚠️ LLM 未调用 Monitor（可能使用了 Bash 或直接文本回答）');

      // 检查是否使用了 Bash 替代
      const bashToolUse = events.filter(e => e.type === 'assistant' && e.toolName === 'Bash');
      if (bashToolUse.length > 0) {
        console.error('  → LLM 使用了 Bash 替代 Monitor');
      }
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: 输出密集 Monitor 命令 — 观察 tool_progress 推送频率
   *
   * 观察目标：
   * - 长时间运行命令时 tool_progress 的推送频率
   * - Monitor 的逐行输出推送机制
   * - tool_progress 的 elapsed_time_seconds 增长规律
   */
  it('case-2 Monitor 输出密集命令 — tool_progress 频率', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-2-heavy-output');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Monitor tool to watch this command: for i in $(seq 1 20); do echo "Monitor line $i"; sleep 1; done. Tell me when it finishes.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: Monitor 输出密集命令', events, duration);

    const monitorEvents = extractMonitorEvents(events);

    // 重点分析 tool_progress
    console.error('── tool_progress 分析 ──');
    console.error(`  tool_progress 事件数: ${monitorEvents.toolProgress.length}`);

    if (monitorEvents.toolProgress.length > 0) {
      const progressTimes = monitorEvents.toolProgress.map(e => e.raw?.elapsed_time_seconds);
      console.error(`  elapsed_time_seconds 列表: ${JSON.stringify(progressTimes)}`);

      // 计算推送间隔
      if (progressTimes.length > 1) {
        const intervals: number[] = [];
        for (let i = 1; i < progressTimes.length; i++) {
          intervals.push(progressTimes[i] - progressTimes[i - 1]);
        }
        console.error(`  推送间隔(s): ${JSON.stringify(intervals)}`);
        console.error(`  平均间隔: ${(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(2)}s`);
      }
    } else {
      console.error('  (无 tool_progress 事件 — Monitor 可能不推送 tool_progress，或命令执行太快)');
    }

    // 分析 tool_result 中 stdout 的长度
    if (monitorEvents.userToolResult.length > 0) {
      const firstUser = monitorEvents.userToolResult[0];
      console.error('\n── tool_result 内容分析 ──');
      if (firstUser.raw?.messageContentTypes) {
        for (const b of firstUser.raw.messageContentTypes) {
          if (b.type === 'tool_result' && b.contentSnippet) {
            const snippetLength = JSON.stringify(b.contentSnippet).length;
            console.error(`  content snippet length: ${snippetLength}`);
          }
        }
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
   * Case 3: 纯文本基线 — 无工具调用对比
   */
  it('case-3 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-3-baseline');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Say exactly: "baseline test for monitor". Nothing else.',
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

    expect(hasToolUse).toBe(false);
    expect(hasInputJsonDelta).toBe(false);
    expect(hasUser).toBe(false);
    expect(hasToolProgress).toBe(false);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
  }, 120000);

  /**
   * Case 4: 显式请求使用 Monitor 工具 — 观察 LLM 是否选择 Monitor
   *
   * 有些 LLM 可能倾向于使用 Bash 而非 Monitor，即使请求中提到了 Monitor。
   * 这个测试使用更明确的指令，确保 LLM 使用 Monitor 工具。
   */
  it('case-4 显式使用 Monitor — tail -f 模拟', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-4-explicit-monitor');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'I need you to use the Monitor tool (not Bash) to watch a simple command. Use the Monitor tool with command "echo test-monitor-output && sleep 2 && echo done". Report what you see.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 4: 显式使用 Monitor', events, duration);

    const monitorEvents = extractMonitorEvents(events);
    const bashEvents = events.filter(e => e.type === 'assistant' && e.toolName === 'Bash');

    console.error('── 工具选择分析 ──');
    console.error(`  Monitor tool_use: ${monitorEvents.assistantToolUse.length}`);
    console.error(`  Bash tool_use: ${bashEvents.length}`);

    if (monitorEvents.fullInputJson) {
      console.error('\n── Monitor input JSON ──');
      try {
        const parsed = JSON.parse(monitorEvents.fullInputJson);
        console.error(JSON.stringify(parsed, null, 2));
      } catch {
        console.error(`  (JSON 不完整)`);
      }
    }

    if (monitorEvents.userToolResult.length > 0) {
      console.error('\n── Monitor tool_result ──');
      for (const e of monitorEvents.userToolResult) {
        console.error(JSON.stringify(e.raw, null, 2));
      }
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);
});

// ====== NestJS SSE 测试 ======

describe('Monitor 工具 SSE 深度事件分析', () => {
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
   * Case 5: Monitor 工具通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构（id, name）
   * - input_json_delta 拼接后的完整 JSON
   * - user 消息中 tool_result 的完整结构
   * - tool_progress 在 SSE 中的表现
   */
  it('case-5 Monitor SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-5-sse-format');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the Monitor tool to watch the command "echo SSE-MONITOR-TEST". Then tell me what happened.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 5: Monitor SSE 数据格式 — 前端解析参考');
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

    // 跟踪 Monitor 工具的 block 上下文
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
   * Case 6: 关闭 includePartialMessages — 对比
   */
  it('case-6 关闭 includePartialMessages 对比', async () => {
    const dir = createTimestampDir('stream-tool-monitor/case-6-no-partial');

    const sseEnv = getProfileEnv('local', { overrides: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined } });

    const requestStart = Date.now();
    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Use the Monitor tool to watch "echo no-partial-monitor-test". Then tell me the output.',
        options: {
          env: sseEnv,
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

    writeFileSync(
      `${dir}/sse-events.json`,
      JSON.stringify(events, null, 2),
    );
  }, 240000);
});
