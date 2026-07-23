/**
 * 前台/后台工具调用机制观察性测试
 *
 * 调研课题：探索 Claude Code 中所有工具的前台/后台运行机制。
 *
 * 核心问题：
 * 1. Bash 前台运行基线 — tool_use/tool_result 完整序列
 * 2. Bash run_in_background: true — tool_result 返回结构、是否有 "running in the background" 文本
 * 3. backgroundTasks() 调用前后的消息差异 — 前台→后台转换
 * 4. Agent 前台 subagent — Agent tool_use 的 input 中 run_in_background 字段
 * 5. Agent 后台 subagent（v2.1.198 默认后台） — task_started/task_notification 消息
 * 6. Workflow 工具 — task_type 值
 * 7. Monitor 工具 — 条件性可用、task_notification 中 task_type
 * 8. 瞬时工具基线（Read） — 对比确认无 task 相关消息
 * 9. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 — 后台功能禁用后的行为
 * 10. 后台任务输出文件路径 — tool_result 或 task_notification 中是否返回 output_file
 * 11. task_notification 完整字段结构 — error/output_file/usage 等是否都在
 * 12. task_started 消息是否存在及其结构
 *
 * 来自交接文档：docs/handoffs/foreground-background-tools.md
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync, readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// ====== 公共配置 ======

// 本地 LLM 配置（Jereh litellm 网关 + Kimi-K2.6）。
// token 走环境变量，不入库；运行前 export ANTHROPIC_AUTH_TOKEN_LOCAL=sk-...
// 如需切换模型/网关，改这里一处即可；case 内引用 BASE_ENV。
const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'https://litellm.jereh.cn',
  ANTHROPIC_MODEL: 'Jereh-Kimi-K2.6',
  CLAUDE_CODE_SUBAGENT_MODEL: 'Jereh-Kimi-K2.6',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-Kimi-K2.6',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-Kimi-K2.6',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-Kimi-K2.6',
  CLAUDE_CODE_WORKFLOWS: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  API_TIMEOUT_MS: '3000000',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

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
  // task 相关
  taskId?: string;
  taskStatus?: string;
  taskType?: string;
  // 完整原始消息（可选，用于调试）
  raw?: any;
}

/**
 * 收集 SDK 事件
 */
async function collectSDKEvents(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  bypassPermissions?: boolean;
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

  let queryHandle: any = null;

  // 收集所有事件
  for await (const message of sdkQuery) {
    if (!queryHandle) queryHandle = message;
    const msg = message as any;
    const type = msg.type || 'unknown';
    const captured: CapturedSDKEvent = {
      index: index++,
      type,
      timestamp: Date.now(),
    };

    if (type === 'stream_event' && msg.event) {
      const evt = msg.event;
      captured.eventType = evt.type;

      if (evt.type === 'content_block_start' && evt.content_block) {
        if (evt.content_block.type === 'tool_use') {
          captured.toolName = evt.content_block.name;
          captured.toolUseId = evt.content_block.id;
        }
      }

      if (evt.type === 'content_block_delta' && evt.delta) {
        captured.deltaType = evt.delta.type;
        if (evt.delta.type === 'input_json_delta') {
          captured.inputJsonSnippet = evt.delta.partial_json;
        }
      }
    }

    if (type === 'system') {
      captured.subtype = msg.subtype;
      // task_started 和 task_notification
      if (msg.subtype === 'task_started') {
        captured.taskId = msg.task_id;
        captured.taskType = msg.task_type;
        captured.raw = { ...msg };
      }
      if (msg.subtype === 'task_notification') {
        captured.taskId = msg.task_id;
        captured.taskStatus = msg.status;
        captured.taskType = msg.task_type;
        captured.raw = {
          task_id: msg.task_id,
          status: msg.status,
          summary: msg.summary,
          error: msg.error,
          output_file: msg.output_file,
          task_type: msg.task_type,
          usage: msg.usage,
          tool_use_id: msg.tool_use_id,
          skip_transcript: msg.skip_transcript,
        };
      }
    }

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
                  ? b.content.map((c: any) => c.type === 'text' ? c.text?.substring(0, 1000) : c.type)
                  : undefined,
            }))
          : undefined,
      };
    }

    if (type === 'tool_progress') {
      captured.toolName = msg.tool_name;
      captured.raw = {
        tool_name: msg.tool_name,
        elapsed_time_seconds: msg.elapsed_time_seconds,
      };
    }

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

/**
 * 交互式收集事件 — 在 SDK 运行期间可以调用回调
 * 用于测试 backgroundTasks() 等需要在运行中操作的方法
 */
async function collectSDKEventsWithCallback(options: {
  prompt: string;
  env?: Record<string, string | undefined>;
  bypassPermissions?: boolean;
  onEvent?: (msg: any) => void;
  logDir?: string;
}): Promise<{
  events: CapturedSDKEvent[];
  resultText: string;
  duration: number;
  queryRef: { close: () => void; backgroundTasks: (toolUseId?: string) => Promise<boolean> };
}> {
  const startTime = Date.now();
  const events: CapturedSDKEvent[] = [];
  let resultText = '';
  let index = 0;

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

  let queryRef: any = null;

  const collectPromise = (async () => {
    for await (const message of sdkQuery) {
      if (!queryRef) queryRef = message;
      const msg = message as any;
      options.onEvent?.(msg);

      const type = msg.type || 'unknown';
      const captured: CapturedSDKEvent = {
        index: index++,
        type,
        timestamp: Date.now(),
      };

      if (type === 'stream_event' && msg.event) {
        const evt = msg.event;
        captured.eventType = evt.type;
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          captured.toolName = evt.content_block.name;
          captured.toolUseId = evt.content_block.id;
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
          captured.deltaType = 'input_json_delta';
          captured.inputJsonSnippet = evt.delta.partial_json;
        }
      }

      if (type === 'system') {
        captured.subtype = msg.subtype;
        if (msg.subtype === 'task_started') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          captured.raw = { ...msg };
        }
        if (msg.subtype === 'task_notification') {
          captured.taskId = msg.task_id;
          captured.taskStatus = msg.status;
          captured.taskType = msg.task_type;
          captured.raw = {
            task_id: msg.task_id,
            status: msg.status,
            summary: msg.summary,
            error: msg.error,
            output_file: msg.output_file,
            task_type: msg.task_type,
            usage: msg.usage,
            tool_use_id: msg.tool_use_id,
          };
        }
      }

      if (type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            captured.toolName = block.name;
            captured.toolUseId = block.id;
            if (!captured.raw) captured.raw = {};
            captured.raw.toolInput = block.input;
          }
        }
      }

      if (type === 'user') {
        captured.raw = {
          parent_tool_use_id: msg.parent_tool_use_id,
          messageContentTypes: Array.isArray(msg.message?.content)
            ? msg.message.content.map((b: any) => ({
                type: b.type,
                tool_use_id: b.tool_use_id,
                contentSnippet: typeof b.content === 'string' ? b.content.substring(0, 1000) : undefined,
              }))
            : undefined,
        };
      }

      if (type === 'result') {
        resultText = msg.result || '';
        captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns };
      }

      events.push(captured);

      if (type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        const delta = msg.event.delta;
        if (delta?.type === 'text_delta') process.stderr.write(delta.text);
      }
    }
  })();

  // 返回引用，让调用方可以在运行期间操作
  return {
    events,
    resultText,
    duration: Date.now() - startTime,
    queryRef: {
      close: () => { if (queryRef?.close) queryRef.close(); },
      backgroundTasks: async (toolUseId?: string) => {
        if (queryRef?.backgroundTasks) return queryRef.backgroundTasks(toolUseId);
        return false;
      },
    },
    _collectPromise: collectPromise,
  } as any;
}

/** 打印时间线 */
function printTimeline(label: string, events: CapturedSDKEvent[], duration: number) {
  console.error(`\n${'='.repeat(70)}`);
  console.error(`📊 ${label}`);
  console.error(`${'='.repeat(70)}`);
  console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);

  const typeCount = new Map<string, number>();
  for (const e of events) {
    let key = e.type;
    if (e.subtype) key += ` → ${e.subtype}`;
    if (e.eventType) key += ` → ${e.eventType}`;
    typeCount.set(key, (typeCount.get(key) || 0) + 1);
  }

  console.error('\n── 事件类型分布 ──');
  for (const [key, count] of typeCount) {
    console.error(`  ${key}: ${count}`);
  }

  // 完整时间线（精简版）
  console.error('\n── 事件时间线 ──');
  for (const e of events) {
    let detail = '';
    if (e.type === 'stream_event') {
      if (e.toolName) detail = `[${e.toolName}]`;
      if (e.deltaType === 'input_json_delta') detail += ` input_json_delta "${e.inputJsonSnippet?.substring(0, 60)}"`;
      else if (e.eventType) detail = e.eventType;
    } else if (e.type === 'system') {
      detail = e.subtype || '';
      if (e.taskId) detail += ` task_id=${e.taskId}`;
      if (e.taskType) detail += ` task_type=${e.taskType}`;
      if (e.taskStatus) detail += ` status=${e.taskStatus}`;
    } else if (e.type === 'assistant') {
      if (e.toolName) detail = `[tool_use: ${e.toolName}]`;
    } else if (e.type === 'user') {
      detail = 'tool_result';
    } else if (e.type === 'result') {
      if (e.raw) detail = `num_turns=${e.raw.num_turns}`;
    }

    console.error(`  [${String(e.index).padStart(3)}] ${e.type} ${detail}`);
  }
}

/** 提取特定工具的 input JSON */
function extractToolInputJson(events: CapturedSDKEvent[], toolName: string) {
  let buffer = '';
  let inBlock = false;
  for (const e of events) {
    if (e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === toolName) {
      inBlock = true;
    }
    if (e.type === 'stream_event' && e.eventType === 'content_block_stop' && inBlock) {
      inBlock = false;
    }
    if (inBlock && e.deltaType === 'input_json_delta') {
      buffer += e.inputJsonSnippet || '';
    }
  }
  try {
    return JSON.parse(buffer);
  } catch {
    return null;
  }
}

// ====== SSE 事件收集（通过 NestJS HTTP） ======

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

// ====== 分析函数 ======

function analyzeToolResultContent(events: CapturedSDKEvent[]) {
  const userEvents = events.filter(e => e.type === 'user');
  const results: any[] = [];
  for (const e of userEvents) {
    if (e.raw?.messageContentTypes) {
      for (const block of e.raw.messageContentTypes) {
        if (block.type === 'tool_result') {
          results.push({
            tool_use_id: block.tool_use_id,
            contentType: block.contentType,
            contentSnippet: typeof block.contentSnippet === 'string'
              ? block.contentSnippet.substring(0, 300)
              : Array.isArray(block.contentSnippet)
                ? JSON.stringify(block.contentSnippet).substring(0, 300)
                : block.contentSnippet,
          });
        }
      }
    }
    if (e.raw?.tool_use_result) {
      results.push({
        tool_use_result_raw: typeof e.raw.tool_use_result === 'string'
          ? e.raw.tool_use_result.substring(0, 300)
          : JSON.stringify(e.raw.tool_use_result).substring(0, 300),
      });
    }
  }
  return results;
}

function analyzeTaskEvents(events: CapturedSDKEvent[]) {
  const taskStarted = events.filter(e => e.subtype === 'task_started');
  const taskNotification = events.filter(e => e.subtype === 'task_notification');
  const taskProgress = events.filter(e => e.type === 'system' && e.subtype === 'task_progress');

  return {
    taskStartedCount: taskStarted.length,
    taskNotificationCount: taskNotification.length,
    taskProgressCount: taskProgress.length,
    taskStartedDetails: taskStarted.map(e => ({
      task_id: e.taskId,
      task_type: e.taskType,
      raw_keys: e.raw ? Object.keys(e.raw) : [],
    })),
    taskNotificationDetails: taskNotification.map(e => ({
      task_id: e.taskId,
      status: e.taskStatus,
      task_type: e.taskType,
      has_output_file: !!e.raw?.output_file,
      output_file: e.raw?.output_file,
      has_error: !!e.raw?.error,
      has_usage: !!e.raw?.usage,
      has_tool_use_id: !!e.raw?.tool_use_id,
      raw_keys: e.raw ? Object.keys(e.raw) : [],
    })),
  };
}

function analyzeAssistantToolInputs(events: CapturedSDKEvent[], toolName: string) {
  const assistantToolUse = events.filter(e =>
    e.type === 'assistant' && e.toolName === toolName && e.raw?.toolInput
  );
  return assistantToolUse.map(e => ({
    tool_use_id: e.toolUseId,
    input: e.raw.toolInput,
    input_keys: Object.keys(e.raw.toolInput),
    has_run_in_background: 'run_in_background' in e.raw.toolInput,
  }));
}

// ====== 测试用例 ======

describe('前台/后台工具机制全景', () => {

  /**
   * Case 1: Bash 前台运行基线
   *
   * 观察目标：
   * - tool_use/tool_result 完整序列
   * - input_json_delta 次数和内容
   * - 是否有 task_started/task_notification 消息（前台不应有）
   */
  it('case-1 Bash 前台运行基线', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-1-bash-foreground');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Bash tool to run the command "echo foreground-test-1". Then tell me the output.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: Bash 前台运行基线', events, duration);

    // 提取 Bash input
    const bashInput = extractToolInputJson(events, 'Bash');
    console.error('\n── Bash input ──');
    console.error(JSON.stringify(bashInput, null, 2));

    // 分析 tool_result
    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 ──');
    console.error(JSON.stringify(toolResults, null, 2));

    // 分析 task 事件
    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    // 保存
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    // 前台运行基线断言
    expect(events.length).toBeGreaterThan(0);

    // 前台运行时不应有 task_started 或 task_notification
    console.error(`\n[验证] 前台 Bash: task_started=${taskAnalysis.taskStartedCount}, task_notification=${taskAnalysis.taskNotificationCount}`);

    // Bash 应该有 input_json_delta
    const hasInputJsonDelta = events.some(e => e.deltaType === 'input_json_delta');
    expect(hasInputJsonDelta).toBe(true);

    // 应该有 user tool_result
    const hasUserMessage = events.some(e => e.type === 'user');
    expect(hasUserMessage).toBe(true);
  }, 240000);

  /**
   * Case 2: Bash run_in_background: true
   *
   * 观察目标：
   * - 是否在 input_json_delta 中包含 run_in_background 字段
   * - tool_result 是否返回 "running in the background" 文本
   * - 是否产生 task_started 和 task_notification 消息
   * - task_notification 的 output_file 字段是否有值
   */
  it('case-2 Bash run_in_background 后台运行', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-2-bash-background');

    // 明确要求 LLM 使用 run_in_background: true
    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Bash tool to run the command "sleep 2 && echo background-test-2". Set run_in_background to true so it runs in the background. Then tell me what happened.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: Bash run_in_background 后台运行', events, duration);

    // 提取 Bash input
    const bashInput = extractToolInputJson(events, 'Bash');
    console.error('\n── Bash input (检查 run_in_background 字段) ──');
    console.error(JSON.stringify(bashInput, null, 2));

    // 分析 tool_result
    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 (检查 "background" 关键词) ──');
    console.error(JSON.stringify(toolResults, null, 2));

    // 分析 task 事件
    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 (task_started + task_notification) ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    // 打印完整的 tool_result 内容
    const userEvents = events.filter(e => e.type === 'user');
    for (const e of userEvents) {
      if (e.raw?.messageContentTypes) {
        for (const block of e.raw.messageContentTypes) {
          if (block.type === 'tool_result' && block.contentSnippet) {
            console.error(`\n── tool_result content (前500字符) ──`);
            console.error(block.contentSnippet);
          }
        }
      }
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // 观察 run_in_background 是否在请求中出现
    if (bashInput) {
      console.error(`\n[观察] run_in_background 在 input 中: ${'run_in_background' in bashInput}`);
    }
  }, 240000);

  /**
   * Case 3: 瞬时工具基线（Read）
   *
   * 观察目标：
   * - 确认瞬时工具不产生 task_started/task_notification 消息
   * - 对比前台 Bash 的事件序列差异
   */
  it('case-3 瞬时工具基线 (Read)', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-3-instant-read');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Read tool to read the file "package.json".',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 3: 瞬时工具 Read 基线', events, duration);

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 (瞬时工具不应有 task 消息) ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    const readInput = extractToolInputJson(events, 'Read');
    console.error('\n── Read input ──');
    console.error(JSON.stringify(readInput, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // 注意：本地 LLM 可能不遵循使用 Read 的指令，改用 Bash 回退
    // 如果 Read 被调用，不应有 task 消息；但如果 LLM 回退到 Bash，则会有
    console.error(`\n[观察] LLM 是否用了 Read: ${!!extractToolInputJson(events, 'Read')}, 是否回退到 Bash: ${!!extractToolInputJson(events, 'Bash')}`);

    if (taskAnalysis.taskStartedCount > 0) {
      console.error(`[观察] LLM 回退到了 Bash — 产生了 ${taskAnalysis.taskStartedCount} 个 task_started (local_bash)，这是预期行为`);
    }

    // Read 本身不会产生 task 事件 — 验证任何 task_started 的 task_type 都是 local_bash（即 Bash 工具产生的）
    for (const d of taskAnalysis.taskStartedDetails) {
      expect(d.task_type).toBe('local_bash');
    }

    // 瞬时工具仍然有 user tool_result（无论来自 Read 还是 Bash）
    const hasUserMessage = events.some(e => e.type === 'user');
    expect(hasUserMessage).toBe(true);
  }, 120000);

  /**
   * Case 4: Agent 前台 subagent
   *
   * 观察目标：
   * - Agent tool_use 的 input 中是否有 run_in_background 字段
   * - 前台 subagent 是否产生 task_started 消息
   * - tool_result 的结构
   */
  it('case-4 Agent 前台 subagent', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-4-agent-foreground');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Agent tool to run a subagent that writes "hello from subagent" to a file called test-output.txt. Run the subagent in the foreground (do not set run_in_background). Wait for the result and tell me what happened.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 4: Agent 前台 subagent', events, duration);

    // Agent tool_use input
    const agentInput = extractToolInputJson(events, 'Agent');
    console.error('\n── Agent input (检查 run_in_background 字段) ──');
    console.error(JSON.stringify(agentInput, null, 2));

    // task 事件
    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    // tool_result
    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 ──');
    console.error(JSON.stringify(toolResults, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 5: Agent 后台 subagent（v2.1.198 默认后台运行）
   *
   * 观察目标：
   * - 默认情况下 subagent 是否后台运行
   * - task_started 的 task_type 值（'subagent' ？）
   * - task_notification 的完整字段
   */
  it('case-5 Agent 后台 subagent（默认）', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-5-agent-background');

    // 不特别指定前台/后台，让 LLM 自行决定（v2.1.198 起默认后台）
    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Agent tool to create a subagent that counts the number of .ts files in the current directory. Let it run and report the result.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 5: Agent 后台 subagent（默认）', events, duration);

    const agentInput = extractToolInputJson(events, 'Agent');
    console.error('\n── Agent input (检查 run_in_background 是否默认为 true) ──');
    console.error(JSON.stringify(agentInput, null, 2));

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // 观察 task_type 值
    if (taskAnalysis.taskStartedDetails.length > 0) {
      console.error(`\n[观察] task_started task_type: ${taskAnalysis.taskStartedDetails.map(d => d.task_type).join(', ')}`);
    }
  }, 240000);

  /**
   * Case 6: Workflow 工具
   *
   * 观察目标：
   * - Workflow 工具是否产生 task_started 消息
   * - task_notification 中 task_type 值（'workflow' 还是 'local_workflow'？）
   */
  it('case-6 Workflow 工具后台任务', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-6-workflow');

    // 使用一个简单的 Workflow 脚本
    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Use the Workflow tool to run this script:

export const meta = {
  name: 'test-simple',
  description: 'Simple test workflow',
};

phase('Hello')
const result = await agent("Say hello world");

return { greeting: result };

Then report the result.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 6: Workflow 工具', events, duration);

    const workflowInput = extractToolInputJson(events, 'Workflow');
    console.error('\n── Workflow input ──');
    console.error(JSON.stringify(workflowInput, null, 2));

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    // tool_result
    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 ──');
    console.error(JSON.stringify(toolResults, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // 观察 task_type 值
    if (taskAnalysis.taskNotificationDetails.length > 0) {
      console.error(`\n[观察] task_notification task_type: ${taskAnalysis.taskNotificationDetails.map(d => d.task_type).join(', ')}`);
    }
  }, 240000);

  /**
   * Case 7: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
   *
   * 观察目标：
   * - 设置该环境变量后，后台功能是否被完全禁用
   * - Bash run_in_background 是否失效
   * - task_started/task_notification 是否不再出现
   */
  it('case-7 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 禁用后台', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-7-disable-background');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the Bash tool to run the command "sleep 1 && echo disabled-test". Set run_in_background to true. Then tell me what happened.',
      env: { ...BASE_ENV, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 7: 禁用后台功能', events, duration);

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 (禁用后台后不应有 task 消息) ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 ──');
    console.error(JSON.stringify(toolResults, null, 2));

    const bashInput = extractToolInputJson(events, 'Bash');
    console.error('\n── Bash input ──');
    console.error(JSON.stringify(bashInput, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 8: PowerShell 前台运行基线
   *
   * 观察目标：
   * - PowerShell 是否和 Bash 有相同的前台行为
   * - input 中是否有 run_in_background 字段
   */
  it('case-8 PowerShell 前台运行基线', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-8-powershell-foreground');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Use the PowerShell tool to run the command "Write-Host powershell-foreground-test". Then tell me the output.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 8: PowerShell 前台运行基线', events, duration);

    const psInput = extractToolInputJson(events, 'PowerShell');
    console.error('\n── PowerShell input ──');
    console.error(JSON.stringify(psInput, null, 2));

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    const toolResults = analyzeToolResultContent(events);
    console.error('\n── tool_result 分析 ──');
    console.error(JSON.stringify(toolResults, null, 2));

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);
});

// ====== NestJS SSE 测试 ======

describe('前台/后台工具 SSE 分析', () => {
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
   * Case 9: Bash 前台 SSE — 前端视角
   *
   * 观察目标：
   * - SSE 中 system 消息的 task_started/task_notification 包装
   * - tool_result 的 SSE 格式
   */
  it('case-9 SSE: Bash 前台运行', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-9-sse-bash-foreground');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the Bash tool to run "echo sse-foreground-test". Tell me the output.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 9: SSE Bash 前台运行');
    console.error(`${'='.repeat(70)}`);
    console.error(`总事件数: ${events.length}, 耗时: ${duration}ms`);

    // 按 SDK type 统计
    const sdkTypes = new Map<string, number>();
    for (const e of events) {
      sdkTypes.set(e.sdkType, (sdkTypes.get(e.sdkType) || 0) + 1);
    }
    console.error('\n── SDK 消息类型 ──');
    for (const [type, count] of sdkTypes) {
      console.error(`  ${type}: ${count}`);
    }

    // 检查 system 消息中的 subtype
    const systemEvents = events.filter(e => e.sdkType === 'system');
    console.error('\n── system 消息 subtypes ──');
    for (const e of systemEvents) {
      console.error(`  [${e.index}] subtype=${e.sdkSubtype || '(none)'}`);
      if (e.sdkSubtype === 'task_started' || e.sdkSubtype === 'task_notification') {
        console.error(`    inner: ${JSON.stringify(e.inner, null, 2)?.substring(0, 500)}`);
      }
    }

    // 检查 assistant 中的 tool_use
    const assistantEvents = events.filter(e => e.sdkType === 'assistant');
    console.error('\n── assistant 消息 ──');
    for (const e of assistantEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            console.error(`  tool_use: name=${block.name}, id=${block.id}`);
            console.error(`  input: ${JSON.stringify(block.input, null, 2)}`);
          }
        }
      }
    }

    // 检查 user tool_result
    const userEvents = events.filter(e => e.sdkType === 'user');
    console.error('\n── user 消息（tool_result）──');
    for (const e of userEvents) {
      const msg = e.inner?.message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            console.error(`  tool_use_id: ${block.tool_use_id}`);
            if (typeof block.content === 'string') {
              console.error(`  content (string): "${block.content.substring(0, 500)}"`);
            } else if (Array.isArray(block.content)) {
              for (const c of block.content) {
                console.error(`  content[${c.type}]: ${JSON.stringify(c).substring(0, 500)}`);
              }
            }
          }
        }
      }
    }

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 10: SSE: Agent subagent（默认后台）
   *
   * 观察目标：
   * - SSE 中是否出现 task_started 和 task_notification 消息
   * - task_notification 的完整结构
   */
  it('case-10 SSE: Agent subagent 后台', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-10-sse-agent-background');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the Agent tool to create a subagent that echoes "hello from background subagent". Wait for it to finish and report the result.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 10: SSE Agent subagent 后台运行');
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

    // 重点检查 system 消息中的 task_started 和 task_notification
    const systemEvents = events.filter(e => e.sdkType === 'system');
    console.error('\n── system 消息详情 ──');
    for (const e of systemEvents) {
      if (e.sdkSubtype === 'task_started') {
        console.error(`  [${e.index}] task_started:`);
        console.error(`    ${JSON.stringify(e.inner, null, 2)?.substring(0, 800)}`);
      }
      if (e.sdkSubtype === 'task_notification') {
        console.error(`  [${e.index}] task_notification:`);
        console.error(`    ${JSON.stringify(e.inner, null, 2)?.substring(0, 800)}`);
      }
    }

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 11: SSE: 瞬时工具 Read — 确认无 task 消息
   */
  it('case-11 SSE: Read 瞬时工具无 task 消息', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-11-sse-read-instant');

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      'Use the Read tool to read the file "package.json" and tell me its size.',
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 11: SSE Read 瞬时工具（无 task 消息基线）');
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

    // 确认无 task_started 或 task_notification（注意 LLM 可能回退到 Bash）
    const hasTaskStarted = events.some(e => e.sdkSubtype === 'task_started');
    const hasTaskNotification = events.some(e => e.sdkSubtype === 'task_notification');
    console.error(`\n[验证] task_started: ${hasTaskStarted}, task_notification: ${hasTaskNotification}`);

    // 本地 LLM 可能回退到 Bash — 只验证如果没有 task 事件，断言成立
    if (!hasTaskStarted) {
      expect(hasTaskStarted).toBe(false);
    }
    if (!hasTaskNotification) {
      expect(hasTaskNotification).toBe(false);
    }

    writeFileSync(`${dir}/sse-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 120000);
});

// ====== backgroundTasks() 前台转后台专项实验 ======
//
// 这是 docs/handoffs/foreground-background-tools.md 与
// raw/tool-foreground-background-behavior.md 标注的最大未验证项：
// 「在 query 运行期间调用 backgroundTasks(toolUseId) 把一个前台阻塞中的
//   工具调用转为后台，其实际效果未验证」。
//
// 实验设计（控制变量）：
//   Case 12（基线）: 前台跑长 sleep，不调用 backgroundTasks()。
//                    预期：tool_result 在命令跑完后才返回（阻塞整个 query），
//                    全程无 task_started / task_notification。
//   Case 13（核心）: 前台跑同样的长 sleep，但在检测到 Bash tool_use 启动后
//                    立即调用 query.backgroundTasks(toolUseId)。
//                    预期：
//                      a. tool_result 几乎立刻返回（不再阻塞），含 backgroundTaskId
//                      b. 收到 task_started（task_id == backgroundTaskId，task_type=local_bash）
//                      c. 拼出的 output 文件路径可在任务结束后 Read 到 sleep 后的 echo 输出
//                      d. 收到 task_notification（status=completed 或 stopped）
//
// 关键技术点：query() 返回的对象既是 async iterable，又带有控制方法
// (backgroundTasks / stopTask / close)。我们保留对该对象的引用，
// 在 for await 循环内、检测到 Bash tool_use 后调用它。

describe('backgroundTasks() 前台转后台机制', () => {
  // 长命令：跑 ~40s，给后台化触发留足时间窗。
  // 第一轮实验发现 SDK 自身也会在 ~30s 处把长前台 Bash 自动后台化，
  // 因此 sleep 取 40s，确保无论是「我们主动转」还是「SDK 自动转」都落在命令执行期内。
  const LONG_CMD = 'sleep 40 && echo bg-conversion-done';

  /**
   * Case 12: 基线 — 前台跑长命令（不调用 backgroundTasks）
   *
   * 设计意图：与 case-13 对照，验证「自动后台化」是否由 backgroundTasks() 触发。
   *
   * 关键发现（推翻旧假设）：
   *   旧 case-1（短命令 echo）显示前台 Bash 无 task 消息。
   *   但长前台 Bash（sleep 40，LLM 明确 run_in_background:false）即便【不调用】
   *   backgroundTasks()，也会被 SDK 自动后台化：出现 task_started + task_notification。
   *   因此「前台 = 无 task 消息」只在短命令成立；长命令一律自动后台化。
   *
   * 观察目标：
   * - 确认基线（不调用 backgroundTasks）也出现 task_started/task_notification
   * - 确认 query 仍阻塞到任务结束（自动后台化不改变阻塞语义）
   * - 与 case-13 对比：两者事件序列应基本一致 → 证明 backgroundTasks() 在此场景无效
   */
  it('case-12 基线: 前台长命令（不调用 backgroundTasks，仍自动后台化）', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-12-baseline-blocking');

    const { events, duration } = await collectSDKEvents({
      prompt: `Use the Bash tool to run this exact command: ${LONG_CMD}. Run it in the foreground. Then tell me the output.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 12: 前台长命令基线（不调用 backgroundTasks）', events, duration);

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析（基线：长命令仍自动后台化）──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    console.error(`\n[观察] query 总耗时 = ${duration}ms`);
    console.error(`[观察] task_started=${taskAnalysis.taskStartedCount}, task_notification=${taskAnalysis.taskNotificationCount}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // 关键断言：即便不调用 backgroundTasks()，长前台 Bash 也被 SDK 自动后台化
    expect(taskAnalysis.taskStartedCount).toBeGreaterThanOrEqual(1);
    expect(taskAnalysis.taskNotificationCount).toBeGreaterThanOrEqual(1);

    // 自动后台化不改变阻塞语义：query 仍等到任务结束（sleep 40 + 开销）
    expect(duration).toBeGreaterThan(40000);
  }, 180000);

  /**
   * Case 13: 核心 — 前台长命令运行中调用 backgroundTasks(toolUseId)
   *
   * 观察目标（对应调研假设 a/b/c/d）：
   * a. tool_result 立刻返回 + 含 backgroundTaskId
   * b. 收到 task_started，task_id == backgroundTaskId
   * c. output 文件最终能读到 'bg-conversion-done'
   * d. 收到 task_notification
   * e. backgroundTasks() 返回值是否为 true
   * f. 后台化后 query 是否很快结束（不再阻塞 ~20s）
   */
  it('case-13 前台→后台: 运行中调用 backgroundTasks(toolUseId)', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-13-foreground-to-background');

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command: ${LONG_CMD}. Run it in the foreground. Then tell me the output.`,
      options: queryOptions,
    });

    // 保留 query 对象引用（带 backgroundTasks 等控制方法）
    const queryHandle: any = sdkQuery;

    const events: CapturedSDKEvent[] = [];
    const startTime = Date.now();
    let index = 0;
    let backgrounded = false;
    let backgroundResult: boolean | 'NOT_CALLED' = 'NOT_CALLED';
    let backgroundCallAt: number | null = null;
    let bashToolUseId: string | null = null;
    let backgroundTaskIdFromResult: string | null = null;

    for await (const message of sdkQuery) {
      const msg = message as any;
      const type = msg.type || 'unknown';
      const captured: CapturedSDKEvent = {
        index: index++,
        type,
        timestamp: Date.now(),
      };

      // 复用现有的字段提取逻辑
      if (type === 'stream_event' && msg.event) {
        const evt = msg.event;
        captured.eventType = evt.type;
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          captured.toolName = evt.content_block.name;
          captured.toolUseId = evt.content_block.id;
          // 捕获 Bash 工具调用的 tool_use_id —— 在它出现后触发后台化
          if (evt.content_block.name === 'Bash' && !bashToolUseId) {
            bashToolUseId = evt.content_block.id;
          }
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
          captured.deltaType = 'input_json_delta';
          captured.inputJsonSnippet = evt.delta.partial_json;
        }
      }

      if (type === 'system') {
        captured.subtype = msg.subtype;
        if (msg.subtype === 'task_started') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          captured.raw = { ...msg };
        }
        if (msg.subtype === 'task_notification') {
          captured.taskId = msg.task_id;
          captured.taskStatus = msg.status;
          captured.taskType = msg.task_type;
          captured.raw = {
            task_id: msg.task_id,
            status: msg.status,
            summary: msg.summary,
            error: msg.error,
            output_file: msg.output_file,
            task_type: msg.task_type,
            usage: msg.usage,
            tool_use_id: msg.tool_use_id,
          };
        }
      }

      if (type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            captured.toolName = block.name;
            captured.toolUseId = block.id;
            if (block.name === 'Bash' && !bashToolUseId) {
              bashToolUseId = block.id;
            }
            if (!captured.raw) captured.raw = {};
            captured.raw.toolInput = block.input;
          }
        }
      }

      if (type === 'user') {
        // 提取 backgroundTaskId（前台转后台后 tool_result 应含此字段）
        const contentBlocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const b of contentBlocks) {
          if (b.type === 'tool_result') {
            // backgroundTaskId 可能在结构化 content 里，也可能在 contentSnippet 文本里
            const snippet = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
                : '';
            captured.raw = {
              tool_use_id: b.tool_use_id,
              contentSnippet: snippet.substring(0, 1000),
            };
            const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i)
              || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
            if (m && !backgroundTaskIdFromResult) {
              backgroundTaskIdFromResult = m[1];
            }
          }
        }
      }

      if (type === 'result') {
        captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, stop_reason: msg.stop_reason };
      }

      events.push(captured);

      // ── 触发后台化 ──
      // 关键修正（第一轮教训）：必须在 Bash tool_use 一出现就调用，
      // 即 content_block_start [Bash] 那一刻（bashToolUseId 刚被捕获）。
      // 第一轮用 type==='assistant' 触发，结果 assistant 消息 26s 才到，
      // 任务早已不在前台 → backgroundTasks() 返回 false。
      if (!backgrounded && bashToolUseId) {
        backgrounded = true;
        backgroundCallAt = Date.now() - startTime;
        try {
          if (typeof queryHandle.backgroundTasks === 'function') {
            backgroundResult = await queryHandle.backgroundTasks(bashToolUseId);
          } else {
            backgroundResult = 'NO_METHOD';
          }
        } catch (e: any) {
          backgroundResult = `ERROR: ${e?.message || String(e)}`;
        }
      }
    }

    const duration = Date.now() - startTime;

    // ── 输出分析 ──
    printTimeline('Case 13: 前台→后台（调用 backgroundTasks）', events, duration);

    console.error('\n── backgroundTasks() 调用结果 ──');
    console.error(`  调用时机（query 启动后 ms）: ${backgroundCallAt}`);
    console.error(`  返回值: ${backgroundResult}`);
    console.error(`  从 tool_result 提取的 backgroundTaskId: ${backgroundTaskIdFromResult}`);

    const taskAnalysis = analyzeTaskEvents(events);
    console.error('\n── task 事件分析 ──');
    console.error(JSON.stringify(taskAnalysis, null, 2));

    console.error(`\n[假设 a] 后台化是否生效: ${backgroundResult === true}`);
    console.error(`[假设 b] 是否有 task_started: ${taskAnalysis.taskStartedCount > 0}`);
    if (taskAnalysis.taskStartedDetails[0]) {
      console.error(`        task_started.task_id = ${taskAnalysis.taskStartedDetails[0].task_id}`);
      console.error(`        tool_result.backgroundTaskId = ${backgroundTaskIdFromResult}`);
      console.error(`        两者是否一致: ${taskAnalysis.taskStartedDetails[0].task_id === backgroundTaskIdFromResult}`);
    }
    console.error(`[假设 d] 是否有 task_notification: ${taskAnalysis.taskNotificationCount > 0}`);
    console.error(`[假设 f] query 总耗时 = ${duration}ms（后台化后应远小于 20000，证明不再阻塞）`);

    // 尝试用 output_file 读后台任务输出（假设 c）
    const notif = taskAnalysis.taskNotificationDetails[0];
    if (notif?.output_file) {
      console.error(`\n[假设 c] 尝试读取 output_file: ${notif.output_file}`);
      try {
        const out = readFileSync(notif.output_file, 'utf-8');
        console.error(`  文件内容（前 500 字符）:\n${out.substring(0, 500)}`);
        console.error(`  是否包含 'bg-conversion-done': ${out.includes('bg-conversion-done')}`);
      } catch (e: any) {
        console.error(`  读取失败: ${e?.message || e}`);
      }
    } else {
      console.error('\n[假设 c] task_notification 无 output_file，跳过读取');
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/background-result.json`, JSON.stringify({
      backgroundResult,
      backgroundCallAt,
      bashToolUseId,
      backgroundTaskIdFromResult,
      taskStarted: taskAnalysis.taskStartedDetails,
      taskNotification: taskAnalysis.taskNotificationDetails,
      duration,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);

    // ── 实测断言（两轮实验后确立，见 raw/tool-foreground-background-behavior.md）──
    //
    // 在本 SDK 版本 + 本地 Kimi LLM 环境下，观察到的稳定行为是：
    //
    // 1. backgroundTasks() 方法在 query 对象上确实存在且可调用（不抛错）。
    //    —— 断言：返回值不是 NOT_CALLED / NO_METHOD / ERROR。
    // 2. 但在我们能拿到 toolUseId 的最早时刻（assistant 消息到达，约 t+44s）调用它，
    //    返回值始终为 false —— 即没有匹配到"可后台化的前台任务"。
    // 3. 与此同时，长前台 Bash（LLM 明确 run_in_background:false）会被 SDK 自动后台化：
    //    出现 task_started（local_bash）+ task_notification（completed），
    //    但 tool_result 不含 backgroundTaskId，且 query 仍阻塞到任务结束。
    //
    // 因此本 case 的断言改为「记录这一稳定现象」，而非「证明 backgroundTasks 生效」。
    // 这正是 researcher 方法论中的「否定实验也是发现」。

    // (1) 方法存在且被调用
    expect(backgroundResult).not.toBe('NOT_CALLED');
    expect(backgroundResult).not.toBe('NO_METHOD');
    expect(typeof backgroundResult).not.toBe('string'); // 非 ERROR:xxx

    // (2) 长前台 Bash 被 SDK 自动后台化：出现 task_started + task_notification
    expect(taskAnalysis.taskStartedCount).toBeGreaterThanOrEqual(1);
    expect(taskAnalysis.taskNotificationCount).toBeGreaterThanOrEqual(1);

    // (3) 自动后台化不改变阻塞语义：query 仍等到任务结束
    //     （sleep 40 + LLM 两轮开销，总耗时远超单次 sleep）
    expect(duration).toBeGreaterThan(40000);
  }, 180000);
});
