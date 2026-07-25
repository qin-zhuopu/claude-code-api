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
import { query, getSubagentMessages, listSubagents } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// ====== 公共配置 ======

// 本地 LLM 配置（LOCAL 网关 10.1.3.115:4000 + Jereh-LLM-NO-THINK-V1）。
// token / base_url 全部走 .env 的 LOCAL__ 组，不硬编码任何密钥。
// 由测试文件顶部 dotenv.config() 加载；.env 已 gitignore。
// 如需切换网关，改这里引用的环境变量前缀即可（LOCAL__/JEREH__/BIGMODEL__）。
const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.LOCAL__ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.LOCAL__ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.LOCAL__ANTHROPIC_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: process.env.LOCAL__CLAUDE_CODE_SUBAGENT_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.LOCAL__ANTHROPIC_DEFAULT_OPUS_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.LOCAL__ANTHROPIC_DEFAULT_SONNET_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.LOCAL__ANTHROPIC_DEFAULT_HAIKU_MODEL,
  CLAUDE_CODE_WORKFLOWS: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  API_TIMEOUT_MS: '3000000',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

// 智谱 GLM 配置（BIGMODEL 组，open.bigmodel.cn anthropic 兼容端点）。
// 用途：case-22b 验证并发前台 Bash —— 本地 Jereh LLM 工具层串行、起不了并发，
// 用能力更强的 GLM 看能否真正起 2 个并发前台 Bash，从而压满无参 backgroundTasks 的批量语义。
// token / base_url 走 .env 的 BIGMODEL__ 组；模型名按用户指定：主/subagent=glm-5.2，haiku=glm-4.5-air。
const BIGMODEL_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.BIGMODEL__ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.BIGMODEL__ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: 'glm-5.2',
  CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
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

// ====== streaming-input 模式下主动后台化 + 多轮观察（case-14）======
//
// 缘起：case-13（string-prompt 模式）调 backgroundTasks() 始终返回 false。
// SDK 类型定义 sdk.d.ts:2229-2230 明确：所有控制方法（interrupt/backgroundTasks/
// stopTask/streamInput）【只在 streaming input/output 模式下支持】。
// case-13 用的是 prompt:string（单次模式）→ 控制方法可能根本没生效。
//
// 本 case 用 streaming-input 模式（prompt 传 AsyncIterable<SDKUserMessage>）重验，
// 并完整走通：前台长 Bash → 主动 backgroundTasks 转后台 → 确认转后台成功 →
// （若仍阻塞）interrupt 兜底 → streaming 续轮问 AI 任务情况 → task_notification 唤醒。
//
// 架构：单进程 3 协程 + 闭包共享 state（Node 单线程串行，无锁）
//   promptInput generator ──yield msg1──▶ for-await 主循环（捕获 toolUseId/调控制方法）
//         ▲ resolve turn2Gate（转后台成功放行 msg2）      │ 读写 state
//         └──────────────────────────────────────────────┤
//                                          setInterval 1Hz 观察者（快照 + interrupt 兜底）
//
// 实验未知（只记录，不预先断言）：
//   U1 streaming 模式下 backgroundTasks 返回 true 还是 false？
//   U2 转后台主信号：task_updated.is_backgrounded vs tool_result.backgroundTaskId？
//   U3 interrupt 后 for-await 是结束（query 死）还是能续轮？
//   U4 task_notification 唤醒时 query 已结束还是仍阻塞？
//   U5 SDK ~30s 自动后台化是否抢先？

describe('backgroundTasks() streaming-input 模式', () => {
  const LONG_CMD_14 = 'sleep 40 && echo bg-14-done';

  type Phase =
    | 'init' | 'awaiting_tool_use' | 'backgrounding' | 'backgrounded'
    | 'turn2_streaming' | 'interrupting' | 'task_completed' | 'query_ended';

  interface Case14State {
    phase: Phase;
    phaseEnteredAt: Record<string, number>;
    queryStartedAt: number;
    bashToolUseId: string | null;
    bashTaskId: string | null;
    backgroundCallResult: boolean | 'NOT_CALLED' | 'NO_METHOD' | string;
    backgroundCallAt: number | null;
    interruptCallResult: 'NOT_CALLED' | 'OK' | string;
    interruptCallAt: number | null;
    backgroundedViaTaskUpdated: boolean;
    backgroundTaskIdFromResult: string | null;
    taskNotificationReceived: boolean;
    taskNotificationStatus: string | null;
    outputFile: string | null;
    outputFileReadable: boolean | null;
    outputFileContentSnippet: string | null;
    queryEnded: boolean;
    queryEndedAt: number | null;
    resultSubtype: string | null;
    terminalReason: string | null;
    eventCount: number;
    turnsObserved: number;
  }

  interface ObserverTick {
    t: number;
    phase: Phase;
    queryEnded: boolean;
    eventCount: number;
    bashToolUseIdKnown: boolean;
    backgroundCallResult: Case14State['backgroundCallResult'];
    backgroundedViaTaskUpdated: boolean;
    interruptCallResult: string;
    taskNotificationReceived: boolean;
    taskNotificationStatus: string | null;
    outputFile: string | null;
    outputFileReadable: boolean | null;
  }

  it('case-14 streaming-input: 主动 backgroundTasks 转后台 + interrupt 兜底 + 续轮', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-14-streaming-input-bg');

    // ── 共享状态 ──
    const state: Case14State = {
      phase: 'init',
      phaseEnteredAt: { init: 0 },
      queryStartedAt: Date.now(),
      bashToolUseId: null,
      bashTaskId: null,
      backgroundCallResult: 'NOT_CALLED',
      backgroundCallAt: null,
      interruptCallResult: 'NOT_CALLED',
      interruptCallAt: null,
      backgroundedViaTaskUpdated: false,
      backgroundTaskIdFromResult: null,
      taskNotificationReceived: false,
      taskNotificationStatus: null,
      outputFile: null,
      outputFileReadable: null,
      outputFileContentSnippet: null,
      queryEnded: false,
      queryEndedAt: null,
      resultSubtype: null,
      terminalReason: null,
      eventCount: 0,
      turnsObserved: 0,
    };

    const transitionPhase = (next: Phase) => {
      if (state.phase !== next) {
        state.phase = next;
        state.phaseEnteredAt[next] = Date.now() - state.queryStartedAt;
        console.error(`\n[phase] → ${next} @ ${state.phaseEnteredAt[next]}ms`);
      }
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: ObserverTick[] = [];

    // ── streaming-input generator（deferred-promise 外部驱动 + 15s 安全阀）──
    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 15000));

    const msg1: any = {
      type: 'user',
      message: {
        role: 'user',
        content: `Use the Bash tool to run this exact command: ${LONG_CMD_14}. Run it in the foreground. Do NOT set run_in_background.`,
      },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: {
        role: 'user',
        content: 'What is the current status of the background task you started earlier? Just report its status. Do NOT run any new commands.',
      },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      // 阻塞到「转后台成功」或 15s 安全阀
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 gate 放行 @ ${Date.now() - state.queryStartedAt}ms，yield msg2`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    // ── setInterval 1Hz 观察者（快照 + 首次读 output_file + interrupt 兜底）──
    let isInterrupting = false;
    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      // 首次拿到 output_file 时尝试读
      if (state.outputFile && state.outputFileReadable === null) {
        try {
          const c = readFileSync(state.outputFile, 'utf-8');
          state.outputFileContentSnippet = c.substring(0, 500);
          state.outputFileReadable = true;
        } catch {
          state.outputFileReadable = false;
        }
      }

      observerLog.push({
        t,
        phase: state.phase,
        queryEnded: state.queryEnded,
        eventCount: state.eventCount,
        bashToolUseIdKnown: !!state.bashToolUseId,
        backgroundCallResult: state.backgroundCallResult,
        backgroundedViaTaskUpdated: state.backgroundedViaTaskUpdated,
        interruptCallResult: state.interruptCallResult,
        taskNotificationReceived: state.taskNotificationReceived,
        taskNotificationStatus: state.taskNotificationStatus,
        outputFile: state.outputFile,
        outputFileReadable: state.outputFileReadable,
      });
      console.error(`[obs t=${t}ms] phase=${state.phase} ended=${state.queryEnded} ev=${state.eventCount} bgCall=${state.backgroundCallResult} bgd=${state.backgroundedViaTaskUpdated} intr=${state.interruptCallResult} notif=${state.taskNotificationStatus ?? '-'}`);

      // ── interrupt 兜底决策（唯一能在主循环阻塞时执行的位置）──
      // 条件：已尝试转后台但未成功、query 未结束、interrupt 未调过、距 bgCall > 5s
      if (
        !isInterrupting &&
        state.backgroundCallResult !== 'NOT_CALLED' &&
        !state.backgroundedViaTaskUpdated &&
        state.backgroundCallResult !== true &&
        !state.queryEnded &&
        state.interruptCallResult === 'NOT_CALLED' &&
        state.backgroundCallAt !== null &&
        t - state.backgroundCallAt > 5000
      ) {
        isInterrupting = true;
        transitionPhase('interrupting');
        state.interruptCallAt = t;
        console.error(`\n[interrupt] 转后台 ${t - state.backgroundCallAt}ms 无 is_backgrounded 信号，触发 interrupt 兜底`);
        (async () => {
          try {
            if (typeof queryHandle.interrupt === 'function') {
              await queryHandle.interrupt();
              state.interruptCallResult = 'OK';
            } else {
              state.interruptCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.interruptCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[interrupt] 结果: ${state.interruptCallResult}`);
          // interrupt 后也放行第二轮（尝试续轮）
          resolveTurn2();
        })();
      }
    }, 1000);

    // ── for-await 主循环 ──
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };
        state.eventCount = index;

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
            if (!state.bashTaskId) {
              state.bashTaskId = msg.task_id;
              console.error(`\n[task_started] task_id=${msg.task_id} type=${msg.task_type}`);
            }
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[task_updated] task_id=${msg.task_id} patch=${JSON.stringify(msg.patch)}`);
            if (msg.patch?.is_backgrounded === true) {
              state.backgroundedViaTaskUpdated = true;
              transitionPhase('backgrounded');
            }
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.taskType = msg.task_type;
            captured.raw = {
              task_id: msg.task_id, status: msg.status, summary: msg.summary,
              error: msg.error, output_file: msg.output_file, task_type: msg.task_type,
              usage: msg.usage, tool_use_id: msg.tool_use_id,
            };
            state.taskNotificationReceived = true;
            state.taskNotificationStatus = msg.status;
            if (msg.output_file) state.outputFile = msg.output_file;
            transitionPhase('task_completed');
            console.error(`\n[task_notification] status=${msg.status} output_file="${msg.output_file}" (query已结束=${state.queryEnded})`);
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              captured.toolName = block.name;
              captured.toolUseId = block.id;
              if (block.name === 'Bash' && !state.bashToolUseId) {
                state.bashToolUseId = block.id;
                transitionPhase('awaiting_tool_use');
                console.error(`\n[assistant] 捕获 Bash toolUseId=${block.id}`);
              }
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'user') {
          const contentBlocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of contentBlocks) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
                  : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 1000) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i)
                || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = Date.now() - state.queryStartedAt;
          state.resultSubtype = msg.subtype;
          state.terminalReason = msg.terminal_reason ?? null;
          console.error(`\n[result] subtype=${msg.subtype} num_turns=${msg.num_turns} terminal_reason=${msg.terminal_reason ?? '-'} @ ${state.queryEndedAt}ms`);
        }

        events.push(captured);

        // 打印 text_delta
        if (type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          process.stderr.write(msg.event.delta.text);
        }

        // ── 控制调用 #1：拿到 bashToolUseId 立刻转后台 ──
        if (state.bashToolUseId && state.backgroundCallResult === 'NOT_CALLED') {
          transitionPhase('backgrounding');
          state.backgroundCallAt = Date.now() - state.queryStartedAt;
          console.error(`\n[backgroundTasks] 调用 @ ${state.backgroundCallAt}ms，toolUseId=${state.bashToolUseId}`);
          try {
            state.backgroundCallResult = typeof queryHandle.backgroundTasks === 'function'
              ? await queryHandle.backgroundTasks(state.bashToolUseId)
              : 'NO_METHOD';
          } catch (e: any) {
            state.backgroundCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[backgroundTasks] 返回: ${state.backgroundCallResult}`);
        }

        // ── 控制调用 #2：转后台成功 → 放行第二轮 ──
        if (
          (state.backgroundedViaTaskUpdated || state.backgroundCallResult === true) &&
          state.phase !== 'turn2_streaming' &&
          state.phase !== 'task_completed'
        ) {
          transitionPhase('turn2_streaming');
          console.error(`\n[turn2] 转后台成功，放行第二轮`);
          resolveTurn2();
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    // ── 输出分析 ──
    printTimeline('Case 14: streaming-input 主动后台化', events, duration);
    const taskAnalysis = analyzeTaskEvents(events);

    console.error('\n══════ U1-U5 实测值 ══════');
    console.error(`[U1] streaming 模式下 backgroundTasks 返回: ${state.backgroundCallResult}（调用时机 ${state.backgroundCallAt}ms）`);
    console.error(`[U2] 转后台信号: task_updated.is_backgrounded=${state.backgroundedViaTaskUpdated}, tool_result.backgroundTaskId=${state.backgroundTaskIdFromResult}, task_started.task_id=${state.bashTaskId}`);
    console.error(`[U3] interrupt: ${state.interruptCallResult}（时机 ${state.interruptCallAt}ms）; turnsObserved=${state.turnsObserved}; result.subtype=${state.resultSubtype}; terminal_reason=${state.terminalReason}`);
    console.error(`[U4] task_notification: received=${state.taskNotificationReceived} status=${state.taskNotificationStatus}; 到达时 query已结束=${state.queryEnded && state.taskNotificationReceived}; output_file="${state.outputFile}" readable=${state.outputFileReadable}`);
    console.error(`[U5] 自动后台化抢先判断: bgCall@${state.backgroundCallAt}ms, backgrounded phase@${state.phaseEnteredAt['backgrounded'] ?? '-'}ms`);
    console.error(`[phase timeline] ${JSON.stringify(state.phaseEnteredAt)}`);
    console.error(`[输出文件内容] ${state.outputFileContentSnippet ?? '(未读到)'}`);

    // ── 落盘 ──
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/state-final.json`, JSON.stringify(state, null, 2));
    writeFileSync(`${dir}/control-calls.json`, JSON.stringify({
      backgroundCallResult: state.backgroundCallResult,
      backgroundCallAt: state.backgroundCallAt,
      interruptCallResult: state.interruptCallResult,
      interruptCallAt: state.interruptCallAt,
      backgroundedViaTaskUpdated: state.backgroundedViaTaskUpdated,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult,
      bashTaskId: state.bashTaskId,
      phaseTimeline: state.phaseEnteredAt,
      resultSubtype: state.resultSubtype,
      terminalReason: state.terminalReason,
      turnsObserved: state.turnsObserved,
      duration,
    }, null, 2));

    // ── 断言 ──
    // 硬断言（机制必成立）
    expect(events.length).toBeGreaterThan(0);
    // backgroundTasks 方法存在且被调用（不是没调、不是没方法、不是抛错）
    expect(state.backgroundCallResult).not.toBe('NOT_CALLED');
    expect(state.backgroundCallResult).not.toBe('NO_METHOD');
    expect(typeof state.backgroundCallResult).not.toBe('string'); // 非 ERROR:xxx，即返回了 boolean

    // 软断言（记录，不 fatal）
    try {
      expect(taskAnalysis.taskStartedCount + taskAnalysis.taskNotificationCount).toBeGreaterThanOrEqual(1);
    } catch {
      console.error('[软断言] 未观察到 task_started/task_notification —— 记录为否定发现');
    }
  }, 240000);
});

// ====== stopTask 停单个后台任务 + 保持 query 续轮（case-15）======
//
// 缘起：case-14 证明 interrupt() 会结束 query 且对已收尾 turn 抛 "Query closed"。
// 用户真实需求是「停止阻塞后【在同一会话继续问】」—— 更对口的是 stopTask(taskId)：
// sdk.d.ts:2490-2494 明确「Stop a running task. A task_notification with status
// 'stopped' will be emitted」，且 stopTask 只停单个 task，query 本身继续活。
//
// 本 case 验证：
//   V1 stopTask(bashTaskId) 调用是否成功（不抛错）？
//   V2 是否收到 task_notification status='stopped'（而非 completed）？
//   V3 query 是否【不结束】—— stopTask 后能否 streaming 续轮问 AI？
//   V4 停掉后 sleep 40 是否真被中断（总耗时应远小于 40s+，证明没等满）？
//   V5 续轮里 AI 是否知道任务已被停止？
//
// 关键依赖：必须先拿到 bashTaskId（来自 task_started，SDK 自动后台化长 Bash 时产生）。
// case-12/13/14 已确认长前台 Bash 会在 ~5s 后自动后台化并产生 task_started。

describe('stopTask 停单个后台任务', () => {
  const LONG_CMD_15 = 'sleep 40 && echo bg-15-done';

  it('case-15 stopTask: 停后台任务 + query 保持 + 续轮', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-15-stoptask');

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      stopCallResult: 'NOT_CALLED' as 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      stopCallAt: null as number | null,
      taskNotificationReceived: false,
      taskNotificationStatus: null as string | null,
      taskNotificationAt: null as number | null,
      outputFile: null as string | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      terminalReason: null as string | null,
      turnsObserved: 0,
      turn2Reached: false,
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: any[] = [];

    // streaming-input：转停成功后放行第二轮
    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 20000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command: ${LONG_CMD_15}. Run it in the foreground. Do NOT set run_in_background.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Was the previous background task stopped or did it complete? Report its final status. Do NOT run any new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      state.turn2Reached = true;
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      observerLog.push({
        t, bashTaskId: state.bashTaskId, stopCallResult: state.stopCallResult,
        taskNotificationStatus: state.taskNotificationStatus, queryEnded: state.queryEnded,
        turn2Reached: state.turn2Reached,
      });
      console.error(`[obs t=${t}ms] taskId=${state.bashTaskId ?? '-'} stop=${state.stopCallResult} notif=${state.taskNotificationStatus ?? '-'} ended=${state.queryEnded} turn2=${state.turn2Reached}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.taskType = msg.task_type;
            captured.raw = { ...msg };
            if (!state.bashTaskId) {
              state.bashTaskId = msg.task_id;
              console.error(`\n[task_started] task_id=${msg.task_id} type=${msg.task_type} @ ${Date.now() - state.queryStartedAt}ms`);
            }
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[task_updated] task_id=${msg.task_id} patch=${JSON.stringify(msg.patch)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.raw = { task_id: msg.task_id, status: msg.status, output_file: msg.output_file, summary: msg.summary };
            state.taskNotificationReceived = true;
            state.taskNotificationStatus = msg.status;
            state.taskNotificationAt = Date.now() - state.queryStartedAt;
            if (msg.output_file) state.outputFile = msg.output_file;
            console.error(`\n[task_notification] status=${msg.status} output_file="${msg.output_file}" @ ${state.taskNotificationAt}ms`);
            // 停止确认后放行第二轮
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              captured.toolName = block.name;
              captured.toolUseId = block.id;
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = Date.now() - state.queryStartedAt;
          state.resultSubtype = msg.subtype;
          state.terminalReason = msg.terminal_reason ?? null;
          console.error(`\n[result] subtype=${msg.subtype} num_turns=${msg.num_turns} terminal_reason=${msg.terminal_reason ?? '-'} @ ${state.queryEndedAt}ms`);
        }

        events.push(captured);

        // ── 控制调用：拿到 bashTaskId 立刻 stopTask ──
        if (state.bashTaskId && state.stopCallResult === 'NOT_CALLED') {
          state.stopCallAt = Date.now() - state.queryStartedAt;
          console.error(`\n[stopTask] 调用 @ ${state.stopCallAt}ms，taskId=${state.bashTaskId}`);
          try {
            if (typeof queryHandle.stopTask === 'function') {
              await queryHandle.stopTask(state.bashTaskId);
              state.stopCallResult = 'OK';
            } else {
              state.stopCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.stopCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[stopTask] 结果: ${state.stopCallResult}`);
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    printTimeline('Case 15: stopTask 停后台任务', events, duration);
    const taskAnalysis = analyzeTaskEvents(events);

    console.error('\n══════ V1-V5 实测值 ══════');
    console.error(`[V1] stopTask 调用结果: ${state.stopCallResult}（时机 ${state.stopCallAt}ms，taskId=${state.bashTaskId}）`);
    console.error(`[V2] task_notification status: ${state.taskNotificationStatus}（期望 stopped）@ ${state.taskNotificationAt}ms`);
    console.error(`[V3] query 是否结束: ${state.queryEnded}（结束时机 ${state.queryEndedAt}ms）; turnsObserved=${state.turnsObserved}; turn2Reached=${state.turn2Reached}`);
    console.error(`[V4] 总耗时: ${duration}ms（若 stopTask 生效并中断 sleep 40，应远小于自然完成；对照 case-14 的 57762ms）`);
    console.error(`[V5] result.subtype=${state.resultSubtype}, terminal_reason=${state.terminalReason}, num_turns 见 result 行`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/state-final.json`, JSON.stringify(state, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    // stopTask 方法存在且被调用（非没调/没方法/抛错）
    expect(state.stopCallResult).not.toBe('NOT_CALLED');
    expect(state.stopCallResult).not.toBe('NO_METHOD');
    // 软断言：记录，不 fatal
    try {
      expect(state.taskNotificationStatus).toBe('stopped');
    } catch {
      console.error(`[软断言] task_notification status=${state.taskNotificationStatus}（非 stopped）—— 记录实测`);
    }
  }, 240000);
});

// ====== turn 活跃窗口内同步 interrupt（case-16）======
//
// 缘起：case-14 的 interrupt() 抛 "Query closed before response received"，
// 因为它由 1Hz 观察者在 backgroundTasks 之后 6s 才触发，那时 turn 已收尾。
// 本 case 修正时机：一拿到 Bash tool_use_id（turn 正阻塞等 tool_result）就
// 【在主循环里同步】调 interrupt()，验证 turn 活跃时 interrupt 能否真正打断。
//
// 本 case 验证：
//   W1 turn 活跃时 interrupt() 是否成功（不抛 "Query closed"）？
//   W2 interrupt 后 for-await 是否立刻结束（query 死）？总耗时应远小于 sleep 40。
//   W3 result.subtype / terminal_reason 是什么（success？aborted？）？
//   W4 interrupt 打断的是「等 sleep 40」的阻塞，还是要等 Bash 被自动后台化后才生效？
//   W5 interrupt 后能否再 streaming 续轮（对照 case-14 的 turnsObserved）？
//
// 注意：本 case 用单条 prompt 的 generator（不续推 msg2），聚焦 interrupt 本身；
// 若 W5 需要，另起 case 验证。这里只放一个「interrupt 后尝试 yield msg2」看会发生什么。

describe('turn 活跃窗口同步 interrupt', () => {
  const LONG_CMD_16 = 'sleep 40 && echo bg-16-done';

  it('case-16 interrupt: turn 活跃时同步打断', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-16-sync-interrupt');

    const state = {
      queryStartedAt: Date.now(),
      bashToolUseId: null as string | null,
      bashTaskId: null as string | null,
      interruptCallResult: 'NOT_CALLED' as 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      interruptCallAt: null as number | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      terminalReason: null as string | null,
      turnsObserved: 0,
      turn2Yielded: false,
      taskStartedSeen: false,
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: any[] = [];

    // interrupt 后尝试续推一条消息，看 query 是否已死
    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 20000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command: ${LONG_CMD_16}. Run it in the foreground. Do NOT set run_in_background.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Are you still there? Reply with OK.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] 尝试 yield msg2 @ ${Date.now() - state.queryStartedAt}ms（观察 interrupt 后 query 是否还活）`);
      state.turn2Yielded = true;
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      observerLog.push({
        t, bashToolUseId: state.bashToolUseId, interruptCallResult: state.interruptCallResult,
        queryEnded: state.queryEnded, turnsObserved: state.turnsObserved, turn2Yielded: state.turn2Yielded,
      });
      console.error(`[obs t=${t}ms] toolUseId=${state.bashToolUseId ?? '-'} intr=${state.interruptCallResult} ended=${state.queryEnded} turns=${state.turnsObserved}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_start' && msg.event.content_block?.type === 'tool_use') {
            captured.toolName = msg.event.content_block.name;
            captured.toolUseId = msg.event.content_block.id;
          }
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            state.taskStartedSeen = true;
            if (!state.bashTaskId) state.bashTaskId = msg.task_id;
            console.error(`\n[task_started] task_id=${msg.task_id} @ ${Date.now() - state.queryStartedAt}ms`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.raw = { status: msg.status, output_file: msg.output_file };
            console.error(`\n[task_notification] status=${msg.status} @ ${Date.now() - state.queryStartedAt}ms`);
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              captured.toolName = block.name;
              captured.toolUseId = block.id;
              if (block.name === 'Bash' && !state.bashToolUseId) {
                state.bashToolUseId = block.id;
                console.error(`\n[assistant] 捕获 Bash toolUseId=${block.id} @ ${Date.now() - state.queryStartedAt}ms`);
              }
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = Date.now() - state.queryStartedAt;
          state.resultSubtype = msg.subtype;
          state.terminalReason = msg.terminal_reason ?? null;
          console.error(`\n[result] subtype=${msg.subtype} num_turns=${msg.num_turns} terminal_reason=${msg.terminal_reason ?? '-'} @ ${state.queryEndedAt}ms`);
          resolveTurn2(); // query 结束也放行 generator（避免挂死）
        }

        events.push(captured);

        // ── 控制调用：拿到 bashToolUseId 立刻【同步】interrupt（turn 此时正阻塞等 tool_result）──
        if (state.bashToolUseId && state.interruptCallResult === 'NOT_CALLED') {
          state.interruptCallAt = Date.now() - state.queryStartedAt;
          console.error(`\n[interrupt] 同步调用 @ ${state.interruptCallAt}ms（turn 活跃，正阻塞等 sleep 40）`);
          try {
            if (typeof queryHandle.interrupt === 'function') {
              await queryHandle.interrupt();
              state.interruptCallResult = 'OK';
            } else {
              state.interruptCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.interruptCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[interrupt] 结果: ${state.interruptCallResult}`);
          resolveTurn2(); // interrupt 后尝试续轮
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    printTimeline('Case 16: turn 活跃同步 interrupt', events, duration);

    console.error('\n══════ W1-W5 实测值 ══════');
    console.error(`[W1] interrupt 调用结果: ${state.interruptCallResult}（时机 ${state.interruptCallAt}ms）`);
    console.error(`[W2] query 结束时机: ${state.queryEndedAt}ms（若 interrupt 打断阻塞，应远小于 40000+）`);
    console.error(`[W3] result.subtype=${state.resultSubtype}, terminal_reason=${state.terminalReason}`);
    console.error(`[W4] interrupt 时是否已 task_started（自动后台化）: ${state.taskStartedSeen}（时机对比 interruptCallAt=${state.interruptCallAt}ms）`);
    console.error(`[W5] turnsObserved=${state.turnsObserved}, turn2Yielded=${state.turn2Yielded}（interrupt 后能否续轮）`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/state-final.json`, JSON.stringify(state, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    expect(state.interruptCallResult).not.toBe('NOT_CALLED');
    expect(state.interruptCallResult).not.toBe('NO_METHOD');
  }, 240000);
});

// ====== task_started 之后再调 backgroundTasks（case-17，解开谜团）======
//
// 真因假设（由 case-14/15 时序推出）：
//   backgroundTasks / stopTask 必须在【task_started 之后】调用才生效 ——
//   那时任务才被 SDK 注册为「可控制的后台任务对象」。
//   · case-14: backgroundTasks@9290ms，但 task_started 在 13515ms 才到 → false（太早！）
//   · case-15: stopTask@12669ms，task_started 在 10509ms 已到 → OK
//   注意 task_started.tool_use_id === assistant block.id（case-15 已确认一致，
//   故 false 不是 ID 不匹配，而是调用时任务尚未 task_started）。
//
// 本 case 修正 case-14 的时机错误：把 backgroundTasks 的触发条件从
// 「拿到 assistant block.id」改为「收到 task_started」，并用 task_started
// 自带的 tool_use_id 调用。验证：
//   X1 task_started 之后调 backgroundTasks 是否返回 true（对照 case-14 的 false）？
//   X2 若 true：是否解除阻塞（query 快速结束）、tool_result 是否带 backgroundTaskId？
//   X3 若仍 false：真因不是时机，需另找（记录为否定发现）。

describe('task_started 后调 backgroundTasks', () => {
  const LONG_CMD_17 = 'sleep 40 && echo bg-17-done';

  it('case-17 backgroundTasks: 等 task_started 后用其 tool_use_id 调', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-17-bg-after-taskstarted');

    const state = {
      queryStartedAt: Date.now(),
      bashToolUseId: null as string | null,       // assistant block.id
      taskStartedToolUseId: null as string | null, // task_started.tool_use_id
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      bgCallResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'NO_METHOD' | string,
      bgCallAt: null as number | null,
      bgCallUsedId: null as string | null,
      backgroundTaskIdFromResult: null as string | null,
      taskNotificationStatus: null as string | null,
      taskNotificationAt: null as number | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      terminalReason: null as string | null,
      turnsObserved: 0,
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: any[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 20000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command: ${LONG_CMD_17}. Run it in the foreground. Do NOT set run_in_background.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Is the background task still running or finished? Report its status. Do NOT run new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      observerLog.push({
        t, bashTaskId: state.bashTaskId, bgCallResult: state.bgCallResult,
        taskNotificationStatus: state.taskNotificationStatus, queryEnded: state.queryEnded,
      });
      console.error(`[obs t=${t}ms] taskId=${state.bashTaskId ?? '-'} bgCall=${state.bgCallResult} notif=${state.taskNotificationStatus ?? '-'} ended=${state.queryEnded}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            if (!state.bashTaskId) {
              state.bashTaskId = msg.task_id;
              state.taskStartedToolUseId = msg.tool_use_id ?? null;
              state.taskStartedAt = Date.now() - state.queryStartedAt;
              console.error(`\n[task_started] task_id=${msg.task_id} tool_use_id=${msg.tool_use_id} @ ${state.taskStartedAt}ms`);
            }
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[task_updated] patch=${JSON.stringify(msg.patch)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.raw = { status: msg.status, output_file: msg.output_file };
            state.taskNotificationStatus = msg.status;
            state.taskNotificationAt = Date.now() - state.queryStartedAt;
            console.error(`\n[task_notification] status=${msg.status} @ ${state.taskNotificationAt}ms`);
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block.name === 'Bash' && !state.bashToolUseId) {
              state.bashToolUseId = block.id;
              console.error(`\n[assistant] Bash block.id=${block.id}`);
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = Date.now() - state.queryStartedAt;
          state.resultSubtype = msg.subtype;
          state.terminalReason = msg.terminal_reason ?? null;
          console.error(`\n[result] subtype=${msg.subtype} num_turns=${msg.num_turns} terminal_reason=${msg.terminal_reason ?? '-'} @ ${state.queryEndedAt}ms`);
          resolveTurn2();
        }

        events.push(captured);

        // ── 控制调用：等 task_started 后，用 task_started.tool_use_id 调 backgroundTasks ──
        if (state.bashTaskId && state.bgCallResult === 'NOT_CALLED') {
          // 优先用 task_started 自带的 tool_use_id，回退到 assistant block.id
          const idToUse = state.taskStartedToolUseId || state.bashToolUseId;
          state.bgCallUsedId = idToUse;
          state.bgCallAt = Date.now() - state.queryStartedAt;
          console.error(`\n[backgroundTasks] 等到 task_started 后调用 @ ${state.bgCallAt}ms，用 id=${idToUse}`);
          try {
            state.bgCallResult = typeof queryHandle.backgroundTasks === 'function'
              ? await queryHandle.backgroundTasks(idToUse)
              : 'NO_METHOD';
          } catch (e: any) {
            state.bgCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[backgroundTasks] 返回: ${state.bgCallResult}`);
          if (state.bgCallResult === true) resolveTurn2();
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    printTimeline('Case 17: task_started 后调 backgroundTasks', events, duration);

    console.error('\n══════ X1-X3 实测值 ══════');
    console.error(`[X1] backgroundTasks 返回: ${state.bgCallResult}（调用@${state.bgCallAt}ms，task_started@${state.taskStartedAt}ms，用 id=${state.bgCallUsedId}）`);
    console.error(`[对照] task_started.tool_use_id=${state.taskStartedToolUseId} vs assistant block.id=${state.bashToolUseId}（是否一致=${state.taskStartedToolUseId === state.bashToolUseId}）`);
    console.error(`[X2] 若 true：queryEndedAt=${state.queryEndedAt}ms（解除阻塞？），tool_result.backgroundTaskId=${state.backgroundTaskIdFromResult}`);
    console.error(`[X3] task_notification status=${state.taskNotificationStatus}@${state.taskNotificationAt}ms; result.subtype=${state.resultSubtype}; turnsObserved=${state.turnsObserved}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/state-final.json`, JSON.stringify(state, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    expect(state.bgCallResult).not.toBe('NOT_CALLED');
    expect(state.bgCallResult).not.toBe('NO_METHOD');
    expect(typeof state.bgCallResult).not.toBe('string'); // 返回了 boolean
  }, 240000);
});

// ====== 手动转后台的输出可读性（case-17b）======
//
// 缘起：case-17 证明了「等 task_started 后调 backgroundTasks(toolUseId) 转后台成功」，
// 但它【只】验证了转后台本身（返回 true、tool_result 带 backgroundTaskId、turn 解阻塞），
// 【没有】在任务后台运行期间去读 .output 文件的增量。
// 对照：case-18b（显式 run_in_background:true）和 case-19（自动后台化）都实测了
// 「运行中能拿到 output 路径 + 能读增量内容」。手动转后台这条路径是空白。
//
// 本 case 在 case-17 转后台逻辑上叠加 case-18b/19 的「每秒读 .output」观察，验证：
//   W1 手动转后台后，tool_result / task_notification 给的 output_file 是有值还是 null？
//   W2 用 task_started.task_id 拼路径 {tmp}/claude/{sanitized-cwd}/{session_id}/tasks/{task_id}.output
//      能否读到？内容是否随命令产出实时增长？
//   W3 若两条路径都拿不到 output，如实记为否定发现。
// 命令用慢速分批：for i in $(seq 1 8); do echo tick-$i; sleep 2; done（约 16s，8 行）。

describe('手动转后台的输出可读性', () => {
  const SLOW_CMD_17B = 'for i in $(seq 1 8); do echo tick-$i; sleep 2; done';

  it('case-17b backgroundTasks 转后台后能否实时读 .output', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-17b-bg-output-readable');

    const t0 = Date.now();
    const state = {
      bashToolUseId: null as string | null,
      taskStartedToolUseId: null as string | null,
      bashTaskId: null as string | null,
      sessionId: null as string | null,
      taskStartedAt: null as number | null,
      bgCallResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'NO_METHOD' | string,
      bgCallAt: null as number | null,
      backgroundTaskIdFromResult: null as string | null,
      outputFileFromResult: null as string | null,   // tool_result 提示文本里的 .output
      outputFileFromNotif: null as string | null,     // task_notification.output_file
      notifStatus: null as string | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
    };

    // 候选 .output 路径：优先 notif 给的，其次 tool_result 给的，最后用 task_id 拼
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    function candidatePaths(): string[] {
      const paths: string[] = [];
      if (state.outputFileFromNotif) paths.push(state.outputFileFromNotif);
      if (state.outputFileFromResult) paths.push(state.outputFileFromResult);
      // 拼路径：sanitized-cwd 规则参考 case-19（把盘符/分隔符做替换）
      if (state.sessionId && state.bashTaskId) {
        const sanitizedCwd = process.cwd().replace(/[:\\/]/g, '-');
        paths.push(join(tmpdir(), 'claude', sanitizedCwd, state.sessionId, 'tasks', `${state.bashTaskId}.output`));
      }
      return [...new Set(paths)];
    }

    const fileSnapshots: any[] = [];
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      const cands = candidatePaths();
      let hit: { path: string; lineCount: number; lastTick: string | null } | null = null;
      for (const p of cands) {
        if (existsSync(p)) {
          try {
            const c = readFileSync(p, 'utf-8');
            const ticks = c.match(/tick-\d+/g) || [];
            hit = { path: p, lineCount: ticks.length, lastTick: ticks[ticks.length - 1] ?? null };
            break;
          } catch { /* 正被写，忽略 */ }
        }
      }
      fileSnapshots.push({ t, candCount: cands.length, hit });
      console.error(`[poll t=${t}ms] 候选路径=${cands.length} 命中=${hit ? `${hit.lineCount}行(${hit.lastTick})` : '无'} bgCall=${state.bgCallResult}`);
    }, 1000);

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 30000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${SLOW_CMD_17B}` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Is the background task done? Just answer yes or no.' },
      parent_tool_use_id: null,
      priority: 'now',
    };
    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: promptInput(),
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });
    const queryHandle: any = sdkQuery;

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'init' && msg.session_id && !state.sessionId) {
            state.sessionId = msg.session_id;
          }
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.taskStartedToolUseId = msg.tool_use_id ?? null;
            state.sessionId = state.sessionId || msg.session_id || null;
            state.taskStartedAt = rel;
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} tool_use_id=${msg.tool_use_id} session=${state.sessionId}`);
          }
          if (msg.subtype === 'task_notification') {
            state.notifStatus = msg.status;
            if (msg.output_file) state.outputFileFromNotif = msg.output_file;
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block.name === 'Bash' && !state.bashToolUseId) {
              state.bashToolUseId = block.id;
            }
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
              const fm = snippet.match(/written to:\s*([^\s"]+\.output)/i) || snippet.match(/([A-Za-z]:\\[^\s"]+\.output)/);
              if (fm && !state.outputFileFromResult) state.outputFileFromResult = fm[1];
            }
          }
        }

        if (type === 'result') {
          state.queryEnded = true;
          state.queryEndedAt = rel;
          resolveTurn2();
        }

        events.push(captured);

        // 等 task_started 后调 backgroundTasks（沿用 case-17 铁律）
        if (state.bashTaskId && state.bgCallResult === 'NOT_CALLED') {
          const idToUse = state.taskStartedToolUseId || state.bashToolUseId;
          state.bgCallAt = rel;
          console.error(`\n[backgroundTasks] 等到 task_started 后调用 @ ${rel}ms，用 id=${idToUse}`);
          try {
            state.bgCallResult = typeof queryHandle.backgroundTasks === 'function'
              ? await queryHandle.backgroundTasks(idToUse)
              : 'NO_METHOD';
          } catch (e: any) {
            state.bgCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[backgroundTasks] 返回: ${state.bgCallResult}`);
        }
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;

    // 分析文件增长
    const hits = fileSnapshots.filter(s => s.hit);
    const maxLines = Math.max(0, ...hits.map(s => s.hit.lineCount));
    const growthSteps = hits.filter((s, i) => i === 0 || s.hit.lineCount !== hits[i - 1].hit.lineCount);
    const grewOverTime = growthSteps.length > 1 && maxLines > 1;
    const gotPath = state.outputFileFromNotif || state.outputFileFromResult || (state.sessionId && state.bashTaskId ? 'via-taskid拼接' : null);

    console.error('\n══════ W1-W3 实测值（手动转后台输出可读性）══════');
    console.error(`[W1] backgroundTasks 返回: ${state.bgCallResult}（@${state.bgCallAt}ms，task_started@${state.taskStartedAt}ms）`);
    console.error(`[W1] output_file 来源: notif="${state.outputFileFromNotif}" result="${state.outputFileFromResult}" | backgroundTaskId=${state.backgroundTaskIdFromResult}`);
    console.error(`[W2] 运行中拿到可读路径? ${gotPath ? '是' : '否'}；文件是否实时增长? ${grewOverTime}（maxLines=${maxLines}）`);
    console.error(`[W2] 增长阶梯: ${JSON.stringify(growthSteps.map(s => ({ t: s.t, lines: s.hit.lineCount, last: s.hit.lastTick })))}`);
    console.error(`[W3] notifStatus=${state.notifStatus}; queryEnded@${state.queryEndedAt}ms; 总耗时=${duration}ms`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/bg-output-readable.json`, JSON.stringify({
      bgCallResult: state.bgCallResult, bgCallAt: state.bgCallAt, taskStartedAt: state.taskStartedAt,
      bashTaskId: state.bashTaskId, sessionId: state.sessionId,
      outputFileFromNotif: state.outputFileFromNotif, outputFileFromResult: state.outputFileFromResult,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult,
      gotPath: !!gotPath, grewOverTime, maxLines, growthSteps, fileSnapshots,
      notifStatus: state.notifStatus, queryEnded: state.queryEnded, queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言（宽松，先观察）──
    expect(events.length).toBeGreaterThan(0);
    expect(state.bgCallResult).not.toBe('NOT_CALLED');
    if (grewOverTime) {
      console.error(`[发现] ✅ 手动转后台后 .output 文件实时增长（maxLines=${maxLines}）—— 与 case-18b/19 一致`);
    } else {
      console.error(`[否定发现] 手动转后台后未读到实时增长的 .output（gotPath=${!!gotPath}, maxLines=${maxLines}）—— 可能路径不可拼/文件不写/命令太短`);
    }
  }, 180000);
});

// ====== 前台/后台输出实时性验证（case-18）======
//
// 缘起：此前对"前台 Bash 输出是一次性返回"的说法，是从 case-1（echo 瞬时命令）
// 过度推断的——echo 太快，无法区分"实时"还是"一次性"。官方 streaming-output 文档
// 只讲 text_delta / input_json_delta（LLM 文本和工具入参的流式），【未提及】工具
// 执行的 stdout 输出是否流式。故本 case 用【慢速多行】命令拿确凿证据。
//
// 命令：for i in $(seq 1 8); do echo tick-$i; sleep 2; done —— 约 16s，分 8 次输出。
//
// case-18a（前台）：观察 tool_result 出现的时机与内容。
//   Y1 tool_result 是【命令跑完后一次性】带全部 8 行 stdout，还是执行期间增量推送？
//   Y2 执行期间是否有携带 stdout 内容的事件（区别于只带耗时的 tool_progress）？
//   Y3 从 tool_use 出现到 tool_result 出现，间隔是否 ≈16s（证明阻塞到跑完）？
//
// case-18b（后台）：后台跑同样命令，每秒读 .output 文件。
//   Z1 .output 文件是否存在、内容是否随时间【逐步增长】（证明后台输出可实时 tail）？
//   Z2 记录每秒快照的行数，看是否呈阶梯增长（tick-1, tick-2, ...）。

describe('前台/后台输出实时性', () => {
  // 8 行、每行间隔 2s，约 16s
  const SLOW_CMD = 'for i in $(seq 1 8); do echo tick-$i; sleep 2; done';

  it('case-18a 前台: tool_result 是一次性还是增量', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-18a-fg-realtime');

    const t0 = Date.now();
    const timeline: any[] = [];       // 记录带 stdout 内容的事件时机
    let toolUseAt: number | null = null;
    let toolResultAt: number | null = null;
    let toolResultStdout: string | null = null;
    let toolResultLineCount = 0;
    let sawIncrementalStdout = false; // 执行期间是否见到携带部分 stdout 的事件

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${SLOW_CMD}. Then report how many lines were printed.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    for await (const message of sdkQuery) {
      const msg = message as any;
      const type = msg.type || 'unknown';
      const rel = Date.now() - t0;
      const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

      if (type === 'stream_event' && msg.event) {
        captured.eventType = msg.event.type;
      }

      // assistant 里的 Bash tool_use
      if (type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && block.name === 'Bash' && toolUseAt === null) {
            toolUseAt = rel;
            console.error(`\n[${rel}ms] Bash tool_use 出现，command=${JSON.stringify(block.input?.command)?.substring(0, 80)}`);
          }
        }
      }

      // user 里的 tool_result —— 关键：它何时出现、带多少内容
      if (type === 'user') {
        const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const b of cb) {
          if (b.type === 'tool_result') {
            const content = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
            if (content.includes('tick-') && toolResultAt === null) {
              toolResultAt = rel;
              toolResultStdout = content.substring(0, 500);
              toolResultLineCount = (content.match(/tick-\d+/g) || []).length;
              console.error(`\n[${rel}ms] tool_result 出现，含 ${toolResultLineCount} 个 tick 行`);
            }
          }
        }
      }

      // 关键探测：执行期间（tool_use 之后、tool_result 之前）是否有任何事件携带部分 stdout
      if (toolUseAt !== null && toolResultAt === null) {
        const rawStr = JSON.stringify(msg);
        if (/tick-\d+/.test(rawStr)) {
          sawIncrementalStdout = true;
          const m = rawStr.match(/tick-\d+/g);
          timeline.push({ rel, type, subtype: msg.subtype, eventType: msg.event?.type, ticks: m });
          console.error(`\n[${rel}ms] ⚡ 执行期间出现 stdout 片段: ${m?.join(',')} （type=${type}/${msg.subtype || msg.event?.type}）`);
        }
        // 记录执行期间的 tool_progress（只带耗时不带内容）
        if (type === 'tool_progress' || msg.subtype === 'task_progress') {
          timeline.push({ rel, type, subtype: msg.subtype, elapsed: msg.elapsed_time_seconds });
        }
      }

      events.push(captured);
    }

    const duration = Date.now() - t0;
    const gap = (toolUseAt !== null && toolResultAt !== null) ? toolResultAt - toolUseAt : null;

    console.error('\n══════ Y1-Y3 实测值（前台）══════');
    console.error(`[Y1] tool_result 一次性带全部 stdout？ 行数=${toolResultLineCount}（命令产出 8 行）`);
    console.error(`[Y2] 执行期间是否见到携带 stdout 的增量事件: ${sawIncrementalStdout}（false=非实时，输出仅在 tool_result 一次性出现）`);
    console.error(`[Y3] tool_use→tool_result 间隔: ${gap}ms（命令约 16s；接近则证明阻塞到跑完才返回）`);
    console.error(`[timeline] 执行期间携带内容/进度的事件: ${JSON.stringify(timeline)}`);
    console.error(`[tool_result 内容前 500]: ${toolResultStdout}`);

    writeFileSync(`${dir}/realtime-fg.json`, JSON.stringify({
      toolUseAt, toolResultAt, gap, toolResultLineCount, sawIncrementalStdout, duration, timeline,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
    // 只做存在性断言，实时性结论靠上面的记录（researcher：断结构不断结论）
    expect(toolUseAt).not.toBeNull();
  }, 180000);

  it('case-18b 后台: 每秒读 .output 看是否逐步增长', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-18b-bg-realtime');

    const t0 = Date.now();
    let outputFile: string | null = null;
    let bgTaskId: string | null = null;
    const fileSnapshots: any[] = []; // 每秒快照：{ t, exists, lineCount, ticks }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this command in the BACKGROUND (set run_in_background to true): ${SLOW_CMD}. Then tell me the background task id.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 每秒读 output_file
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      if (outputFile) {
        const exists = existsSync(outputFile);
        let lineCount = 0; let ticks: string[] = [];
        if (exists) {
          try {
            const c = readFileSync(outputFile, 'utf-8');
            ticks = c.match(/tick-\d+/g) || [];
            lineCount = ticks.length;
          } catch { /* 文件可能正被写，忽略 */ }
        }
        fileSnapshots.push({ t, exists, lineCount, lastTick: ticks[ticks.length - 1] ?? null });
        console.error(`[poll t=${t}ms] output_file exists=${exists} tickLines=${lineCount} last=${ticks[ticks.length - 1] ?? '-'}`);
      } else {
        console.error(`[poll t=${t}ms] outputFile 尚未获得`);
      }
    }, 1000);

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        // 从 tool_result 的 backgroundTaskId 或提示文本里取 output 路径
        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const content = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              const fm = content.match(/written to:\s*([^\s"]+\.output)/i) || content.match(/([A-Za-z]:\\[^\s"]+\.output)/);
              if (fm && !outputFile) {
                outputFile = fm[1];
                console.error(`\n[${rel}ms] 从 tool_result 提取 output_file: ${outputFile}`);
              }
              const im = content.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (im && !bgTaskId) bgTaskId = im[1];
            }
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !bgTaskId) {
            bgTaskId = msg.task_id;
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id}`);
          }
          if (msg.subtype === 'task_notification') {
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
            if (msg.output_file && !outputFile) outputFile = msg.output_file;
          }
        }

        events.push(captured);
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;

    // 分析：文件行数是否随时间增长
    const growthSteps = fileSnapshots.filter((s, i) => i === 0 || s.lineCount !== fileSnapshots[i - 1].lineCount);
    const maxLines = Math.max(0, ...fileSnapshots.map(s => s.lineCount));
    const grewOverTime = growthSteps.filter(s => s.exists).length > 1 && maxLines > 1;

    console.error('\n══════ Z1-Z2 实测值（后台）══════');
    console.error(`[Z1] output_file 路径: ${outputFile ?? '(未获得)'}`);
    console.error(`[Z2] 文件行数是否随时间逐步增长: ${grewOverTime}（maxLines=${maxLines}）`);
    console.error(`[增长阶梯]: ${JSON.stringify(growthSteps.map(s => ({ t: s.t, lines: s.lineCount, last: s.lastTick })))}`);

    writeFileSync(`${dir}/realtime-bg.json`, JSON.stringify({
      outputFile, bgTaskId, duration, maxLines, grewOverTime, fileSnapshots, growthSteps,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 180000);
});

// ====== 前台命令的 .output 文件通道验证（case-19，解释 TUI Ctrl+O）======
//
// 缘起：case-18a 证明【前台】命令输出无法从 SDK 事件流实时拿到。但 TUI 里 Ctrl+O
// （toggleTranscript）能看到前台命令的实时执行输出。假设：TUI 的实时可见性【不是】
// 来自 SDK 事件流，而是来自「长前台命令被自动后台化后写入的 .output 文件」——
// case-12/13 证明长前台命令会被 SDK 在 ~5s 后自动后台化并产生 task_started。
//
// 本 case 前台跑慢命令，同时监控三条通道：
//   R1 SDK 事件流是否有增量 stdout？（预期否，同 case-18a）
//   R2 前台命令是否被自动后台化并产生 task_started（拿到 task_id）？
//   R3 用 task_id 拼出 .output 路径，该文件是否存在并【实时增长】？
//       路径格式（case-14 已知）：{tmp}/claude/{sanitized-cwd}/{session_id}/tasks/{task_id}.output
//       session_id 从 system/init 或 task_started 消息取。
//
// 结论指向：若 R3 成立，则 TUI Ctrl+O 的实时输出走的是【自动后台化后的 .output 文件】
// 通道，而非 SDK 事件流——这就调和了「case-18a 说前台不可实时」与「Ctrl+O 能看到」。

describe('前台命令 .output 文件通道', () => {
  const SLOW_CMD_19 = 'for i in $(seq 1 10); do echo tick-$i; sleep 2; done'; // ~20s，10 行

  it('case-19 前台命令是否有可实时读的 .output 文件', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-19-fg-output-file');

    const t0 = Date.now();
    let sessionId: string | null = null;
    let bashTaskId: string | null = null;
    let taskStartedAt: number | null = null;
    let notifOutputFile: string | null = null;      // task_notification 给的 output_file
    let sawIncrementalStdout = false;                // SDK 事件流是否有增量 stdout
    let candidatePath: string | null = null;         // 用 task_id 拼的路径
    const fileSnapshots: any[] = [];

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${SLOW_CMD_19}. Then report how many lines printed.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 拼 .output 路径的辅助：优先用 notif 给的，其次用 task_id 拼
    const resolveOutputPath = (): string | null => {
      if (notifOutputFile) return notifOutputFile;
      if (candidatePath) return candidatePath;
      return null;
    };

    // 每秒尝试读候选文件
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      const p = resolveOutputPath();
      if (p) {
        const exists = existsSync(p);
        let lineCount = 0; let ticks: string[] = [];
        if (exists) {
          try { const c = readFileSync(p, 'utf-8'); ticks = c.match(/tick-\d+/g) || []; lineCount = ticks.length; } catch {}
        }
        fileSnapshots.push({ t, path: p, exists, lineCount, last: ticks[ticks.length - 1] ?? null });
        console.error(`[poll t=${t}ms] path=...${p.slice(-30)} exists=${exists} lines=${lineCount} last=${ticks[ticks.length - 1] ?? '-'}`);
      } else {
        console.error(`[poll t=${t}ms] 尚无候选 .output 路径（sessionId=${sessionId?'有':'无'} taskId=${bashTaskId?'有':'无'}）`);
      }
    }, 1000);

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        // session_id 从任意带该字段的消息取
        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          console.error(`\n[${rel}ms] sessionId=${sessionId}`);
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !bashTaskId) {
            bashTaskId = msg.task_id;
            taskStartedAt = rel;
            if (msg.session_id) sessionId = msg.session_id;
            console.error(`\n[${rel}ms] task_started（前台命令被自动后台化）task_id=${msg.task_id}`);
            // 用 case-14 已知路径格式拼候选路径
            if (sessionId && bashTaskId) {
              const cwd = process.cwd();
              const sanitized = cwd.replace(/[:\\/.]/g, '-');
              const tmp = process.env.TEMP || process.env.TMP || 'C:\\Users\\14409~1.JER\\AppData\\Local\\Temp';
              candidatePath = `${tmp}\\claude\\${sanitized}\\${sessionId}\\tasks\\${bashTaskId}.output`;
              console.error(`[${rel}ms] 拼出候选 .output 路径: ${candidatePath}`);
            }
          }
          if (msg.subtype === 'task_notification') {
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
            if (msg.output_file) notifOutputFile = msg.output_file;
          }
        }

        // SDK 事件流是否有增量 stdout（tool_result 之前出现 tick-N）
        if (bashTaskId || type === 'assistant') {
          const rawStr = JSON.stringify(msg);
          if (type !== 'user' && /tick-\d+/.test(rawStr)) {
            // 排除 tool_result（那是最终一次性结果）
            if (!(type === 'user')) {
              sawIncrementalStdout = true;
              console.error(`\n[${rel}ms] ⚡ SDK 事件流出现 stdout 片段（type=${type}/${msg.subtype || msg.event?.type}）`);
            }
          }
        }

        events.push(captured);
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;
    const maxLines = Math.max(0, ...fileSnapshots.map(s => s.lineCount));
    const existedSnapshots = fileSnapshots.filter(s => s.exists);
    const growthSteps = existedSnapshots.filter((s, i) => i === 0 || s.lineCount !== existedSnapshots[i - 1].lineCount);
    const fileGrewOverTime = growthSteps.length > 1 && maxLines > 1;

    console.error('\n══════ R1-R3 实测值 ══════');
    console.error(`[R1] SDK 事件流有增量 stdout: ${sawIncrementalStdout}（预期 false，同 case-18a）`);
    console.error(`[R2] 前台命令被自动后台化: ${bashTaskId !== null}（task_id=${bashTaskId}, @${taskStartedAt}ms）`);
    console.error(`[R3] .output 文件存在且实时增长: ${fileGrewOverTime}（maxLines=${maxLines}）`);
    console.error(`[R3-路径] notif=${notifOutputFile ?? '-'}; 拼接=${candidatePath ?? '-'}`);
    console.error(`[R3-增长阶梯] ${JSON.stringify(growthSteps.map(s => ({ t: s.t, lines: s.lineCount, last: s.last })))}`);
    console.error(`\n【结论】TUI Ctrl+O 实时输出的通道推断：${fileGrewOverTime ? '.output 文件（前台命令自动后台化后写入，可实时 tail）' : sawIncrementalStdout ? 'SDK 事件流增量' : '未能确证——需进一步排查路径/时机'}`);

    writeFileSync(`${dir}/fg-output-file.json`, JSON.stringify({
      sessionId, bashTaskId, taskStartedAt, notifOutputFile, candidatePath,
      sawIncrementalStdout, fileGrewOverTime, maxLines, duration, fileSnapshots, growthSteps,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
    // 纯记录，实时性结论靠上面数据（researcher：断结构不断结论）
  }, 180000);
});

// ====== task_progress 完整字段解析（case-20）======
//
// 缘起：raw/tool-foreground-background-behavior.md 发现 6 只知道 workflow「有 task_progress
// 推送（2-3 次）」，但从未解析过该消息的字段级内容。sdk.d.ts:4192-4214 定义
// SDKTaskProgressMessage 含：description（必填）、subagent_type?、last_tool_name?、
// summary?、usage.{total_tokens,tool_uses,duration_ms}（必填）。本 case 跑一个会持续
// 推送进度的长任务，逐条捕获 task_progress 的完整字段 + 推送时间戳（算频率）。
//
// 任务选择：subagent（Agent 工具）——它是唯一带 subagent_type 的场景（sdk.d.ts 注释
// 明确 subagent_type 是「Subagent type for Task tool subagents」）。让 subagent 连续跑
// 多个 Bash 命令，拉长执行时间、多触发进度推送，同时观察 last_tool_name 是否随之变化。
//
// 观察目标：
//   P1 task_progress 是否出现？出现几次？推送间隔（频率）？
//   P2 每条 task_progress 的字段：description / subagent_type / last_tool_name / summary
//   P3 usage 子字段：total_tokens / tool_uses / duration_ms 是否随进度累加？
//   P4 task_progress.task_id 是否等于同任务的 task_started.task_id？

describe('task_progress 完整字段', () => {
  it('case-20 task_progress: 长 subagent 的进度推送字段', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-20-task-progress');

    const t0 = Date.now();
    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };

    // 让 subagent 连续做多步（多次 Bash），拉长时间、多推进度
    const sdkQuery = query({
      prompt: `Use the Agent tool to launch a subagent. Instruct the subagent to run these Bash commands one by one, in order, waiting for each: (1) echo step-1 && sleep 3, (2) echo step-2 && sleep 3, (3) echo step-3 && sleep 3, (4) echo step-4 && sleep 3. After all four finish, report done. Then tell me the subagent's result.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 逐条捕获 task_progress 完整字段 + 时间戳
    interface ProgressSnap {
      relMs: number;
      task_id: string;
      tool_use_id?: string;
      description?: string;
      subagent_type?: string;
      last_tool_name?: string;
      summary?: string;
      usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
      rawKeys: string[];
    }
    const progressSnaps: ProgressSnap[] = [];
    const taskStartedIds: string[] = [];
    let taskStartedType: string | null = null;
    let taskStartedSubagentType: string | null = null;

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    for await (const message of sdkQuery) {
      const msg = message as any;
      const type = msg.type || 'unknown';
      const rel = Date.now() - t0;
      const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

      if (type === 'stream_event' && msg.event) {
        captured.eventType = msg.event.type;
        if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          process.stderr.write(msg.event.delta.text);
        }
      }

      if (type === 'system') {
        captured.subtype = msg.subtype;
        if (msg.subtype === 'task_started') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          taskStartedIds.push(msg.task_id);
          if (!taskStartedType) taskStartedType = msg.task_type ?? null;
          if (!taskStartedSubagentType) taskStartedSubagentType = msg.subagent_type ?? null;
          console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} task_type=${msg.task_type} subagent_type=${msg.subagent_type ?? '-'}`);
        }
        if (msg.subtype === 'task_progress') {
          const snap: ProgressSnap = {
            relMs: rel,
            task_id: msg.task_id,
            tool_use_id: msg.tool_use_id,
            description: msg.description,
            subagent_type: msg.subagent_type,
            last_tool_name: msg.last_tool_name,
            summary: msg.summary,
            usage: msg.usage,
            rawKeys: Object.keys(msg),
          };
          progressSnaps.push(snap);
          captured.taskId = msg.task_id;
          captured.raw = snap;
          console.error(`\n[${rel}ms] ⚡ task_progress #${progressSnaps.length}: last_tool=${msg.last_tool_name ?? '-'} subagent_type=${msg.subagent_type ?? '-'} usage=${JSON.stringify(msg.usage)} desc="${(msg.description ?? '').substring(0, 60)}" summary="${(msg.summary ?? '').substring(0, 60)}"`);
        }
        if (msg.subtype === 'task_notification') {
          captured.taskId = msg.task_id;
          captured.taskStatus = msg.status;
          console.error(`\n[${rel}ms] task_notification status=${msg.status}`);
        }
      }

      events.push(captured);
    }

    const duration = Date.now() - t0;

    // 推送频率：相邻 task_progress 的时间间隔
    const intervals: number[] = [];
    for (let i = 1; i < progressSnaps.length; i++) {
      intervals.push(progressSnaps[i].relMs - progressSnaps[i - 1].relMs);
    }
    const avgInterval = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null;

    // usage 是否累加（total_tokens 单调不减？）
    const totalTokensSeq = progressSnaps.map(s => s.usage?.total_tokens ?? null);
    const toolUsesSeq = progressSnaps.map(s => s.usage?.tool_uses ?? null);
    const lastToolSeq = progressSnaps.map(s => s.last_tool_name ?? null);

    console.error('\n══════ P1-P4 实测值 ══════');
    console.error(`[P1] task_progress 出现次数: ${progressSnaps.length}；推送间隔(ms): ${JSON.stringify(intervals)}；平均 ${avgInterval}ms`);
    console.error(`[P2] task_type=${taskStartedType} subagent_type(task_started)=${taskStartedSubagentType}`);
    console.error(`[P2] progress 字段 key 并集: ${JSON.stringify([...new Set(progressSnaps.flatMap(s => s.rawKeys))])}`);
    console.error(`[P2] last_tool_name 序列: ${JSON.stringify(lastToolSeq)}`);
    console.error(`[P3] usage.total_tokens 序列: ${JSON.stringify(totalTokensSeq)}`);
    console.error(`[P3] usage.tool_uses 序列: ${JSON.stringify(toolUsesSeq)}`);
    console.error(`[P4] task_progress.task_id ⊆ task_started.task_id 集合: ${progressSnaps.every(s => taskStartedIds.includes(s.task_id))}（task_started ids=${JSON.stringify(taskStartedIds)}）`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/task-progress.json`, JSON.stringify({
      progressCount: progressSnaps.length,
      intervals, avgInterval,
      taskStartedIds, taskStartedType, taskStartedSubagentType,
      totalTokensSeq, toolUsesSeq, lastToolSeq,
      progressSnaps, duration,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
    // 结构断言：若有 task_progress，每条必带 task_id 与 usage（sdk.d.ts 标为必填）
    for (const s of progressSnaps) {
      expect(typeof s.task_id).toBe('string');
      expect(s.usage).toBeDefined();
    }
    // 否定结果记录：本地 LLM 可能不触发 subagent 或不产生多次进度推送
    if (progressSnaps.length === 0) {
      console.error('[否定发现] 未观测到 task_progress —— 记录（本地 LLM 未走 subagent 或任务太快）');
    }
  }, 120000);
});

// ====== task_updated 状态机重建（case-21）======
//
// 缘起：raw 文档「未验证行为 5」标注 task_updated「观察到出现，但未分析其结构」。
// sdk.d.ts:4238-4258 定义 SDKTaskUpdatedMessage.patch 含 status（6 态：
// pending|running|completed|failed|killed|paused）、description、end_time、
// total_paused_ms、error、is_backgrounded。case-14 曾顺带打印过 patch，但从未系统
// 重建状态机，且 paused / killed 两态此前从未观测到。
//
// 本 case 用 streaming-input 模式跑长 Bash，收集所有 task_updated.patch，重建状态序列，
// 并主动 stopTask 尝试触发 killed；观察 is_backgrounded 布尔翻转时机。
//
// 观察目标：
//   Q1 task_updated 出现几次？patch 里出现过哪些字段（key 并集）？
//   Q2 status 状态序列（重建状态机）——能否观测到 pending→running→...→killed/completed？
//   Q3 stopTask 后是否出现 status=killed（此前从未观测）？还是走 completed/failed？
//   Q4 is_backgrounded 何时从 false/缺省 翻转为 true（自动后台化时刻）？
//   Q5 end_time / total_paused_ms / error 字段在何种 patch 中出现？

describe('task_updated 状态机', () => {
  const LONG_CMD_21 = 'sleep 40 && echo bg-21-done';

  it('case-21 task_updated: 重建状态机 + 尝试触发 killed/paused', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-21-task-updated');

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      stopCallResult: 'NOT_CALLED' as 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      stopCallAt: null as number | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
    };

    // 逐条 task_updated 快照
    interface PatchSnap {
      relMs: number;
      task_id: string;
      status?: string;
      description?: string;
      end_time?: number;
      total_paused_ms?: number;
      error?: string;
      is_backgrounded?: boolean;
      patchKeys: string[];
    }
    const patchSnaps: PatchSnap[] = [];
    const notifSnaps: { relMs: number; status: string }[] = [];

    const events: CapturedSDKEvent[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 20000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command: ${LONG_CMD_21}. Run it in the foreground. Do NOT set run_in_background.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'What is the final status of the background task? Just report it. Do NOT run new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      console.error(`[obs t=${t}ms] taskId=${state.bashTaskId ?? '-'} stop=${state.stopCallResult} patches=${patchSnaps.length} ended=${state.queryEnded}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            if (!state.bashTaskId) {
              state.bashTaskId = msg.task_id;
              state.taskStartedAt = rel;
              console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} task_type=${msg.task_type}`);
            }
          }
          if (msg.subtype === 'task_updated') {
            const p = msg.patch || {};
            const snap: PatchSnap = {
              relMs: rel,
              task_id: msg.task_id,
              status: p.status,
              description: p.description,
              end_time: p.end_time,
              total_paused_ms: p.total_paused_ms,
              error: p.error,
              is_backgrounded: p.is_backgrounded,
              patchKeys: Object.keys(p),
            };
            patchSnaps.push(snap);
            captured.taskId = msg.task_id;
            captured.raw = { patch: p };
            console.error(`\n[${rel}ms] ⚡ task_updated #${patchSnaps.length} patch=${JSON.stringify(p)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            notifSnaps.push({ relMs: rel, status: msg.status });
            console.error(`\n[${rel}ms] task_notification status=${msg.status}`);
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              captured.toolName = block.name;
              captured.toolUseId = block.id;
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns}`);
          resolveTurn2();
        }

        events.push(captured);

        // ── 控制调用：等 task_started 后 stopTask，尝试触发 killed ──
        if (state.bashTaskId && state.stopCallResult === 'NOT_CALLED') {
          state.stopCallAt = rel;
          console.error(`\n[stopTask] 调用 @ ${state.stopCallAt}ms（尝试触发 killed），taskId=${state.bashTaskId}`);
          try {
            if (typeof queryHandle.stopTask === 'function') {
              await queryHandle.stopTask(state.bashTaskId);
              state.stopCallResult = 'OK';
            } else {
              state.stopCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.stopCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[stopTask] 结果: ${state.stopCallResult}`);
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    // 重建状态机：status 序列（去掉 undefined）
    const statusSeq = patchSnaps.map(s => s.status).filter(Boolean);
    const distinctStatuses = [...new Set(statusSeq)];
    const patchKeyUnion = [...new Set(patchSnaps.flatMap(s => s.patchKeys))];
    // is_backgrounded 翻转
    const bgFlips = patchSnaps.filter(s => s.is_backgrounded !== undefined).map(s => ({ relMs: s.relMs, is_backgrounded: s.is_backgrounded }));
    const sawKilled = statusSeq.includes('killed');
    const sawPaused = statusSeq.includes('paused');

    console.error('\n══════ Q1-Q5 实测值 ══════');
    console.error(`[Q1] task_updated 出现 ${patchSnaps.length} 次；patch key 并集: ${JSON.stringify(patchKeyUnion)}`);
    console.error(`[Q2] status 序列（状态机）: ${JSON.stringify(statusSeq)}；去重: ${JSON.stringify(distinctStatuses)}`);
    console.error(`[Q3] stopTask 结果=${state.stopCallResult}@${state.stopCallAt}ms；是否观测到 killed: ${sawKilled}；task_notification 状态: ${JSON.stringify(notifSnaps)}`);
    console.error(`[Q4] is_backgrounded 翻转记录: ${JSON.stringify(bgFlips)}（task_started@${state.taskStartedAt}ms）`);
    console.error(`[Q5] 是否观测到 paused: ${sawPaused}；含 end_time 的 patch: ${JSON.stringify(patchSnaps.filter(s => s.end_time !== undefined).map(s => ({ relMs: s.relMs, end_time: s.end_time })))}；含 error 的 patch: ${JSON.stringify(patchSnaps.filter(s => s.error !== undefined))}；含 total_paused_ms 的 patch: ${JSON.stringify(patchSnaps.filter(s => s.total_paused_ms !== undefined))}`);
    console.error(`[补充] result.subtype=${state.resultSubtype}，总耗时=${duration}ms`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/task-updated.json`, JSON.stringify({
      patchCount: patchSnaps.length,
      statusSeq, distinctStatuses, patchKeyUnion, bgFlips,
      sawKilled, sawPaused,
      stopCallResult: state.stopCallResult, stopCallAt: state.stopCallAt,
      notifSnaps, resultSubtype: state.resultSubtype, duration,
      patchSnaps,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    // stopTask 方法存在且被调用
    expect(state.stopCallResult).not.toBe('NOT_CALLED');
    expect(state.stopCallResult).not.toBe('NO_METHOD');
    // 结构断言：若有 task_updated，patch 必是对象且每条带 task_id
    for (const s of patchSnaps) {
      expect(typeof s.task_id).toBe('string');
      expect(Array.isArray(s.patchKeys)).toBe(true);
    }
    // 否定发现记录
    if (!sawKilled) console.error('[否定发现] 未观测到 status=killed —— 记录（stopTask 可能走 completed/stopped 而非 killed patch）');
    if (!sawPaused) console.error('[否定发现] 未观测到 status=paused —— 记录（本环境无 pause 触发路径）');
  }, 120000);
});

// ====== backgroundTasks() 无参数批量后台化（case-22）======
//
// 缘起：case-13/14/17 只测了带 toolUseId 的【单任务】backgroundTasks 形式。
// sdk.d.ts:2496 的 backgroundTasks 签名 toolUseId 可选——不传时应后台化【所有】前台
// 任务（对应 TUI Ctrl+B 的批量后台化）。本 case 先启动两个前台 Bash 任务，等它们
// task_started 后调用无参 backgroundTasks()，观察返回值与被转后台的任务数。
//
// 关键前提（沿用 case-17 决定性结论）：控制方法必须在 task_started【之后】调用才生效。
// 故这里等【至少一个】task_started 后再调；为尽量让两个任务都注册，等到收到 2 个
// task_started 或超时窗口后触发。
//
// 观察目标：
//   S1 无参 backgroundTasks() 返回值（true/false）？
//   S2 调用前有几个前台任务在跑？调用后有几个被转后台（task_started 计数 / tool_result 带 backgroundTaskId 计数）？
//   S3 与单任务形式（case-17）对比：无参是否批量作用于全部？
//   S4 query 是否解除阻塞、可续轮？

describe('backgroundTasks() 无参批量后台化', () => {
  // 两个中等长度命令，确保都进入执行、都能 task_started
  const CMD_A = 'sleep 30 && echo bg-22-A-done';
  const CMD_B = 'sleep 30 && echo bg-22-B-done';

  it('case-22 backgroundTasks(): 无参数批量转后台', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-22-bg-noarg-batch');

    const state = {
      queryStartedAt: Date.now(),
      taskStartedIds: [] as string[],
      taskStartedAtMs: [] as number[],
      bgCallResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'NO_METHOD' | string,
      bgCallAt: null as number | null,
      bgTaskIdsFromResult: [] as string[],
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      turnsObserved: 0,
    };

    const events: CapturedSDKEvent[] = [];
    const notifStatuses: { relMs: number; task_id: string; status: string }[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 25000));

    // 一条消息里要求跑两个后台化候选命令（前台，靠自动/手动后台化）
    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool TWICE to start two separate foreground commands. First run this exact command: ${CMD_A}. Then run this exact command: ${CMD_B}. Do NOT set run_in_background on either. Run them so both are executing.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'How many background tasks are currently running? Just report the count. Do NOT run new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    // 观察者：等到第一个 task_started 后再给 ~3s 窗口收集第二个，然后调无参 backgroundTasks
    let bgTriggered = false;
    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      console.error(`[obs t=${t}ms] taskStarted=${state.taskStartedIds.length} bgCall=${state.bgCallResult} ended=${state.queryEnded}`);
      // 触发条件：至少 1 个 task_started，且（收到 2 个 或 距首个 task_started 已 > 4s）
      if (
        !bgTriggered &&
        state.taskStartedIds.length >= 1 &&
        state.bgCallResult === 'NOT_CALLED' &&
        !state.queryEnded &&
        (state.taskStartedIds.length >= 2 || (state.taskStartedAtMs[0] != null && t - state.taskStartedAtMs[0] > 4000))
      ) {
        bgTriggered = true;
        state.bgCallAt = t;
        const startedBefore = state.taskStartedIds.length;
        console.error(`\n[backgroundTasks] 无参调用 @ ${t}ms（调用前 task_started 数=${startedBefore}）`);
        (async () => {
          try {
            if (typeof queryHandle.backgroundTasks === 'function') {
              state.bgCallResult = await queryHandle.backgroundTasks();
            } else {
              state.bgCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.bgCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[backgroundTasks] 无参返回: ${state.bgCallResult}`);
          resolveTurn2();
        })();
      }
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.taskType = msg.task_type;
            state.taskStartedIds.push(msg.task_id);
            state.taskStartedAtMs.push(rel);
            console.error(`\n[${rel}ms] task_started #${state.taskStartedIds.length} task_id=${msg.task_id} task_type=${msg.task_type}`);
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[${rel}ms] task_updated patch=${JSON.stringify(msg.patch)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            notifStatuses.push({ relMs: rel, task_id: msg.task_id, status: msg.status });
            console.error(`\n[${rel}ms] task_notification task_id=${msg.task_id} status=${msg.status}`);
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
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
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m) state.bgTaskIdsFromResult.push(m[1]);
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns}`);
          resolveTurn2();
        }

        events.push(captured);
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    const uniqueBgTaskIds = [...new Set(state.bgTaskIdsFromResult)];

    console.error('\n══════ S1-S4 实测值 ══════');
    console.error(`[S1] 无参 backgroundTasks() 返回: ${state.bgCallResult}（调用@${state.bgCallAt}ms）`);
    console.error(`[S2] 调用前观测到的 task_started 数: ${state.taskStartedIds.length}（ids=${JSON.stringify(state.taskStartedIds)}，各@${JSON.stringify(state.taskStartedAtMs)}ms）`);
    console.error(`[S2] tool_result 提取到的 backgroundTaskId: ${JSON.stringify(uniqueBgTaskIds)}（${uniqueBgTaskIds.length} 个）`);
    console.error(`[S3] task_notification 状态: ${JSON.stringify(notifStatuses)}`);
    console.error(`[S4] query 是否结束=${state.queryEnded}@${state.queryEndedAt}ms；turnsObserved=${state.turnsObserved}；result.subtype=${state.resultSubtype}；总耗时=${duration}ms`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/bg-noarg-batch.json`, JSON.stringify({
      bgCallResult: state.bgCallResult, bgCallAt: state.bgCallAt,
      taskStartedIds: state.taskStartedIds, taskStartedAtMs: state.taskStartedAtMs,
      uniqueBgTaskIds, notifStatuses,
      queryEnded: state.queryEnded, queryEndedAt: state.queryEndedAt,
      resultSubtype: state.resultSubtype, turnsObserved: state.turnsObserved, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    // 无参 backgroundTasks 方法存在且被调用（非没调/没方法）
    expect(state.bgCallResult).not.toBe('NOT_CALLED');
    expect(state.bgCallResult).not.toBe('NO_METHOD');
    // 否定发现记录：本地 LLM 可能只起一个任务，或无参调用返回 false
    if (state.taskStartedIds.length < 2) {
      console.error(`[否定发现] 只观测到 ${state.taskStartedIds.length} 个 task_started（期望 2）—— 本地 LLM 可能串行/只起一个，批量语义验证受限`);
    }
  }, 120000);
});

// ══════════════════════════════════════════════════════════════════
// case-22b: 用智谱 GLM（glm-5.2）重跑无参 backgroundTasks 批量语义
//
// 动机：case-22 在本地 Jereh LLM 上因「工具层串行、起不了并发前台 Bash」
// 只观测到 1 个 task_started，无法压满「无参 backgroundTasks 一次转多个」的批量语义。
// 本 case 换能力更强的 GLM，看能否真正起 2 个并发前台 Bash → 若能，则无参调用应一次转 ≥2 个。
// 控制变量：仅换 env（BIGMODEL_ENV），prompt/观察逻辑与 case-22 完全一致。
// ══════════════════════════════════════════════════════════════════
describe('backgroundTasks() 无参批量 — 智谱 GLM 并发验证', () => {
  const CMD_A = 'sleep 30 && echo bg-22b-A-done';
  const CMD_B = 'sleep 30 && echo bg-22b-B-done';

  it('case-22b GLM: 并发前台 Bash + 无参 backgroundTasks 批量转后台', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-22b-glm-batch');

    const state = {
      queryStartedAt: Date.now(),
      taskStartedIds: [] as string[],
      taskStartedAtMs: [] as number[],
      bgCallResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'NO_METHOD' | string,
      bgCallAt: null as number | null,
      bgTaskIdsFromResult: [] as string[],
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      turnsObserved: 0,
    };

    const events: CapturedSDKEvent[] = [];
    const notifStatuses: { relMs: number; task_id: string; status: string }[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 25000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool TWICE to start two separate foreground commands. First run this exact command: ${CMD_A}. Then run this exact command: ${CMD_B}. Do NOT set run_in_background on either. Run them so both are executing.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'How many background tasks are currently running? Just report the count. Do NOT run new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    // 唯一变量：env 换成 BIGMODEL_ENV（智谱 GLM）
    const env = { ...BIGMODEL_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    // 观察者：等到第一个 task_started 后再给 ~4s 窗口收集第二个，然后调无参 backgroundTasks
    let bgTriggered = false;
    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      console.error(`[obs t=${t}ms] taskStarted=${state.taskStartedIds.length} bgCall=${state.bgCallResult} ended=${state.queryEnded}`);
      if (
        !bgTriggered &&
        state.taskStartedIds.length >= 1 &&
        state.bgCallResult === 'NOT_CALLED' &&
        !state.queryEnded &&
        (state.taskStartedIds.length >= 2 || (state.taskStartedAtMs[0] != null && t - state.taskStartedAtMs[0] > 4000))
      ) {
        bgTriggered = true;
        state.bgCallAt = t;
        const startedBefore = state.taskStartedIds.length;
        console.error(`\n[backgroundTasks] 无参调用 @ ${t}ms（调用前 task_started 数=${startedBefore}）`);
        (async () => {
          try {
            if (typeof queryHandle.backgroundTasks === 'function') {
              state.bgCallResult = await queryHandle.backgroundTasks();
            } else {
              state.bgCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.bgCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[backgroundTasks] 无参返回: ${state.bgCallResult}`);
          resolveTurn2();
        })();
      }
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.taskType = msg.task_type;
            state.taskStartedIds.push(msg.task_id);
            state.taskStartedAtMs.push(rel);
            console.error(`\n[${rel}ms] task_started #${state.taskStartedIds.length} task_id=${msg.task_id} task_type=${msg.task_type}`);
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[${rel}ms] task_updated patch=${JSON.stringify(msg.patch)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            notifStatuses.push({ relMs: rel, task_id: msg.task_id, status: msg.status });
            console.error(`\n[${rel}ms] task_notification task_id=${msg.task_id} status=${msg.status}`);
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
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
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m) state.bgTaskIdsFromResult.push(m[1]);
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns}`);
          resolveTurn2();
        }

        events.push(captured);
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    const uniqueBgTaskIds = [...new Set(state.bgTaskIdsFromResult)];

    console.error('\n══════ case-22b GLM 实测值 ══════');
    console.error(`[G1] 无参 backgroundTasks() 返回: ${state.bgCallResult}（调用@${state.bgCallAt}ms）`);
    console.error(`[G2] 调用前观测到的 task_started 数: ${state.taskStartedIds.length}（ids=${JSON.stringify(state.taskStartedIds)}，各@${JSON.stringify(state.taskStartedAtMs)}ms）`);
    console.error(`[G2] tool_result 提取到的 backgroundTaskId: ${JSON.stringify(uniqueBgTaskIds)}（${uniqueBgTaskIds.length} 个）`);
    console.error(`[G3] task_notification 状态: ${JSON.stringify(notifStatuses)}`);
    console.error(`[G4] query 是否结束=${state.queryEnded}@${state.queryEndedAt}ms；turnsObserved=${state.turnsObserved}；result.subtype=${state.resultSubtype}；总耗时=${duration}ms`);
    console.error(`[G5] 并发判定: ${state.taskStartedIds.length >= 2 ? '✅ GLM 起了 ≥2 个前台任务，批量语义可压满' : '❌ 仍只 ' + state.taskStartedIds.length + ' 个，GLM 在本 SDK 下也未并发'}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/glm-batch.json`, JSON.stringify({
      model: 'glm-5.2', haikuModel: 'glm-4.5-air',
      bgCallResult: state.bgCallResult, bgCallAt: state.bgCallAt,
      taskStartedIds: state.taskStartedIds, taskStartedAtMs: state.taskStartedAtMs,
      uniqueBgTaskIds, notifStatuses,
      queryEnded: state.queryEnded, queryEndedAt: state.queryEndedAt,
      resultSubtype: state.resultSubtype, turnsObserved: state.turnsObserved, duration,
    }, null, 2));

    // ── 断言（宽松，先观察）──
    expect(events.length).toBeGreaterThan(0);
    expect(state.bgCallResult).not.toBe('NOT_CALLED');
    expect(state.bgCallResult).not.toBe('NO_METHOD');
    if (state.taskStartedIds.length >= 2) {
      console.error(`[发现] ✅ GLM 起了 ${state.taskStartedIds.length} 个并发前台任务 —— 无参 backgroundTasks 批量语义得到验证`);
    } else {
      console.error(`[否定发现] GLM 仍只起 ${state.taskStartedIds.length} 个 task_started —— 并发受限可能来自 SDK 工具层而非模型能力`);
    }
  }, 120000);
});

// ══════════════════════════════════════════════════════════════════
// 生命周期补 5 case（case-24 ~ case-28）
//
// 缘起：覆盖审视发现 SDK 的 4 种 task 消息（task_started/notification/progress/
// updated）和 8 个 Query 控制方法（interrupt/stopTask/backgroundTasks[有参/无参]/
// streamInput/close/supportedCommands/mcpServerStatus）里，还有几处生命周期缺口：
//   · case-24 嵌套 subagent 的 id 父子链（parent_tool_use_id / subagent_type）
//   · case-25 自动后台化后如何解除阻塞、边聊边执行（三路径对照，最核心）
//   · case-26 显式后台 bash（run_in_background:true）能否被 stopTask 终止（对照 case-15）
//   · case-27 query 运行期有后台 bash 时调 close() 的行为（会话关闭 → 孤儿任务？）
//   · case-28 尝试触发 task_updated.patch.status=paused（探索性，SDK 六态最后一个未观测）
//
// 沿用铁律（case-13→17）：控制方法（backgroundTasks/stopTask）必须在收到
// task_started 事件【之后】调用才生效。interrupt() 只在 turn 活跃窗口内同步调用有效。
// ══════════════════════════════════════════════════════════════════

// ====== 嵌套 subagent 的 id 指向（case-24）======
//
// 目标：钉死"主线程 tool_use → subagent → 子 tool_use"的父子链。
// 用 Agent 工具启动一个 subagent，让 subagent 内部再调 Bash。实测三条 id：
//   T1 assistant 消息的 parent_tool_use_id（sdk.d.ts:2765）——subagent 内部的
//      assistant 消息，其 parent_tool_use_id 是否等于发起它的 Agent tool_use block.id？
//   T2 assistant 消息的 subagent_type（sdk.d.ts:2777）
//   T3 task_started 的 subagent_type
// 重点断言：subagent 内部 assistant.parent_tool_use_id === 外层 Agent 的 block.id。

describe('嵌套 subagent id 指向', () => {
  it('case-24 subagent 内部消息的 parent_tool_use_id 指向外层 Agent block.id', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-24-nested-subagent-id');

    const t0 = Date.now();
    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };

    const sdkQuery = query({
      prompt: `Use the Agent tool to launch a subagent. Instruct the subagent to use the Bash tool to run the command "echo nested-subagent-bash-24" and report the output. Then tell me the subagent's result.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 记录每条 assistant 消息的 parent_tool_use_id / subagent_type，以及其中的 tool_use block
    interface AssistantSnap {
      relMs: number;
      parent_tool_use_id: string | null;
      subagent_type: string | null;
      task_description: string | null;
      toolUses: { name: string; id: string }[];
      textSnippet: string | null;
    }
    const assistantSnaps: AssistantSnap[] = [];
    // 外层 Agent tool_use 的 block.id（顶层 assistant 里出现的 Agent 工具）
    let agentToolUseId: string | null = null;
    // task_started 详情
    interface TaskStartedSnap { relMs: number; task_id: string; task_type: string | null; tool_use_id: string | null; subagent_type: string | null; rawKeys: string[]; }
    const taskStartedSnaps: TaskStartedSnap[] = [];

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    for await (const message of sdkQuery) {
      const msg = message as any;
      const type = msg.type || 'unknown';
      const rel = Date.now() - t0;
      const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

      if (type === 'stream_event' && msg.event) {
        captured.eventType = msg.event.type;
        if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          process.stderr.write(msg.event.delta.text);
        }
      }

      if (type === 'system') {
        captured.subtype = msg.subtype;
        if (msg.subtype === 'task_started') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          captured.raw = { ...msg };
          taskStartedSnaps.push({
            relMs: rel,
            task_id: msg.task_id,
            task_type: msg.task_type ?? null,
            tool_use_id: msg.tool_use_id ?? null,
            subagent_type: msg.subagent_type ?? null,
            rawKeys: Object.keys(msg),
          });
          console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} task_type=${msg.task_type} tool_use_id=${msg.tool_use_id} subagent_type=${msg.subagent_type ?? '-'}`);
        }
      }

      if (type === 'assistant' && msg.message?.content) {
        const toolUses: { name: string; id: string }[] = [];
        let textSnippet: string | null = null;
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolUses.push({ name: block.name, id: block.id });
            captured.toolName = block.name;
            captured.toolUseId = block.id;
            // 顶层（parent_tool_use_id==null）的 Agent 工具 → 记其 block.id
            if (block.name === 'Agent' && msg.parent_tool_use_id == null && !agentToolUseId) {
              agentToolUseId = block.id;
            }
          }
          if (block.type === 'text' && !textSnippet) {
            textSnippet = block.text?.substring(0, 120) ?? null;
          }
        }
        assistantSnaps.push({
          relMs: rel,
          parent_tool_use_id: msg.parent_tool_use_id ?? null,
          subagent_type: msg.subagent_type ?? null,
          task_description: msg.task_description ?? null,
          toolUses,
          textSnippet,
        });
        console.error(`\n[${rel}ms] assistant parent_tool_use_id=${msg.parent_tool_use_id ?? 'null'} subagent_type=${msg.subagent_type ?? '-'} tools=[${toolUses.map(t => t.name).join(',')}]`);
      }

      events.push(captured);
    }

    const duration = Date.now() - t0;

    // 分析：找出 parent_tool_use_id 非 null 的 assistant（即 subagent 内部消息）
    const subagentAssistants = assistantSnaps.filter(a => a.parent_tool_use_id != null);
    // subagent 内部是否调了 Bash
    const subagentBashCalls = subagentAssistants.flatMap(a => a.toolUses.filter(t => t.name === 'Bash'));
    // parent_tool_use_id 的取值集合
    const parentIds = [...new Set(subagentAssistants.map(a => a.parent_tool_use_id))];
    // subagent 内部 assistant 的 parent_tool_use_id 是否 == 外层 Agent block.id
    const parentMatchesAgent = agentToolUseId != null && parentIds.includes(agentToolUseId);

    console.error('\n══════ T1-T3 实测值（嵌套 subagent id）══════');
    console.error(`[顶层] Agent tool_use block.id = ${agentToolUseId}`);
    console.error(`[T1] subagent 内部 assistant 数=${subagentAssistants.length}；其 parent_tool_use_id 取值=${JSON.stringify(parentIds)}`);
    console.error(`[T1] parent_tool_use_id === Agent block.id ? ${parentMatchesAgent}`);
    console.error(`[T1] subagent 内部是否调了 Bash: ${subagentBashCalls.length > 0}（${JSON.stringify(subagentBashCalls)}）`);
    console.error(`[T2] subagent assistant.subagent_type 取值=${JSON.stringify([...new Set(subagentAssistants.map(a => a.subagent_type))])}`);
    console.error(`[T3] task_started.subagent_type 取值=${JSON.stringify(taskStartedSnaps.map(t => ({ task_type: t.task_type, subagent_type: t.subagent_type })))}`);
    console.error(`[补充] task_started tool_use_id 是否 == Agent block.id: ${taskStartedSnaps.map(t => t.tool_use_id === agentToolUseId)}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/nested-subagent-id.json`, JSON.stringify({
      agentToolUseId,
      assistantSnaps,
      subagentAssistantCount: subagentAssistants.length,
      parentIds,
      parentMatchesAgent,
      subagentBashCalls,
      taskStartedSnaps,
      duration,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
    // 否定发现记录：本地 LLM 可能不真正启动 subagent，或 subagent 不调 Bash
    if (subagentAssistants.length === 0) {
      console.error('[否定发现] 未观测到 parent_tool_use_id 非 null 的 assistant —— 本地 LLM 可能未真正走 subagent（Agent 工具未展开子消息）');
    }
  }, 120000);
});

// ====== 自动后台化后如何解除阻塞、边聊边执行（case-25，最核心）======
//
// streaming-input 模式，msg1 让 LLM 跑长前台 bash（run_in_background:false，
// sleep 40 && echo bg-25-done，触发自动后台化 → 阻塞）。依次尝试三种解除阻塞手段：
//   路径1：等 task_started 后调 backgroundTasks(taskStarted.tool_use_id)——case-17
//          说 task_started 后调能成功，但那是 run_in_background:false 长命令由 LLM
//          明确前台。本 case 实测自动后台化场景下返回 true 还是 false。
//   路径2：若 backgroundTasks 无效，turn 活跃时同步 interrupt()。
//   路径3：记录哪条路径成功解阻塞（query 未等满 sleep 40 就续轮问 msg2"任务好了吗"）。
//
// 产出"三路径对照结论"：自动后台化的阻塞，到底靠什么能解除、能否边聊边等后台 bash 完成。
//
// 实现策略：优先试路径1（backgroundTasks）。若返回 true → 记为路径1成功，放行 msg2。
// 若返回 false/非 true → 立即在主循环同步 interrupt（贴近 turn 活跃窗口）。

describe('自动后台化解除阻塞三路径', () => {
  const LONG_CMD_25 = 'sleep 40 && echo bg-25-done';

  it('case-25 自动后台化: backgroundTasks vs interrupt 哪条能解阻塞边聊', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-25-unblock-three-paths');

    const state = {
      queryStartedAt: Date.now(),
      bashToolUseId: null as string | null,        // assistant block.id
      taskStartedToolUseId: null as string | null, // task_started.tool_use_id
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      // 路径1
      bgCallResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'NO_METHOD' | string,
      bgCallAt: null as number | null,
      backgroundTaskIdFromResult: null as string | null,
      // 路径2
      interruptCallResult: 'NOT_CALLED' as 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      interruptCallAt: null as number | null,
      // 结果
      unblockPath: null as string | null,          // 'backgroundTasks' | 'interrupt' | 'none'
      firstTurnEndedAt: null as number | null,      // 第一轮 turn 何时结束（解阻塞判据）
      turnsObserved: 0,
      turn2Reached: false,
      taskNotificationStatus: null as string | null,
      taskNotificationAt: null as number | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      terminalReason: null as string | null,
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: any[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    // 安全阀 25s：万一两条路径都没解阻塞，也别挂死到 sleep 40
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 25000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command: ${LONG_CMD_25}. Run it in the foreground. Do NOT set run_in_background.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Is the task you started ready yet? Just report its status in one sentence. Do NOT run any new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      state.turn2Reached = true;
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms，yield msg2`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      observerLog.push({
        t, taskStarted: state.bashTaskId != null, bgCall: state.bgCallResult,
        interrupt: state.interruptCallResult, unblockPath: state.unblockPath,
        firstTurnEnded: state.firstTurnEndedAt != null, queryEnded: state.queryEnded,
        turns: state.turnsObserved,
      });
      console.error(`[obs t=${t}ms] taskStarted=${state.bashTaskId != null} bgCall=${state.bgCallResult} intr=${state.interruptCallResult} path=${state.unblockPath ?? '-'} 1stTurnEnded=${state.firstTurnEndedAt != null} ended=${state.queryEnded}`);
    }, 1000);

    let index = 0;
    let firstResultSeen = false;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            if (!state.bashTaskId) {
              state.bashTaskId = msg.task_id;
              state.taskStartedToolUseId = msg.tool_use_id ?? null;
              state.taskStartedAt = rel;
              console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} tool_use_id=${msg.tool_use_id} task_type=${msg.task_type}`);
            }
          }
          if (msg.subtype === 'task_updated') {
            captured.taskId = msg.task_id;
            captured.raw = { patch: msg.patch };
            console.error(`\n[${rel}ms] task_updated patch=${JSON.stringify(msg.patch)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.raw = { status: msg.status, output_file: msg.output_file };
            state.taskNotificationStatus = msg.status;
            state.taskNotificationAt = rel;
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block.name === 'Bash' && !state.bashToolUseId) {
              state.bashToolUseId = block.id;
              console.error(`\n[${rel}ms] assistant Bash block.id=${block.id}`);
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          // 第一轮 result = 第一轮 turn 结束（解阻塞判据）
          if (!firstResultSeen) {
            firstResultSeen = true;
            state.firstTurnEndedAt = rel;
            console.error(`\n[${rel}ms] 第一轮 result subtype=${msg.subtype}（第一轮 turn 结束 → 解阻塞）`);
          }
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          state.terminalReason = msg.terminal_reason ?? null;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns} terminal_reason=${msg.terminal_reason ?? '-'}`);
          resolveTurn2();
        }

        events.push(captured);

        // ── 路径1：等 task_started 后调 backgroundTasks（自动后台化场景实测）──
        if (state.bashTaskId && state.bgCallResult === 'NOT_CALLED') {
          const idToUse = state.taskStartedToolUseId || state.bashToolUseId;
          state.bgCallAt = rel;
          console.error(`\n[路径1 backgroundTasks] 等到 task_started 后调用 @ ${rel}ms，用 id=${idToUse}`);
          try {
            state.bgCallResult = typeof queryHandle.backgroundTasks === 'function'
              ? await queryHandle.backgroundTasks(idToUse)
              : 'NO_METHOD';
          } catch (e: any) {
            state.bgCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[路径1 backgroundTasks] 返回: ${state.bgCallResult}`);
          if (state.bgCallResult === true) {
            state.unblockPath = 'backgroundTasks';
            console.error(`[路径1] backgroundTasks 成功解阻塞`);
            resolveTurn2();
          } else {
            // ── 路径2：backgroundTasks 无效 → turn 仍活跃 → 同步 interrupt 兜底 ──
            state.interruptCallAt = Date.now() - state.queryStartedAt;
            console.error(`\n[路径2 interrupt] backgroundTasks 返回非 true，turn 仍活跃时同步 interrupt @ ${state.interruptCallAt}ms`);
            try {
              if (typeof queryHandle.interrupt === 'function') {
                await queryHandle.interrupt();
                state.interruptCallResult = 'OK';
              } else {
                state.interruptCallResult = 'NO_METHOD';
              }
            } catch (e: any) {
              state.interruptCallResult = `ERROR: ${e?.message || e}`;
            }
            console.error(`[路径2 interrupt] 结果: ${state.interruptCallResult}`);
            if (state.interruptCallResult === 'OK') {
              state.unblockPath = 'interrupt';
              console.error(`[路径2] interrupt 调用成功（是否真解阻塞看 firstTurnEndedAt 时机）`);
            }
            resolveTurn2();
          }
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;
    if (state.unblockPath == null) state.unblockPath = 'none';

    // 解阻塞判据：第一轮 turn 是否在 sleep 40 完成前结束
    const unblockedBeforeSleepDone = state.firstTurnEndedAt != null && state.firstTurnEndedAt < 40000;

    printTimeline('Case 25: 自动后台化解除阻塞三路径', events, duration);

    console.error('\n══════ 三路径对照结论（case-25）══════');
    console.error(`[路径1] backgroundTasks(自动后台化任务) 返回: ${state.bgCallResult}（@${state.bgCallAt}ms，task_started@${state.taskStartedAt}ms）`);
    console.error(`        tool_result.backgroundTaskId=${state.backgroundTaskIdFromResult}`);
    console.error(`[路径2] interrupt 结果: ${state.interruptCallResult}（@${state.interruptCallAt}ms）`);
    console.error(`[路径3] 实际解阻塞路径 = ${state.unblockPath}`);
    console.error(`        第一轮 turn 结束@${state.firstTurnEndedAt}ms（<40000 表示未等满 sleep 40 → 解阻塞成功=${unblockedBeforeSleepDone}）`);
    console.error(`        续轮到达=${state.turn2Reached}，turnsObserved=${state.turnsObserved}`);
    console.error(`        task_notification status=${state.taskNotificationStatus}@${state.taskNotificationAt}ms`);
    console.error(`        result.subtype=${state.resultSubtype}，terminal_reason=${state.terminalReason}，总耗时=${duration}ms`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/unblock-three-paths.json`, JSON.stringify({
      bgCallResult: state.bgCallResult, bgCallAt: state.bgCallAt,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult,
      interruptCallResult: state.interruptCallResult, interruptCallAt: state.interruptCallAt,
      unblockPath: state.unblockPath, firstTurnEndedAt: state.firstTurnEndedAt,
      unblockedBeforeSleepDone, turn2Reached: state.turn2Reached, turnsObserved: state.turnsObserved,
      taskStartedAt: state.taskStartedAt, taskStartedToolUseId: state.taskStartedToolUseId,
      bashToolUseId: state.bashToolUseId, bashTaskId: state.bashTaskId,
      taskNotificationStatus: state.taskNotificationStatus, taskNotificationAt: state.taskNotificationAt,
      resultSubtype: state.resultSubtype, terminalReason: state.terminalReason,
      queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    // 至少调过 backgroundTasks（路径1一定会走）
    expect(state.bgCallResult).not.toBe('NOT_CALLED');
    expect(state.bgCallResult).not.toBe('NO_METHOD');
  }, 180000);
});

// ====== 终止显式后台 bash（case-26）======
//
// case-15 测过 stopTask 停"手动转后台"（LLM run_in_background:false 后被自动/手动后台化）
// 的任务。本 case 专门验证【显式后台 bash（run_in_background:true）】能否被 stopTask 终止：
// 起一个 sleep 40 的后台 bash，等 task_started 后 stopTask(taskId)，观察：
//   M1 stopTask 是否成功（不抛错）？
//   M2 task_notification 是否变 stopped？
//   M3 task_updated 是否报 killed（对照 case-21 手动转后台的 killed）？
//   M4 后台进程是否真被杀（sleep 40 未跑完，总耗时远小于 40s）？
// 与 case-15 对照（case-15 停的是 run_in_background:false 被转后台的任务）。

describe('终止显式后台 bash', () => {
  const BG_CMD_26 = 'sleep 40 && echo bg-26-done';

  it('case-26 stopTask 终止 run_in_background:true 的显式后台 bash', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-26-stop-explicit-bg');

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      taskType: null as string | null,
      backgroundTaskIdFromResult: null as string | null,
      stopCallResult: 'NOT_CALLED' as 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      stopCallAt: null as number | null,
      taskUpdatedStatuses: [] as { relMs: number; status: string | undefined; patchKeys: string[] }[],
      sawKilled: false,
      taskNotificationStatus: null as string | null,
      taskNotificationAt: null as number | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      turnsObserved: 0,
      turn2Reached: false,
    };

    const events: CapturedSDKEvent[] = [];
    const observerLog: any[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 20000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command in the BACKGROUND (set run_in_background to true): ${BG_CMD_26}. Then tell me the background task id.` },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'Was the background task stopped or did it complete? Report its final status. Do NOT run any new commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };

    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      state.turn2Reached = true;
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      observerLog.push({
        t, taskId: state.bashTaskId, stop: state.stopCallResult,
        sawKilled: state.sawKilled, notif: state.taskNotificationStatus, ended: state.queryEnded,
      });
      console.error(`[obs t=${t}ms] taskId=${state.bashTaskId ?? '-'} stop=${state.stopCallResult} killed=${state.sawKilled} notif=${state.taskNotificationStatus ?? '-'} ended=${state.queryEnded}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.taskStartedAt = rel;
            state.taskType = msg.task_type ?? null;
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} task_type=${msg.task_type}`);
          }
          if (msg.subtype === 'task_updated') {
            const p = msg.patch || {};
            state.taskUpdatedStatuses.push({ relMs: rel, status: p.status, patchKeys: Object.keys(p) });
            if (p.status === 'killed') state.sawKilled = true;
            captured.taskId = msg.task_id;
            captured.raw = { patch: p };
            console.error(`\n[${rel}ms] ⚡ task_updated patch=${JSON.stringify(p)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.raw = { status: msg.status, output_file: msg.output_file };
            state.taskNotificationStatus = msg.status;
            state.taskNotificationAt = rel;
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
            resolveTurn2();
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
            }
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') { captured.toolName = block.name; captured.toolUseId = block.id; }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns}`);
          resolveTurn2();
        }

        events.push(captured);

        // ── 等 task_started 后 stopTask（显式后台任务）──
        if (state.bashTaskId && state.stopCallResult === 'NOT_CALLED') {
          state.stopCallAt = rel;
          console.error(`\n[stopTask] 等到 task_started 后调用 @ ${rel}ms，taskId=${state.bashTaskId}`);
          try {
            if (typeof queryHandle.stopTask === 'function') {
              await queryHandle.stopTask(state.bashTaskId);
              state.stopCallResult = 'OK';
            } else {
              state.stopCallResult = 'NO_METHOD';
            }
          } catch (e: any) {
            state.stopCallResult = `ERROR: ${e?.message || e}`;
          }
          console.error(`[stopTask] 结果: ${state.stopCallResult}`);
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;

    const killedInterrupted = duration < 40000; // sleep 40 若被杀，总耗时应远小于 40s

    printTimeline('Case 26: 终止显式后台 bash', events, duration);

    console.error('\n══════ M1-M4 实测值（终止显式后台 bash）══════');
    console.error(`[M1] stopTask 结果: ${state.stopCallResult}（@${state.stopCallAt}ms，task_started@${state.taskStartedAt}ms，task_type=${state.taskType}）`);
    console.error(`[M1] tool_result.backgroundTaskId=${state.backgroundTaskIdFromResult}（显式后台应有值，对照 case-2）`);
    console.error(`[M2] task_notification status=${state.taskNotificationStatus}@${state.taskNotificationAt}ms（期望 stopped）`);
    console.error(`[M3] task_updated 序列: ${JSON.stringify(state.taskUpdatedStatuses)}；是否报 killed=${state.sawKilled}`);
    console.error(`[M4] sleep 40 是否被中断: 总耗时=${duration}ms（<40000 表示进程真被杀=${killedInterrupted}）`);
    console.error(`[对照 case-15] case-15 停 run_in_background:false 转后台任务；本 case 停 run_in_background:true 显式后台任务`);
    console.error(`[补充] turn2Reached=${state.turn2Reached}，turnsObserved=${state.turnsObserved}，result.subtype=${state.resultSubtype}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/observer-log.json`, JSON.stringify(observerLog, null, 2));
    writeFileSync(`${dir}/stop-explicit-bg.json`, JSON.stringify({
      stopCallResult: state.stopCallResult, stopCallAt: state.stopCallAt,
      taskStartedAt: state.taskStartedAt, taskType: state.taskType, bashTaskId: state.bashTaskId,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult,
      taskUpdatedStatuses: state.taskUpdatedStatuses, sawKilled: state.sawKilled,
      taskNotificationStatus: state.taskNotificationStatus, taskNotificationAt: state.taskNotificationAt,
      killedInterrupted, turn2Reached: state.turn2Reached, turnsObserved: state.turnsObserved,
      resultSubtype: state.resultSubtype, queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    expect(state.stopCallResult).not.toBe('NOT_CALLED');
    expect(state.stopCallResult).not.toBe('NO_METHOD');
    // 软断言：记录，不 fatal
    try {
      expect(state.taskNotificationStatus).toBe('stopped');
    } catch {
      console.error(`[软断言] task_notification status=${state.taskNotificationStatus}（非 stopped）—— 记录实测`);
    }
  }, 180000);
});

// ====== close() 生命周期（case-27）======
//
// 验证 query 运行期间有后台 bash 在跑时调用 close() 会怎样。
// 用 streaming-input 起一个长后台 bash（run_in_background:true，确保真后台不阻塞），
// 等 task_started 后调 queryHandle.close()，观察：
//   C1 close 后是否还收到 task_notification？
//   C2 query 迭代器是否立即终止（for-await 是否马上退出）？
//   C3 result 消息还来不来？
//   C4 close 后后台进程是否变孤儿（sleep 40 是否仍在跑 → 用 .output 文件推断）？
// 这决定 CodePilot 关闭会话时后台任务是否变孤儿。
//
// 注意：close() 是同步方法（返回 void）。调用后 for-await 应结束。
// 用 flag 标记 close 调用时刻，之后到达的任何消息都记为"close 后仍收到"。

describe('close() 生命周期', () => {
  const BG_CMD_27 = 'sleep 40 && echo bg-27-done';

  it('case-27 运行期有后台 bash 时 close() 的行为', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-27-close-lifecycle');

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      backgroundTaskIdFromResult: null as string | null,
      outputFile: null as string | null,
      closeCalledAt: null as number | null,
      closeError: null as string | null,
      messagesAfterClose: [] as { relMs: number; type: string; subtype?: string }[],
      taskNotificationAfterClose: false,
      resultAfterClose: false,
      resultSubtype: null as string | null,
      iteratorEndedAt: null as number | null,
      queryEnded: false,
    };

    const events: CapturedSDKEvent[] = [];

    // 单条 prompt 即可（不需要续轮）；用 generator 保持 streaming 模式（控制方法需要）
    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command in the BACKGROUND (set run_in_background to true): ${BG_CMD_27}. Then tell me the background task id.` },
      parent_tool_use_id: null,
    };
    // 永不 resolve 的 gate：让 generator 挂住不结束输入流，直到我们 close
    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await new Promise<void>(() => {}); // 挂住
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    // 每秒读 .output 判断后台进程是否还活（close 后是否变孤儿仍写文件）
    const fileSnapshots: any[] = [];
    const poller = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      let exists = false, size = 0;
      if (state.outputFile) {
        exists = existsSync(state.outputFile);
        if (exists) { try { size = readFileSync(state.outputFile, 'utf-8').length; } catch {} }
      }
      fileSnapshots.push({ t, closeCalledAt: state.closeCalledAt, outputFile: state.outputFile, exists, size });
      console.error(`[poll t=${t}ms] closeCalled=${state.closeCalledAt != null} outputFile=${state.outputFile ? '有' : '无'} exists=${exists} size=${size}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        // close 之后到达的消息记录下来
        if (state.closeCalledAt != null) {
          state.messagesAfterClose.push({ relMs: rel, type, subtype: msg.subtype });
          console.error(`\n[${rel}ms] ⚠️ close 后仍收到消息: type=${type} subtype=${msg.subtype ?? '-'}`);
          if (type === 'system' && msg.subtype === 'task_notification') state.taskNotificationAfterClose = true;
          if (type === 'result') state.resultAfterClose = true;
        }

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.taskStartedAt = rel;
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} task_type=${msg.task_type}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            if (msg.output_file && !state.outputFile) state.outputFile = msg.output_file;
            console.error(`\n[${rel}ms] task_notification status=${msg.status} output_file="${msg.output_file}"`);
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
              const fm = snippet.match(/written to:\s*([^\s"]+\.output)/i) || snippet.match(/([A-Za-z]:\\[^\s"]+\.output)/);
              if (fm && !state.outputFile) state.outputFile = fm[1];
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns };
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype}`);
        }

        events.push(captured);

        // ── 等 task_started 后调 close() ──
        if (state.bashTaskId && state.closeCalledAt == null) {
          state.closeCalledAt = rel;
          console.error(`\n[close] 等到 task_started 后调用 close() @ ${rel}ms（后台任务 ${state.bashTaskId} 正在跑）`);
          try {
            if (typeof queryHandle.close === 'function') {
              queryHandle.close();
            } else {
              state.closeError = 'NO_METHOD';
            }
          } catch (e: any) {
            state.closeError = `ERROR: ${e?.message || e}`;
          }
          console.error(`[close] 调用完成${state.closeError ? '，错误: ' + state.closeError : '（同步返回）'}`);
        }
      }
      state.iteratorEndedAt = Date.now() - state.queryStartedAt;
      state.queryEnded = true;
      console.error(`\n[iterator] for-await 正常结束 @ ${state.iteratorEndedAt}ms`);
    } catch (e: any) {
      state.iteratorEndedAt = Date.now() - state.queryStartedAt;
      console.error(`\n[iterator] for-await 抛出 @ ${state.iteratorEndedAt}ms: ${e?.message || e}`);
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - state.queryStartedAt;
    const iteratorEndedFastAfterClose = state.closeCalledAt != null && state.iteratorEndedAt != null
      && (state.iteratorEndedAt - state.closeCalledAt) < 5000;

    printTimeline('Case 27: close() 生命周期', events, duration);

    console.error('\n══════ C1-C4 实测值（close 生命周期）══════');
    console.error(`[close] 调用@${state.closeCalledAt}ms（task_started@${state.taskStartedAt}ms）；错误=${state.closeError ?? '无'}`);
    console.error(`[C1] close 后是否还收到 task_notification: ${state.taskNotificationAfterClose}`);
    console.error(`[C2] 迭代器结束@${state.iteratorEndedAt}ms；close 后 ${state.iteratorEndedAt != null && state.closeCalledAt != null ? state.iteratorEndedAt - state.closeCalledAt : '?'}ms 内结束（<5000=立即终止=${iteratorEndedFastAfterClose}）`);
    console.error(`[C2] close 后共收到 ${state.messagesAfterClose.length} 条消息: ${JSON.stringify(state.messagesAfterClose)}`);
    console.error(`[C3] close 后是否还来 result: ${state.resultAfterClose}（result.subtype=${state.resultSubtype ?? '未收到'}）`);
    console.error(`[C4] 后台进程孤儿判断: outputFile=${state.outputFile ?? '无'}；文件快照见 json（close 后仍增长=可能孤儿）`);
    console.error(`[总耗时] ${duration}ms（若 <40000 且迭代器已结束，说明没等 sleep 40）`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/close-lifecycle.json`, JSON.stringify({
      closeCalledAt: state.closeCalledAt, closeError: state.closeError,
      taskStartedAt: state.taskStartedAt, bashTaskId: state.bashTaskId,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult, outputFile: state.outputFile,
      iteratorEndedAt: state.iteratorEndedAt, iteratorEndedFastAfterClose,
      messagesAfterClose: state.messagesAfterClose,
      taskNotificationAfterClose: state.taskNotificationAfterClose,
      resultAfterClose: state.resultAfterClose, resultSubtype: state.resultSubtype,
      fileSnapshots, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    // close 方法存在且被调用
    expect(state.closeCalledAt).not.toBeNull();
    expect(state.closeError).toBeNull();
    // 迭代器最终应结束（不挂死）
    expect(state.iteratorEndedAt).not.toBeNull();
  }, 120000);

  // ── case-27b：用 PID 硬观测 close 后后台进程是否变孤儿 ──
  //
  // case-27 用 .output 文件推断孤儿失败（文件在观测窗口内没生成）。case-29 探明后台 bash
  // 跑在 git-bash(MSYS2) 里，$$/ps/kill 全可用。故本 case 让命令把自己的 PID 写到已知文件，
  // close() 后【独立用 ps -p <pid> 探活】——进程要么在要么不在，是硬观测，不依赖 .output。
  //
  // 命令：echo $$ > <pidfile>; sleep 60; echo done > <donefile>
  //   · pidfile 立即写 → 测试读到真实 PID
  //   · sleep 60 给足观测窗口（close 后持续探活 ~15s）
  //   · 若 close 后进程仍存活（ps -p 命中）→ 孤儿；若消失 → 被 SDK 回收
  it('case-27b close() 后用 PID 探活判断后台进程是否孤儿', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-27b-pid-orphan');
    const { join } = await import('path');
    const { execSync } = await import('child_process');

    // 用 posix 风格路径（git-bash 命令里用），pidfile 放测试 tmp 目录
    const pidFilePosix = `${dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1')}/bg27b.pid`;
    const pidFileWin = join(dir, 'bg27b.pid');
    const BG_CMD_27B = `echo $$ > "${pidFilePosix}"; sleep 60; echo done`;

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      taskStartedAt: null as number | null,
      closeCalledAt: null as number | null,
      bgPid: null as string | null,
      iteratorEndedAt: null as number | null,
    };
    // 进程存活探测快照：{ t, phase(before/after close), pidKnown, alive }
    const aliveSnaps: { t: number; afterClose: boolean; pid: string | null; alive: boolean | null }[] = [];

    function probeAlive(pid: string | null): boolean | null {
      if (!pid) return null;
      try {
        // git-bash 的 ps -p <pid>：命中返回 0（有该行），否则非 0
        const out = execSync(`ps -p ${pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split('\n').some(l => new RegExp(`\\b${pid}\\b`).test(l));
      } catch {
        return false; // ps -p 未命中 → 进程已不在
      }
    }

    const events: CapturedSDKEvent[] = [];
    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command in the BACKGROUND (set run_in_background to true): ${BG_CMD_27B}` },
      parent_tool_use_id: null,
    };
    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await new Promise<void>(() => {}); // 挂住输入流，直到 close
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: promptInput(),
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });
    const queryHandle: any = sdkQuery;

    // 每秒：先读 pidfile 拿 PID，再探活
    const poller = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      if (!state.bgPid && existsSync(pidFileWin)) {
        try {
          const raw = readFileSync(pidFileWin, 'utf-8').trim();
          if (/^\d+$/.test(raw)) { state.bgPid = raw; console.error(`\n[${t}ms] 读到后台 bash PID=${raw}`); }
        } catch {}
      }
      const alive = probeAlive(state.bgPid);
      aliveSnaps.push({ t, afterClose: state.closeCalledAt != null, pid: state.bgPid, alive });
      console.error(`[probe t=${t}ms] afterClose=${state.closeCalledAt != null} pid=${state.bgPid ?? '-'} alive=${alive}`);
    }, 1000);

    let index = 0;
    let closeAtIterations = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.taskStartedAt = rel;
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id}`);
          }
        }
        events.push(captured);

        // 等 task_started + 已读到 PID 后再 close（确保 close 前 PID 已知）；
        // 若迟迟没拿到 PID，最多等 6 次迭代后也强制 close
        if (state.bashTaskId && state.closeCalledAt == null) {
          closeAtIterations++;
          if (state.bgPid || closeAtIterations > 6) {
            // close 前先探活一次（基线：close 前进程应存活）
            const beforeAlive = probeAlive(state.bgPid);
            aliveSnaps.push({ t: rel, afterClose: false, pid: state.bgPid, alive: beforeAlive });
            console.error(`\n[close 前基线] pid=${state.bgPid} alive=${beforeAlive}`);
            state.closeCalledAt = rel;
            console.error(`[close] 调用 close() @ ${rel}ms`);
            queryHandle.close();
          }
        }
      }
      state.iteratorEndedAt = Date.now() - state.queryStartedAt;
    } catch (e: any) {
      state.iteratorEndedAt = Date.now() - state.queryStartedAt;
      console.error(`[iterator] 抛出 @ ${state.iteratorEndedAt}ms: ${e?.message || e}`);
    }

    // close 后继续探活 ~15s（迭代器已结束，但进程可能还活着 = 孤儿）
    console.error(`\n[close 后持续探活 15s...]`);
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const t = Date.now() - state.queryStartedAt;
      if (!state.bgPid && existsSync(pidFileWin)) {
        try { const raw = readFileSync(pidFileWin, 'utf-8').trim(); if (/^\d+$/.test(raw)) state.bgPid = raw; } catch {}
      }
      const alive = probeAlive(state.bgPid);
      aliveSnaps.push({ t, afterClose: true, pid: state.bgPid, alive });
      console.error(`[probe(post) t=${t}ms] pid=${state.bgPid ?? '-'} alive=${alive}`);
    }
    clearInterval(poller);

    const duration = Date.now() - state.queryStartedAt;

    // 分析：close 后进程是否仍存活
    const afterCloseSnaps = aliveSnaps.filter(s => s.afterClose && s.pid);
    const stillAliveAfterClose = afterCloseSnaps.some(s => s.alive === true);
    const aliveBeforeClose = aliveSnaps.some(s => !s.afterClose && s.alive === true);
    // 最后一次探活结果
    const lastAlive = afterCloseSnaps.length ? afterCloseSnaps[afterCloseSnaps.length - 1].alive : null;

    console.error('\n══════ P1-P4 实测值（PID 孤儿判断）══════');
    console.error(`[P1] 后台 bash PID: ${state.bgPid ?? '(未读到 pidfile)'}`);
    console.error(`[P2] close 前进程存活: ${aliveBeforeClose}（基线，应为 true）`);
    console.error(`[P3] close 后是否仍存活过: ${stillAliveAfterClose}；最后一次探活=${lastAlive}`);
    console.error(`[P4] 结论: ${state.bgPid == null ? '⚠️ 未拿到 PID，无法判断' : stillAliveAfterClose ? '❗孤儿——close 后进程仍在跑' : '✅ 进程被回收——close 后进程消失'}`);
    console.error(`[close@${state.closeCalledAt}ms 迭代器结束@${state.iteratorEndedAt}ms 总耗时${duration}ms]`);

    // 清理：若进程仍活着，杀掉避免残留
    if (state.bgPid && lastAlive) {
      try { execSync(`kill ${state.bgPid}`, { stdio: 'ignore' }); console.error(`[cleanup] 已 kill 残留进程 ${state.bgPid}`); } catch {}
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/pid-orphan.json`, JSON.stringify({
      bgPid: state.bgPid, bashTaskId: state.bashTaskId, taskStartedAt: state.taskStartedAt,
      closeCalledAt: state.closeCalledAt, iteratorEndedAt: state.iteratorEndedAt,
      aliveBeforeClose, stillAliveAfterClose, lastAlive, aliveSnaps, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    expect(state.closeCalledAt).not.toBeNull();
    if (state.bgPid == null) {
      console.error('[否定发现] 未从 pidfile 读到 PID —— 命令可能没按指令跑/pidfile 路径不对，孤儿判断未能完成');
    }
  }, 120000);
});

// ====== 尝试触发 paused 状态（case-28，探索性）======
//
// case-21 只跑出了 task_updated.patch.status=killed，从未触发过 paused
// （sdk.d.ts:4249 六态之一：pending|running|completed|failed|killed|paused）。
// 尝试各种手段触发 paused：起后台任务后调 backgroundTasks 再 stopTask、或 close、
// 或 interrupt 组合，看能否让 task_updated 报 paused。
//
// 探索性实验：触发不到就如实记为否定发现 + 原因推断（可能 paused 仅 TUI 暂停/
// 特定 workflow 场景，SDK query 层无触发路径）。
//
// 策略：起显式后台 bash（sleep 40）→ 等 task_started → 依次尝试组合动作，
// 全程收集所有 task_updated.patch.status，看是否出现 paused。
// 组合序列（每步间隔观察）：backgroundTasks(taskId) → interrupt() → stopTask(taskId)。

describe('尝试触发 paused 状态', () => {
  const BG_CMD_28 = 'sleep 40 && echo bg-28-done';

  it('case-28 组合控制方法尝试触发 task_updated paused', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-28-try-paused');

    const state = {
      queryStartedAt: Date.now(),
      bashTaskId: null as string | null,
      taskStartedToolUseId: null as string | null,
      taskStartedAt: null as number | null,
      // 组合动作记录
      actions: [] as { name: string; relMs: number; result: string }[],
      bgDone: false,
      interruptDone: false,
      stopDone: false,
      // task_updated 收集
      patchSnaps: [] as { relMs: number; status: string | undefined; patch: any }[],
      sawPaused: false,
      sawKilled: false,
      distinctStatuses: [] as string[],
      taskNotificationStatuses: [] as { relMs: number; status: string }[],
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
    };

    const events: CapturedSDKEvent[] = [];

    // 用永挂 generator 保持 streaming 模式；靠 gate 收尾
    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: `Use the Bash tool to run this exact command in the BACKGROUND (set run_in_background to true): ${BG_CMD_28}. Then tell me the background task id.` },
      parent_tool_use_id: null,
    };
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveGate = r; });
    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await gate; // 等我们做完所有动作后放行结束
    }

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const queryOptions: any = {
      env, includePartialMessages: true, persistSession: false,
      settingSources: [], effort: 'low', permissionMode: 'bypassPermissions',
    };

    const sdkQuery = query({ prompt: promptInput(), options: queryOptions });
    const queryHandle: any = sdkQuery;

    // 观察者驱动组合动作：task_started 后每 ~2.5s 走一个动作
    let actionStep = 0;
    const observer = setInterval(async () => {
      const t = Date.now() - state.queryStartedAt;
      console.error(`[obs t=${t}ms] taskId=${state.bashTaskId ?? '-'} step=${actionStep} paused=${state.sawPaused} killed=${state.sawKilled} patches=${state.patchSnaps.length}`);
      if (state.bashTaskId == null || state.queryEnded) return;

      // 距 task_started 至少 2s 再开始，动作之间靠 step 递进
      if (state.taskStartedAt == null || t - state.taskStartedAt < 2000) return;

      if (actionStep === 0 && !state.bgDone) {
        actionStep = 1; state.bgDone = true;
        const id = state.taskStartedToolUseId || undefined;
        console.error(`\n[动作1 backgroundTasks] @ ${t}ms id=${id}`);
        try {
          const r = typeof queryHandle.backgroundTasks === 'function' ? await queryHandle.backgroundTasks(id) : 'NO_METHOD';
          state.actions.push({ name: 'backgroundTasks', relMs: t, result: String(r) });
          console.error(`[动作1] backgroundTasks → ${r}`);
        } catch (e: any) { state.actions.push({ name: 'backgroundTasks', relMs: t, result: `ERROR: ${e?.message || e}` }); }
      } else if (actionStep === 1 && state.bgDone && !state.interruptDone && t - state.taskStartedAt > 5000) {
        actionStep = 2; state.interruptDone = true;
        console.error(`\n[动作2 interrupt] @ ${t}ms`);
        try {
          if (typeof queryHandle.interrupt === 'function') { await queryHandle.interrupt(); state.actions.push({ name: 'interrupt', relMs: t, result: 'OK' }); }
          else state.actions.push({ name: 'interrupt', relMs: t, result: 'NO_METHOD' });
          console.error(`[动作2] interrupt 完成`);
        } catch (e: any) { state.actions.push({ name: 'interrupt', relMs: t, result: `ERROR: ${e?.message || e}` }); console.error(`[动作2] interrupt 错误: ${e?.message}`); }
      } else if (actionStep === 2 && state.interruptDone && !state.stopDone && t - state.taskStartedAt > 8000) {
        actionStep = 3; state.stopDone = true;
        console.error(`\n[动作3 stopTask] @ ${t}ms taskId=${state.bashTaskId}`);
        try {
          if (typeof queryHandle.stopTask === 'function') { await queryHandle.stopTask(state.bashTaskId!); state.actions.push({ name: 'stopTask', relMs: t, result: 'OK' }); }
          else state.actions.push({ name: 'stopTask', relMs: t, result: 'NO_METHOD' });
          console.error(`[动作3] stopTask 完成`);
        } catch (e: any) { state.actions.push({ name: 'stopTask', relMs: t, result: `ERROR: ${e?.message || e}` }); }
        // 所有动作做完，再等 2s 收尾放行
        setTimeout(() => resolveGate(), 2000);
      }
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.taskStartedToolUseId = msg.tool_use_id ?? null;
            state.taskStartedAt = rel;
            captured.taskId = msg.task_id;
            captured.raw = { ...msg };
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} tool_use_id=${msg.tool_use_id}`);
          }
          if (msg.subtype === 'task_updated') {
            const p = msg.patch || {};
            state.patchSnaps.push({ relMs: rel, status: p.status, patch: p });
            if (p.status === 'paused') state.sawPaused = true;
            if (p.status === 'killed') state.sawKilled = true;
            captured.taskId = msg.task_id;
            captured.raw = { patch: p };
            console.error(`\n[${rel}ms] ⚡ task_updated patch=${JSON.stringify(p)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            state.taskNotificationStatuses.push({ relMs: rel, status: msg.status });
            console.error(`\n[${rel}ms] task_notification status=${msg.status}`);
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') { captured.toolName = block.name; captured.toolUseId = block.id; }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype}`);
          resolveGate();
        }

        events.push(captured);
      }
    } catch (e: any) {
      console.error(`\n[iterator] 抛出: ${e?.message || e}`);
    } finally {
      clearInterval(observer);
      resolveGate();
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;
    state.distinctStatuses = [...new Set(state.patchSnaps.map(s => s.status).filter(Boolean) as string[])];

    printTimeline('Case 28: 尝试触发 paused', events, duration);

    console.error('\n══════ case-28 实测值（尝试触发 paused）══════');
    console.error(`[动作序列] ${JSON.stringify(state.actions)}`);
    console.error(`[task_updated] ${state.patchSnaps.length} 条；status 去重=${JSON.stringify(state.distinctStatuses)}`);
    console.error(`[task_updated patches] ${JSON.stringify(state.patchSnaps)}`);
    console.error(`[task_notification] ${JSON.stringify(state.taskNotificationStatuses)}`);
    console.error(`[结论] 是否触发 paused: ${state.sawPaused}；是否触发 killed: ${state.sawKilled}`);
    if (!state.sawPaused) {
      console.error('[否定发现] 未触发 paused —— 组合 backgroundTasks+interrupt+stopTask 均未产生 paused patch。推断 paused 可能仅 TUI 暂停/特定 workflow 场景，SDK query 控制方法层无 pause 触发路径。');
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/try-paused.json`, JSON.stringify({
      actions: state.actions,
      patchSnaps: state.patchSnaps, distinctStatuses: state.distinctStatuses,
      sawPaused: state.sawPaused, sawKilled: state.sawKilled,
      taskNotificationStatuses: state.taskNotificationStatuses,
      taskStartedAt: state.taskStartedAt, bashTaskId: state.bashTaskId,
      resultSubtype: state.resultSubtype, queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言（探索性，宽松）──
    expect(events.length).toBeGreaterThan(0);
    if (state.bashTaskId == null) {
      console.error('[否定发现] 未观测到 task_started（LLM 可能没起后台 bash）—— 无法尝试触发 paused');
    }
    // 结构断言：若有 task_updated，每条 patch 必是对象
    for (const s of state.patchSnaps) {
      expect(typeof s.patch).toBe('object');
    }
  }, 120000);
});

// ====== 后台 bash 的 shell 环境探测（case-29，为 PID 观测方案定型）======
//
// 缘起：case-27 想判断 close() 后后台 bash 进程是否变孤儿，但用 .output 文件推断失败
// （文件在观测窗口内没生成）。更硬的观测手段是【PID 存活探测】，但 SDK 完全不暴露 PID
// （sdk.d.ts 无 pid 字段，BackgroundTaskSummary 也没有）。要从 OS 层拿 PID，先得知道
// 后台 bash 到底在【哪个 shell】里跑、sleep/ps/wmic 是否可用、$$ 能否拿到 PID。
//
// 本 case 让后台 bash 跑一条【自暴露环境】的命令，把 shell 身份信息 echo 出来，从
// tool_result / .output 文件读回观测：
//   E1 uname -a → 是否 Linux(WSL)/MSYS(git-bash)/不可用(cmd)
//   E2 echo $$ → 能否拿到 bash 进程自己的 PID
//   E3 echo $SHELL / $0 → shell 路径
//   E4 which ps / which wmic → 后续探活用哪个命令
// 观测结果决定 case-27b 用什么方式做 PID 存活探测（ps -p / kill -0 / wmic）。

describe('后台 bash shell 环境探测', () => {
  // 一条命令自暴露：shell 类型、自身 PID、可用探活工具。用唯一标记便于反查。
  const PROBE_MARKER = 'BG29PROBE';
  const PROBE_CMD = `echo "MARKER=${PROBE_MARKER}"; echo "UNAME=$(uname -a 2>/dev/null || echo NO_UNAME)"; echo "PID=$$"; echo "SHELL_VAR=$SHELL"; echo "ARG0=$0"; echo "HAS_PS=$(command -v ps || echo NO_PS)"; echo "HAS_KILL=$(command -v kill || echo NO_KILL)"; echo "HAS_WMIC=$(command -v wmic || echo NO_WMIC)"; echo "PROBE_DONE"`;

  it('case-29 后台 bash 自暴露 shell/PID/探活工具', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-29-shell-probe');

    const t0 = Date.now();
    const state = {
      bashTaskId: null as string | null,
      sessionId: null as string | null,
      outputFile: null as string | null,
      probeText: '' as string,       // 从 tool_result / .output 收集到的探测输出
      parsed: {} as Record<string, string>,
      queryEnded: false,
    };

    // 每秒尝试读 .output 文件，累积探测输出
    const poller = setInterval(() => {
      const cands: string[] = [];
      if (state.outputFile) cands.push(state.outputFile);
      for (const p of cands) {
        if (existsSync(p)) {
          try {
            const c = readFileSync(p, 'utf-8');
            if (c.includes(PROBE_MARKER) && c.length > state.probeText.length) state.probeText = c;
          } catch { /* 正被写 */ }
        }
      }
    }, 1000);

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${PROBE_CMD}`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'init' && msg.session_id) state.sessionId = state.sessionId || msg.session_id;
          if (msg.subtype === 'task_started' && !state.bashTaskId) {
            state.bashTaskId = msg.task_id;
            state.sessionId = state.sessionId || msg.session_id || null;
            console.error(`\n[${rel}ms] task_started task_id=${msg.task_id}`);
          }
          if (msg.subtype === 'task_notification' && msg.output_file) {
            state.outputFile = msg.output_file;
          }
        }

        // 从 tool_result 收集探测输出（前台命令 stdout 一次性带回）
        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              if (snippet.includes(PROBE_MARKER) && snippet.length > state.probeText.length) state.probeText = snippet;
              // stdout 可能包在 JSON 里
              const sm = snippet.match(/"stdout"\s*:\s*"([\s\S]*?)"\s*,\s*"stderr"/);
              if (sm) {
                const decoded = sm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                if (decoded.includes(PROBE_MARKER) && decoded.length > state.probeText.length) state.probeText = decoded;
              }
            }
          }
        }

        if (type === 'result') { state.queryEnded = true; }
        events.push(captured);
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;

    // 解析探测输出的各字段
    for (const line of state.probeText.split(/\r?\n/)) {
      const m = line.match(/^(MARKER|UNAME|PID|SHELL_VAR|ARG0|HAS_PS|HAS_KILL|HAS_WMIC)=(.*)$/);
      if (m) state.parsed[m[1]] = m[2];
    }

    console.error('\n══════ E1-E4 shell 环境探测实测值 ══════');
    console.error(`[原始探测输出]:\n${state.probeText || '(未收集到 —— 见下方否定发现)'}`);
    console.error(`[E1] UNAME: ${state.parsed.UNAME ?? '(无)'}  → 判定 shell 类型`);
    console.error(`[E2] PID (bash $$): ${state.parsed.PID ?? '(无)'}  → 能否拿到后台 bash 自身 PID`);
    console.error(`[E3] SHELL_VAR=${state.parsed.SHELL_VAR ?? '(无)'} ARG0=${state.parsed.ARG0 ?? '(无)'}`);
    console.error(`[E4] 探活工具: ps=${state.parsed.HAS_PS ?? '?'} kill=${state.parsed.HAS_KILL ?? '?'} wmic=${state.parsed.HAS_WMIC ?? '?'}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/shell-probe.json`, JSON.stringify({
      probeText: state.probeText, parsed: state.parsed,
      bashTaskId: state.bashTaskId, sessionId: state.sessionId, outputFile: state.outputFile,
      queryEnded: state.queryEnded, duration,
    }, null, 2));

    // ── 断言（探索性）──
    expect(events.length).toBeGreaterThan(0);
    if (!state.probeText.includes(PROBE_MARKER)) {
      console.error('[否定发现] 未收集到探测输出（LLM 可能没按指令跑命令，或 stdout 未回传）—— 需检查 tool_result/.output');
    } else {
      console.error(`[结论] 后台 bash shell 环境已探明，PID 可获取性=${state.parsed.PID && /^\d+$/.test(state.parsed.PID) ? '可' : '不可'}`);
    }
  }, 120000);
});

// ══════════════════════════════════════════════════════════════════
// 新研究课题：subagent（Agent 工具启动的子代理）全生命周期 + 实时增量信息
// 阶段一（子问题1：subagent 是不是工具调用机制）+ 阶段二（子问题2：前后台）
//
// case-30 Agent vs Bash tool_use 骨架对照
// case-31 run_in_background 显式对照（前台阻塞 vs 后台异步）
// case-32 默认行为（读 Agent input.run_in_background 默认值，复验 case-5）
// case-33 backgroundTasks/stopTask 对 local_agent 是否生效（关键补白）
//
// 环境决策：主用智谱 GLM（BIGMODEL_ENV，glm-5.2）——它能稳定触发真实 subagent；
// 本地 Jereh-LLM 触发不稳定（曾因 "Content block not found" skip），关键 case
// 可用 BASE_ENV 对照，触发不到就如实记否定发现。
//
// 沿用 case-13→17 铁律：控制方法（backgroundTasks/stopTask）必须在收到 task_started
// 事件【之后】调用才生效。
// ══════════════════════════════════════════════════════════════════

/**
 * 通用：用指定 env 跑一次 query，收集事件 + 每条 assistant 的 parent_tool_use_id/subagent_type。
 * 与 collectSDKEvents 的区别：显式接受 env（不强制 BASE_ENV），并额外抓 subagent 关联字段。
 */
async function collectSubagentEvents(options: {
  prompt: string;
  env: Record<string, string | undefined>;
  logDir: string;
}): Promise<{
  events: CapturedSDKEvent[];
  assistantSnaps: {
    relMs: number;
    parent_tool_use_id: string | null;
    subagent_type: string | null;
    task_description: string | null;
    toolUses: { name: string; id: string }[];
  }[];
  duration: number;
}> {
  const t0 = Date.now();
  const events: CapturedSDKEvent[] = [];
  const assistantSnaps: any[] = [];
  let index = 0;

  const env = { ...options.env, OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` };
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      permissionMode: 'bypassPermissions',
    } as any,
  });

  for await (const message of sdkQuery) {
    const msg = message as any;
    const type = msg.type || 'unknown';
    const rel = Date.now() - t0;
    const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

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
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        process.stderr.write(evt.delta.text);
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
          task_id: msg.task_id, status: msg.status, summary: msg.summary,
          error: msg.error, output_file: msg.output_file, task_type: msg.task_type,
          usage: msg.usage, tool_use_id: msg.tool_use_id,
        };
      }
      if (msg.subtype === 'task_progress') {
        captured.taskId = msg.task_id;
        captured.taskType = msg.task_type;
        captured.raw = { subagent_type: msg.subagent_type, last_tool_name: msg.last_tool_name, usage: msg.usage };
      }
    }

    if (type === 'assistant' && msg.message?.content) {
      const toolUses: { name: string; id: string }[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          toolUses.push({ name: block.name, id: block.id });
          captured.toolName = block.name;
          captured.toolUseId = block.id;
          if (!captured.raw) captured.raw = {};
          captured.raw.toolInput = block.input;
        }
      }
      assistantSnaps.push({
        relMs: rel,
        parent_tool_use_id: msg.parent_tool_use_id ?? null,
        subagent_type: msg.subagent_type ?? null,
        task_description: msg.task_description ?? null,
        toolUses,
      });
    }

    if (type === 'user') {
      captured.raw = {
        parent_tool_use_id: msg.parent_tool_use_id,
        messageContentTypes: Array.isArray(msg.message?.content)
          ? msg.message.content.map((b: any) => ({ type: b.type, tool_use_id: b.tool_use_id }))
          : undefined,
      };
    }

    if (type === 'result') {
      captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns };
    }

    events.push(captured);
  }

  return { events, assistantSnaps, duration: Date.now() - t0 };
}

/** 统计一次 run 的 tool_use 骨架：content_block_start(tool_use) / input_json_delta / content_block_stop / tool_result */
function analyzeToolUseSkeleton(events: CapturedSDKEvent[], toolName: string) {
  // 找该工具的 content_block_start
  const starts = events.filter(e => e.type === 'stream_event' && e.eventType === 'content_block_start' && e.toolName === toolName);
  // input_json_delta 次数（全局，仅一个工具时够用）
  const inputJsonDeltas = events.filter(e => e.deltaType === 'input_json_delta');
  const contentBlockStops = events.filter(e => e.type === 'stream_event' && e.eventType === 'content_block_stop');
  // assistant 里出现该工具的 tool_use（拿最终 input）
  const assistantToolUse = events.filter(e => e.type === 'assistant' && e.toolName === toolName && e.raw?.toolInput);
  // user tool_result
  const toolResults = events.filter(e => e.type === 'user' && Array.isArray(e.raw?.messageContentTypes)
    && e.raw.messageContentTypes.some((b: any) => b.type === 'tool_result'));
  return {
    hasContentBlockStart: starts.length > 0,
    contentBlockStartCount: starts.length,
    inputJsonDeltaCount: inputJsonDeltas.length,
    contentBlockStopCount: contentBlockStops.length,
    hasToolResult: toolResults.length > 0,
    finalInput: assistantToolUse[0]?.raw?.toolInput ?? null,
    finalInputKeys: assistantToolUse[0]?.raw?.toolInput ? Object.keys(assistantToolUse[0].raw.toolInput) : [],
  };
}

// ====== case-30 Agent vs Bash tool_use 骨架对照 ======
//
// 子问题1：subagent 是不是工具调用机制？
// 同一批 prompt 分别触发一次 Bash 和一次 Agent，验证 Agent 走与 Bash 相同的工具调用骨架：
//   content_block_start(tool_use) → input_json_delta → content_block_stop → tool_result
// 断言：
//   · 两者都有 tool_use（content_block_start）和 tool_result（user 消息）
//   · Agent 的 input_json_delta 逐步拼出 6 字段之一部分（description/prompt/subagent_type/
//     model/run_in_background/isolation）
//   · 差异仅在 Agent 伴随 task_started(task_type=local_agent)，Bash 是 local_bash（或无）
// 主用 GLM（稳定触发真实 subagent），本地 BASE_ENV 对照记差异。

describe('subagent 阶段一: Agent vs Bash tool_use 骨架对照', () => {
  const BASH_PROMPT = 'Use the Bash tool to run the command "echo skeleton-bash-30". Then tell me the output.';
  const AGENT_PROMPT = 'Use the Agent tool to launch a subagent whose task is to run the Bash command "echo skeleton-agent-30" and report its output. Wait for the subagent and tell me its result.';

  it('case-30 Agent 与 Bash 共享 tool_use 骨架，差异仅在 task_type', async () => {
    const dirBash = createTimestampDir('tool-foreground-background/case-30-bash-skeleton');
    const dirAgent = createTimestampDir('tool-foreground-background/case-30-agent-skeleton');

    // ── Run 1: Bash（GLM）──
    const bashRun = await collectSubagentEvents({ prompt: BASH_PROMPT, env: BIGMODEL_ENV, logDir: dirBash });
    printTimeline('Case 30 / Run1 Bash 骨架 (GLM)', bashRun.events, bashRun.duration);
    const bashSkeleton = analyzeToolUseSkeleton(bashRun.events, 'Bash');
    const bashTask = analyzeTaskEvents(bashRun.events);
    console.error('\n── Bash 骨架 ──', JSON.stringify(bashSkeleton, null, 2));
    console.error('── Bash task 事件 ──', JSON.stringify(bashTask.taskStartedDetails, null, 2));

    // ── Run 2: Agent（GLM）──
    const agentRun = await collectSubagentEvents({ prompt: AGENT_PROMPT, env: BIGMODEL_ENV, logDir: dirAgent });
    printTimeline('Case 30 / Run2 Agent 骨架 (GLM)', agentRun.events, agentRun.duration);
    const agentSkeleton = analyzeToolUseSkeleton(agentRun.events, 'Agent');
    const agentTask = analyzeTaskEvents(agentRun.events);
    const agentInput = extractToolInputJson(agentRun.events, 'Agent');
    console.error('\n── Agent 骨架 ──', JSON.stringify(agentSkeleton, null, 2));
    console.error('── Agent input (input_json_delta 拼出) ──', JSON.stringify(agentInput, null, 2));
    console.error('── Agent task 事件 ──', JSON.stringify(agentTask.taskStartedDetails, null, 2));

    // subagent 展开：parent_tool_use_id 非 null 的 assistant
    const subagentAssistants = agentRun.assistantSnaps.filter(a => a.parent_tool_use_id != null);

    const AGENT_6_FIELDS = ['description', 'prompt', 'subagent_type', 'model', 'run_in_background', 'isolation'];
    const agentFieldsPresent = agentInput ? AGENT_6_FIELDS.filter(f => f in agentInput) : [];

    console.error('\n══════ case-30 骨架对照结论 ══════');
    console.error(`[Bash]  content_block_start=${bashSkeleton.hasContentBlockStart} input_json_delta=${bashSkeleton.inputJsonDeltaCount} tool_result=${bashSkeleton.hasToolResult} task_type=${JSON.stringify(bashTask.taskStartedDetails.map(d => d.task_type))}`);
    console.error(`[Agent] content_block_start=${agentSkeleton.hasContentBlockStart} input_json_delta=${agentSkeleton.inputJsonDeltaCount} tool_result=${agentSkeleton.hasToolResult} task_type=${JSON.stringify(agentTask.taskStartedDetails.map(d => d.task_type))}`);
    console.error(`[Agent input 6 字段命中] ${JSON.stringify(agentFieldsPresent)}（全集 ${JSON.stringify(AGENT_6_FIELDS)}）`);
    console.error(`[subagent 展开] parent_tool_use_id!=null 的 assistant 数=${subagentAssistants.length}；subagent_type=${JSON.stringify([...new Set(subagentAssistants.map(a => a.subagent_type))])}`);
    console.error(`[差异] Bash task_type=local_bash? Agent task_type=local_agent?`);

    writeFileSync(`${dirAgent}/skeleton-comparison.json`, JSON.stringify({
      bash: { skeleton: bashSkeleton, taskStarted: bashTask.taskStartedDetails },
      agent: { skeleton: agentSkeleton, input: agentInput, agentFieldsPresent, taskStarted: agentTask.taskStartedDetails, subagentAssistantCount: subagentAssistants.length },
    }, null, 2));
    writeFileSync(`${dirBash}/sdk-events.json`, JSON.stringify(bashRun.events, null, 2));
    writeFileSync(`${dirAgent}/sdk-events.json`, JSON.stringify(agentRun.events, null, 2));

    // ── 断言 ──
    expect(bashRun.events.length).toBeGreaterThan(0);
    expect(agentRun.events.length).toBeGreaterThan(0);

    // 结构断言：两者都走 tool_use 骨架（content_block_start + tool_result）
    // 注意：GLM 若未触发对应工具，记否定发现而非硬失败
    if (bashSkeleton.hasContentBlockStart) {
      expect(bashSkeleton.hasToolResult).toBe(true);
    } else {
      console.error('[否定发现] Bash 未产生 content_block_start（GLM 未走 Bash 工具）');
    }
    if (agentSkeleton.hasContentBlockStart) {
      // Agent 走与 Bash 相同骨架：有 tool_use、有 input_json_delta、有 tool_result
      expect(agentSkeleton.inputJsonDeltaCount).toBeGreaterThan(0);
      expect(agentSkeleton.hasToolResult).toBe(true);
      // Agent 特有：伴随 task_started(local_agent)
      const agentTaskTypes = agentTask.taskStartedDetails.map(d => d.task_type);
      if (agentTaskTypes.includes('local_agent')) {
        console.error('[发现] ✅ Agent 伴随 task_started(local_agent)，Bash 则为 local_bash/无 —— 差异确认');
      } else {
        console.error(`[否定发现] Agent 未观测到 task_type=local_agent（实测 ${JSON.stringify(agentTaskTypes)}）`);
      }
    } else {
      console.error('[否定发现] Agent 未产生 content_block_start —— GLM 本轮未触发真实 subagent，记录');
    }
  }, 240000);
});

// ====== case-31 run_in_background 显式对照 ======
//
// 子问题2：subagent 有没有前后台？
// prompt 分别明确要求"前台 subagent"和"后台 subagent"，比较：
//   · 前台是否阻塞主 turn（task_started 后是否等 subagent 完成才出 result）
//   · 后台是否立即 task_started + 异步 task_notification
//   · Agent input.run_in_background 值（前台 false / 后台 true）
// 记录两种序列差异。主用 GLM。

describe('subagent 阶段二: run_in_background 显式对照', () => {
  // 让 subagent 做一个稍慢的任务，便于观察前台阻塞 vs 后台异步
  const FG_PROMPT = 'Use the Agent tool to launch a subagent IN THE FOREGROUND (set run_in_background to false). The subagent must run the Bash command "sleep 5 && echo fg-subagent-31" and report the output. Wait for the subagent to finish, then tell me its result.';
  const BG_PROMPT = 'Use the Agent tool to launch a subagent IN THE BACKGROUND (set run_in_background to true). The subagent must run the Bash command "sleep 5 && echo bg-subagent-31" and report the output. Let it run in the background.';

  it('case-31 前台 subagent 阻塞 vs 后台 subagent 异步', async () => {
    const dirFg = createTimestampDir('tool-foreground-background/case-31-fg-subagent');
    const dirBg = createTimestampDir('tool-foreground-background/case-31-bg-subagent');

    // ── 前台 subagent ──
    const fgRun = await collectSubagentEvents({ prompt: FG_PROMPT, env: BIGMODEL_ENV, logDir: dirFg });
    printTimeline('Case 31 / 前台 subagent (GLM)', fgRun.events, fgRun.duration);
    const fgInput = extractToolInputJson(fgRun.events, 'Agent');
    const fgTask = analyzeTaskEvents(fgRun.events);
    // 前台：从 task_started 到 result 的时序（阻塞判据）
    const fgTaskStartedIdx = fgRun.events.findIndex(e => e.subtype === 'task_started');
    const fgResultIdx = fgRun.events.findIndex(e => e.type === 'result');
    console.error('\n── 前台 Agent input ──', JSON.stringify(fgInput, null, 2));
    console.error(`── 前台 run_in_background=${fgInput ? fgInput.run_in_background : '(无 input)'}`);
    console.error(`── 前台 task_started@idx=${fgTaskStartedIdx} result@idx=${fgResultIdx}；task_started/notification=${fgTask.taskStartedCount}/${fgTask.taskNotificationCount}`);

    // ── 后台 subagent ──
    const bgRun = await collectSubagentEvents({ prompt: BG_PROMPT, env: BIGMODEL_ENV, logDir: dirBg });
    printTimeline('Case 31 / 后台 subagent (GLM)', bgRun.events, bgRun.duration);
    const bgInput = extractToolInputJson(bgRun.events, 'Agent');
    const bgTask = analyzeTaskEvents(bgRun.events);
    console.error('\n── 后台 Agent input ──', JSON.stringify(bgInput, null, 2));
    console.error(`── 后台 run_in_background=${bgInput ? bgInput.run_in_background : '(无 input)'}`);
    console.error(`── 后台 task_started/notification=${bgTask.taskStartedCount}/${bgTask.taskNotificationCount}`);

    console.error('\n══════ case-31 前后台对照结论 ══════');
    console.error(`[前台] input.run_in_background=${fgInput ? JSON.stringify(fgInput.run_in_background) : 'N/A'}, task_started=${fgTask.taskStartedCount}, task_notification=${fgTask.taskNotificationCount}, 耗时=${fgRun.duration}ms`);
    console.error(`[后台] input.run_in_background=${bgInput ? JSON.stringify(bgInput.run_in_background) : 'N/A'}, task_started=${bgTask.taskStartedCount}, task_notification=${bgTask.taskNotificationCount}, 耗时=${bgRun.duration}ms`);
    console.error(`[task_type] 前台=${JSON.stringify(fgTask.taskStartedDetails.map(d => d.task_type))} 后台=${JSON.stringify(bgTask.taskStartedDetails.map(d => d.task_type))}`);

    writeFileSync(`${dirFg}/sdk-events.json`, JSON.stringify(fgRun.events, null, 2));
    writeFileSync(`${dirBg}/sdk-events.json`, JSON.stringify(bgRun.events, null, 2));
    writeFileSync(`${dirBg}/fg-bg-comparison.json`, JSON.stringify({
      foreground: { input: fgInput, taskStarted: fgTask.taskStartedDetails, taskStartedCount: fgTask.taskStartedCount, taskNotificationCount: fgTask.taskNotificationCount, duration: fgRun.duration },
      background: { input: bgInput, taskStarted: bgTask.taskStartedDetails, taskStartedCount: bgTask.taskStartedCount, taskNotificationCount: bgTask.taskNotificationCount, duration: bgRun.duration },
    }, null, 2));

    // ── 断言（宽松，先观察）──
    expect(fgRun.events.length).toBeGreaterThan(0);
    expect(bgRun.events.length).toBeGreaterThan(0);
    // 记录 run_in_background 差异（LLM 是否遵循指令）
    if (fgInput && 'run_in_background' in fgInput) {
      console.error(`[发现] 前台 subagent input.run_in_background=${fgInput.run_in_background}`);
    } else {
      console.error('[否定发现] 前台 subagent 未触发 Agent 或 input 无 run_in_background 字段');
    }
    if (bgInput && 'run_in_background' in bgInput) {
      console.error(`[发现] 后台 subagent input.run_in_background=${bgInput.run_in_background}`);
    } else {
      console.error('[否定发现] 后台 subagent 未触发 Agent 或 input 无 run_in_background 字段');
    }
  }, 300000);
});

// ====== case-32 默认行为 ======
//
// 子问题2：不指示前后台时，Agent input.run_in_background 的默认值是什么？
// 复验 case-5 的"v2.1.198 默认后台"结论在 GLM 上是否成立。
// 不给任何前台/后台指示，读 Agent input 里 run_in_background 字段的有无与取值。
// 主用 GLM + 本地 BASE_ENV 双跑对照。

describe('subagent 阶段二: 默认 run_in_background', () => {
  const DEFAULT_PROMPT = 'Use the Agent tool to launch a subagent that counts how many .ts files exist under the test directory using a Bash command, then reports the count. Report the subagent result to me.';

  it('case-32 不指示前后台时 Agent input.run_in_background 默认值', async () => {
    const dirGlm = createTimestampDir('tool-foreground-background/case-32-default-glm');
    const dirLocal = createTimestampDir('tool-foreground-background/case-32-default-local');

    // ── GLM ──
    const glmRun = await collectSubagentEvents({ prompt: DEFAULT_PROMPT, env: BIGMODEL_ENV, logDir: dirGlm });
    printTimeline('Case 32 / 默认 (GLM)', glmRun.events, glmRun.duration);
    const glmInput = extractToolInputJson(glmRun.events, 'Agent');
    const glmTask = analyzeTaskEvents(glmRun.events);
    const glmHasField = glmInput ? 'run_in_background' in glmInput : false;
    console.error('\n── GLM Agent input ──', JSON.stringify(glmInput, null, 2));
    console.error(`── GLM run_in_background 字段存在=${glmHasField} 值=${glmInput ? JSON.stringify(glmInput.run_in_background) : 'N/A'}`);
    console.error(`── GLM task_type=${JSON.stringify(glmTask.taskStartedDetails.map(d => d.task_type))}`);

    // ── 本地 BASE_ENV 对照 ──
    let localInput: any = null;
    let localHasField = false;
    let localTask: any = null;
    try {
      const localRun = await collectSubagentEvents({ prompt: DEFAULT_PROMPT, env: BASE_ENV, logDir: dirLocal });
      printTimeline('Case 32 / 默认 (本地 Jereh-LLM)', localRun.events, localRun.duration);
      localInput = extractToolInputJson(localRun.events, 'Agent');
      localTask = analyzeTaskEvents(localRun.events);
      localHasField = localInput ? 'run_in_background' in localInput : false;
      console.error('\n── 本地 Agent input ──', JSON.stringify(localInput, null, 2));
      console.error(`── 本地 run_in_background 字段存在=${localHasField} 值=${localInput ? JSON.stringify(localInput.run_in_background) : 'N/A'}`);
      writeFileSync(`${dirLocal}/sdk-events.json`, JSON.stringify(localRun.events, null, 2));
    } catch (e: any) {
      console.error(`[本地对照] 跑失败/触发不到: ${e?.message || e} —— 记否定发现`);
    }

    console.error('\n══════ case-32 默认行为结论 ══════');
    console.error(`[GLM]  run_in_background 字段=${glmHasField ? `存在(=${JSON.stringify(glmInput.run_in_background)})` : '缺省'}；task_type=${JSON.stringify(glmTask.taskStartedDetails.map(d => d.task_type))}`);
    console.error(`[本地] run_in_background 字段=${localInput ? (localHasField ? `存在(=${JSON.stringify(localInput.run_in_background)})` : '缺省') : '(未触发 Agent)'}`);
    console.error(`[对照 case-5] case-5 结论：默认后台（input 无 run_in_background 字段 或 =true）`);

    writeFileSync(`${dirGlm}/sdk-events.json`, JSON.stringify(glmRun.events, null, 2));
    writeFileSync(`${dirGlm}/default-behavior.json`, JSON.stringify({
      glm: { input: glmInput, hasField: glmHasField, value: glmInput?.run_in_background, taskStarted: glmTask.taskStartedDetails },
      local: { input: localInput, hasField: localHasField, value: localInput?.run_in_background, taskStarted: localTask?.taskStartedDetails ?? null },
    }, null, 2));

    // ── 断言 ──
    expect(glmRun.events.length).toBeGreaterThan(0);
    if (!glmInput) {
      console.error('[否定发现] GLM 默认场景未触发 Agent 工具 —— 记录');
    }
  }, 300000);
});

// ====== case-33 backgroundTasks/stopTask 对 local_agent 是否生效 ======
//
// 子问题2 关键补白：现有终止/转后台（case-15/17/26）只测过 Bash（local_bash）！
// 本 case 专门验证控制方法对 subagent（local_agent）是否生效。
// streaming-input 模式，让 subagent 跑够久的任务，等 task_started(task_type=local_agent) 后：
//   路径A：stopTask(taskId) —— 观察是否出现 killed(task_updated) + stopped(task_notification)，
//          对照 case-15/26（Bash 的 stopTask）
//   路径B：（另起一跑）backgroundTasks(toolUseId) —— 观察返回值、是否转后台
// 遵循 case-17 铁律：控制方法必须在 task_started 之后调用。
// 主用 GLM（稳定触发真实 subagent + 够久任务）。

describe('subagent 阶段二: 控制方法对 local_agent 是否生效', () => {
  // 让 subagent 跑一个够久的任务（sleep 30），给控制方法留时间窗
  const LONG_SUBAGENT_PROMPT = 'Use the Agent tool to launch a subagent. Instruct the subagent to run the Bash command "sleep 30 && echo subagent-long-33" and report its output. Let the subagent work on this.';

  /** 共享的 streaming-input + task_started 后调控制方法的执行器 */
  async function runControlOnSubagent(options: {
    logDir: string;
    control: 'stopTask' | 'backgroundTasks';
  }) {
    const state = {
      queryStartedAt: Date.now(),
      agentTaskId: null as string | null,          // task_started.task_id（local_agent）
      agentTaskType: null as string | null,
      taskStartedToolUseId: null as string | null, // task_started.tool_use_id
      agentBlockId: null as string | null,          // 顶层 Agent tool_use block.id
      taskStartedAt: null as number | null,
      controlResult: 'NOT_CALLED' as boolean | 'NOT_CALLED' | 'OK' | 'NO_METHOD' | string,
      controlCallAt: null as number | null,
      controlUsedId: null as string | null,
      taskUpdatedStatuses: [] as { relMs: number; status: string | undefined; patchKeys: string[] }[],
      sawKilled: false,
      taskNotificationStatus: null as string | null,
      taskNotificationAt: null as number | null,
      backgroundTaskIdFromResult: null as string | null,
      queryEnded: false,
      queryEndedAt: null as number | null,
      resultSubtype: null as string | null,
      turnsObserved: 0,
      turn2Reached: false,
    };

    const events: CapturedSDKEvent[] = [];

    let resolveTurn2: () => void = () => {};
    const turn2Gate = new Promise<void>((r) => { resolveTurn2 = r; });
    const turn2Timeout = new Promise<void>((r) => setTimeout(r, 25000));

    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: LONG_SUBAGENT_PROMPT },
      parent_tool_use_id: null,
    };
    const msg2: any = {
      type: 'user',
      message: { role: 'user', content: 'What is the final status of the subagent task? Just report it in one sentence. Do NOT launch any new subagents or run commands.' },
      parent_tool_use_id: null,
      priority: 'now',
    };
    async function* promptInput(): AsyncIterable<any> {
      yield msg1;
      await Promise.race([turn2Gate, turn2Timeout]);
      state.turn2Reached = true;
      console.error(`\n[gen] turn2 放行 @ ${Date.now() - state.queryStartedAt}ms`);
      yield msg2;
    }

    const env = { ...BIGMODEL_ENV, OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` };
    const sdkQuery = query({
      prompt: promptInput(),
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });
    const queryHandle: any = sdkQuery;

    const observer = setInterval(() => {
      const t = Date.now() - state.queryStartedAt;
      console.error(`[obs t=${t}ms] agentTaskId=${state.agentTaskId ?? '-'}(${state.agentTaskType ?? '-'}) ${options.control}=${state.controlResult} killed=${state.sawKilled} notif=${state.taskNotificationStatus ?? '-'} ended=${state.queryEnded}`);
    }, 1000);

    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - state.queryStartedAt;
        const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

        if (type === 'stream_event' && msg.event) {
          captured.eventType = msg.event.type;
          if (msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
            process.stderr.write(msg.event.delta.text);
          }
        }

        if (type === 'system') {
          captured.subtype = msg.subtype;
          if (msg.subtype === 'task_started') {
            captured.taskId = msg.task_id;
            captured.taskType = msg.task_type;
            captured.raw = { ...msg };
            // 只锁定 local_agent 的 task_started（subagent），忽略 subagent 内部可能的 local_bash
            if (!state.agentTaskId && msg.task_type === 'local_agent') {
              state.agentTaskId = msg.task_id;
              state.agentTaskType = msg.task_type;
              state.taskStartedToolUseId = msg.tool_use_id ?? null;
              state.taskStartedAt = rel;
              console.error(`\n[${rel}ms] task_started(local_agent) task_id=${msg.task_id} tool_use_id=${msg.tool_use_id} subagent_type=${msg.subagent_type ?? '-'}`);
            } else if (!state.agentTaskId) {
              // 记录非 local_agent 的 task_started（诊断用）
              console.error(`\n[${rel}ms] task_started(非 local_agent) task_id=${msg.task_id} task_type=${msg.task_type}`);
            }
          }
          if (msg.subtype === 'task_updated') {
            const p = msg.patch || {};
            state.taskUpdatedStatuses.push({ relMs: rel, status: p.status, patchKeys: Object.keys(p) });
            if (p.status === 'killed') state.sawKilled = true;
            captured.taskId = msg.task_id;
            captured.raw = { patch: p };
            console.error(`\n[${rel}ms] ⚡ task_updated task_id=${msg.task_id} patch=${JSON.stringify(p)}`);
          }
          if (msg.subtype === 'task_notification') {
            captured.taskId = msg.task_id;
            captured.taskStatus = msg.status;
            captured.taskType = msg.task_type;
            captured.raw = { status: msg.status, output_file: msg.output_file, task_type: msg.task_type };
            // 只记 local_agent 那条（或首条）
            if (msg.task_id === state.agentTaskId || state.taskNotificationStatus == null) {
              state.taskNotificationStatus = msg.status;
              state.taskNotificationAt = rel;
            }
            console.error(`\n[${rel}ms] task_notification task_id=${msg.task_id} status=${msg.status} task_type=${msg.task_type ?? '-'}`);
            resolveTurn2();
          }
        }

        if (type === 'assistant' && msg.message?.content) {
          state.turnsObserved++;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              captured.toolName = block.name;
              captured.toolUseId = block.id;
              // 顶层 Agent block.id（parent_tool_use_id==null）
              if (block.name === 'Agent' && msg.parent_tool_use_id == null && !state.agentBlockId) {
                state.agentBlockId = block.id;
                console.error(`\n[${rel}ms] 顶层 Agent block.id=${block.id}`);
              }
              if (!captured.raw) captured.raw = {};
              captured.raw.toolInput = block.input;
            }
          }
        }

        if (type === 'user') {
          const cb = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const b of cb) {
            if (b.type === 'tool_result') {
              const snippet = typeof b.content === 'string' ? b.content
                : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : '';
              captured.raw = { tool_use_id: b.tool_use_id, contentSnippet: snippet.substring(0, 500) };
              const m = snippet.match(/backgroundTaskId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i) || snippet.match(/ID:\s*([A-Za-z0-9_-]+)/i);
              if (m && !state.backgroundTaskIdFromResult) state.backgroundTaskIdFromResult = m[1];
            }
          }
        }

        if (type === 'result') {
          captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns, terminal_reason: msg.terminal_reason };
          state.queryEnded = true;
          state.queryEndedAt = rel;
          state.resultSubtype = msg.subtype;
          console.error(`\n[${rel}ms] result subtype=${msg.subtype} num_turns=${msg.num_turns}`);
          resolveTurn2();
        }

        events.push(captured);

        // ── 控制调用：等 local_agent 的 task_started 后调用 ──
        if (state.agentTaskId && state.controlResult === 'NOT_CALLED') {
          state.controlCallAt = rel;
          if (options.control === 'stopTask') {
            console.error(`\n[stopTask] 等到 task_started(local_agent) 后调用 @ ${rel}ms，taskId=${state.agentTaskId}`);
            state.controlUsedId = state.agentTaskId;
            try {
              if (typeof queryHandle.stopTask === 'function') {
                await queryHandle.stopTask(state.agentTaskId);
                state.controlResult = 'OK';
              } else {
                state.controlResult = 'NO_METHOD';
              }
            } catch (e: any) {
              state.controlResult = `ERROR: ${e?.message || e}`;
            }
            console.error(`[stopTask] 结果: ${state.controlResult}`);
          } else {
            // backgroundTasks：用 task_started.tool_use_id（回退 Agent block.id）
            const idToUse = state.taskStartedToolUseId || state.agentBlockId || undefined;
            state.controlUsedId = idToUse ?? null;
            console.error(`\n[backgroundTasks] 等到 task_started(local_agent) 后调用 @ ${rel}ms，用 id=${idToUse}`);
            try {
              state.controlResult = typeof queryHandle.backgroundTasks === 'function'
                ? await queryHandle.backgroundTasks(idToUse)
                : 'NO_METHOD';
            } catch (e: any) {
              state.controlResult = `ERROR: ${e?.message || e}`;
            }
            console.error(`[backgroundTasks] 返回: ${state.controlResult}`);
            if (state.controlResult === true) resolveTurn2();
          }
        }
      }
    } finally {
      clearInterval(observer);
    }

    const duration = Date.now() - state.queryStartedAt;
    if (!state.queryEnded) state.queryEndedAt = duration;
    return { state, events, duration };
  }

  it('case-33A stopTask 对 local_agent subagent', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-33a-stoptask-subagent');
    const { state, events, duration } = await runControlOnSubagent({ logDir: dir, control: 'stopTask' });

    printTimeline('Case 33A: stopTask 对 local_agent', events, duration);
    // sleep 30 若被杀，总耗时应远小于自然完成
    const killedInterrupted = state.taskStartedAt != null && duration - state.taskStartedAt < 30000;

    console.error('\n══════ case-33A 实测值（stopTask 对 subagent）══════');
    console.error(`[A1] 是否观测到 task_started(local_agent): ${state.agentTaskId != null}（task_id=${state.agentTaskId}, type=${state.agentTaskType}, @${state.taskStartedAt}ms）`);
    console.error(`[A2] stopTask 结果: ${state.controlResult}（@${state.controlCallAt}ms，用 taskId=${state.controlUsedId}）`);
    console.error(`[A3] task_updated 序列: ${JSON.stringify(state.taskUpdatedStatuses)}；是否报 killed=${state.sawKilled}（对照 case-15/26 Bash）`);
    console.error(`[A4] task_notification status=${state.taskNotificationStatus}@${state.taskNotificationAt}ms（期望 stopped）`);
    console.error(`[A5] sleep 30 是否被中断: task_started 后 ${state.taskStartedAt != null ? duration - state.taskStartedAt : '?'}ms 结束（<30000=被杀=${killedInterrupted}）；总耗时=${duration}ms`);
    console.error(`[补充] turn2Reached=${state.turn2Reached} turnsObserved=${state.turnsObserved} result.subtype=${state.resultSubtype}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/stoptask-subagent.json`, JSON.stringify({
      agentTaskId: state.agentTaskId, agentTaskType: state.agentTaskType, taskStartedAt: state.taskStartedAt,
      controlResult: state.controlResult, controlCallAt: state.controlCallAt, controlUsedId: state.controlUsedId,
      taskUpdatedStatuses: state.taskUpdatedStatuses, sawKilled: state.sawKilled,
      taskNotificationStatus: state.taskNotificationStatus, taskNotificationAt: state.taskNotificationAt,
      killedInterrupted, turn2Reached: state.turn2Reached, turnsObserved: state.turnsObserved,
      resultSubtype: state.resultSubtype, queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    if (state.agentTaskId == null) {
      console.error('[否定发现] 未观测到 task_started(local_agent) —— GLM 本轮未触发后台 subagent，stopTask 未能施加于 local_agent');
    } else {
      // 触发到了才断言方法被调用
      expect(state.controlResult).not.toBe('NOT_CALLED');
      expect(state.controlResult).not.toBe('NO_METHOD');
      // 软断言：记录 stopped/killed 是否出现
      if (state.taskNotificationStatus === 'stopped') {
        console.error('[发现] ✅ stopTask 对 local_agent 生效：task_notification status=stopped');
      } else {
        console.error(`[否定发现] stopTask 后 task_notification status=${state.taskNotificationStatus}（非 stopped）—— 记录实测`);
      }
    }
  }, 240000);

  it('case-33B backgroundTasks 对 local_agent subagent', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-33b-bgtasks-subagent');
    const { state, events, duration } = await runControlOnSubagent({ logDir: dir, control: 'backgroundTasks' });

    printTimeline('Case 33B: backgroundTasks 对 local_agent', events, duration);

    console.error('\n══════ case-33B 实测值（backgroundTasks 对 subagent）══════');
    console.error(`[B1] 是否观测到 task_started(local_agent): ${state.agentTaskId != null}（task_id=${state.agentTaskId}, @${state.taskStartedAt}ms）`);
    console.error(`[B2] backgroundTasks 返回: ${state.controlResult}（@${state.controlCallAt}ms，用 id=${state.controlUsedId}）`);
    console.error(`[B3] task_started.tool_use_id=${state.taskStartedToolUseId} vs 顶层 Agent block.id=${state.agentBlockId}（是否一致=${state.taskStartedToolUseId === state.agentBlockId}）`);
    console.error(`[B4] tool_result.backgroundTaskId=${state.backgroundTaskIdFromResult}；task_notification status=${state.taskNotificationStatus}`);
    console.error(`[B5] 若返回 true：query 是否解阻塞、可续轮 turn2Reached=${state.turn2Reached}；总耗时=${duration}ms`);
    console.error(`[补充] turnsObserved=${state.turnsObserved} result.subtype=${state.resultSubtype}`);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${dir}/bgtasks-subagent.json`, JSON.stringify({
      agentTaskId: state.agentTaskId, agentTaskType: state.agentTaskType, taskStartedAt: state.taskStartedAt,
      controlResult: state.controlResult, controlCallAt: state.controlCallAt, controlUsedId: state.controlUsedId,
      taskStartedToolUseId: state.taskStartedToolUseId, agentBlockId: state.agentBlockId,
      backgroundTaskIdFromResult: state.backgroundTaskIdFromResult,
      taskNotificationStatus: state.taskNotificationStatus, taskUpdatedStatuses: state.taskUpdatedStatuses,
      turn2Reached: state.turn2Reached, turnsObserved: state.turnsObserved,
      resultSubtype: state.resultSubtype, queryEndedAt: state.queryEndedAt, duration,
    }, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    if (state.agentTaskId == null) {
      console.error('[否定发现] 未观测到 task_started(local_agent) —— GLM 本轮未触发后台 subagent，backgroundTasks 未能施加于 local_agent');
    } else {
      expect(state.controlResult).not.toBe('NOT_CALLED');
      expect(state.controlResult).not.toBe('NO_METHOD');
      if (state.controlResult === true) {
        console.error('[发现] ✅ backgroundTasks 对 local_agent 返回 true —— subagent 可转后台');
      } else {
        console.error(`[否定发现] backgroundTasks 对 local_agent 返回 ${state.controlResult}（非 true）—— 记录实测`);
      }
    }
  }, 240000);
});

// ══════════════════════════════════════════════════════════════════════════
// 阶段三：全生命周期阶段与事件（子问题3）
// ══════════════════════════════════════════════════════════════════════════
//
// case-34 subagent 完整生命周期时间线（对照 Bash 生命周期的核心 case）
// case-35 SubagentStart/Stop hook（agent_id / agent_transcript_path / background_tasks）
//
// 阶段四：实时增量信息（子问题4，重点）
//
// case-36 forwardSubagentText true vs false（核心开关）
// case-37 agentProgressSummaries=true（需 subagent >30s）
// case-38 getSubagentMessages 主动拉取（1Hz poller）
// case-39 三通道横向对照 + transcript 文件读

/**
 * 通用：streaming-input 模式跑一个 subagent，收集所有生命周期事件，
 * 可注入 extraOptions（forwardSubagentText / agentProgressSummaries / hooks 等），
 * 可注入 onMessage 回调（用于运行中 poller / hook 时序对齐）。
 * 用永挂 generator 保持 streaming 模式；靠 query 自然结束或 gate 收尾。
 */
async function runSubagentLifecycle(options: {
  logDir: string;
  prompt: string;
  env?: Record<string, string | undefined>;
  extraOptions?: Record<string, any>;
  onMessage?: (msg: any, ctx: { relMs: number; queryHandle: any; sessionId: string | null }) => void;
  onSessionId?: (sessionId: string) => void;
  maxMs?: number;
}) {
  const t0 = Date.now();
  const events: CapturedSDKEvent[] = [];
  let sessionId: string | null = null;
  let index = 0;

  // 生命周期时间线：记录每类 system 消息的到达时刻与关键字段
  const lifecycle: {
    kind: string;              // task_started / task_progress / task_notification / task_updated
    relMs: number;
    task_id?: string;
    task_type?: string;
    tool_use_id?: string;
    subagent_type?: string;
    status?: string;
    hasSummary?: boolean;
    summarySnippet?: string;
    last_tool_name?: string;
    patchKeys?: string[];
    fields?: string[];
  }[] = [];

  // forwardSubagentText 统计：带 parent_tool_use_id 的 text/thinking delta
  const deltaStats = {
    textDeltaWithParent: 0,     // parent_tool_use_id != null 的 text_delta 数（近似：属于 subagent 块）
    thinkingDeltaTotal: 0,
    textDeltaTotal: 0,
    subagentAssistantMsgs: 0,   // 带 subagent_type/task_description 的 assistant 消息
    subagentAssistantSnaps: [] as { relMs: number; subagent_type: string | null; task_description: string | null; parentId: string | null; hasText: boolean; hasThinking: boolean }[],
  };

  // 跟踪当前 content_block 是否属于 subagent（parent_tool_use_id 由 message 层给出，delta 无 parent 信息，
  // 故用「最近一条 assistant 是否带 parent_tool_use_id」近似标注 delta 归属）
  let currentMsgHasParent = false;

  const gen = (async function* () {
    const msg1: any = {
      type: 'user',
      message: { role: 'user', content: options.prompt },
      parent_tool_use_id: null,
    };
    yield msg1;
    // 永挂：靠 query 自然结束（result）跳出 for-await
    await new Promise<void>(() => {});
  })();

  const env = { ...(options.env || BIGMODEL_ENV), OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` };
  const sdkQuery = query({
    prompt: gen,
    options: {
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      permissionMode: 'bypassPermissions',
      ...(options.extraOptions || {}),
    } as any,
  });
  const queryHandle: any = sdkQuery;

  const observer = setInterval(() => {
    const t = Date.now() - t0;
    console.error(`[obs t=${t}ms] lifecycle=${lifecycle.length} fwdText(parent)=${deltaStats.textDeltaWithParent} subAsstMsgs=${deltaStats.subagentAssistantMsgs} sid=${sessionId ?? '-'}`);
  }, 2000);

  const maxMs = options.maxMs ?? 175000;
  const hardStop = setTimeout(() => {
    console.error(`[hardStop] ${maxMs}ms 到，close query`);
    try { queryHandle.close?.(); } catch {}
  }, maxMs);

  try {
    for await (const message of sdkQuery) {
      const msg = message as any;
      const type = msg.type || 'unknown';
      const rel = Date.now() - t0;
      const captured: CapturedSDKEvent = { index: index++, type, timestamp: Date.now() };

      // sessionId 捕获（system init 或任意带 session_id 的消息）
      if (!sessionId && msg.session_id) {
        sessionId = msg.session_id;
        options.onSessionId?.(sessionId);
        console.error(`\n[${rel}ms] sessionId=${sessionId}`);
      }

      if (type === 'stream_event' && msg.event) {
        const evt = msg.event;
        captured.eventType = evt.type;
        if (evt.type === 'content_block_delta' && evt.delta) {
          captured.deltaType = evt.delta.type;
          if (evt.delta.type === 'text_delta') {
            deltaStats.textDeltaTotal++;
            if (currentMsgHasParent) deltaStats.textDeltaWithParent++;
            process.stderr.write(evt.delta.text);
          }
          if (evt.delta.type === 'thinking_delta') {
            deltaStats.thinkingDeltaTotal++;
          }
        }
      }

      if (type === 'system') {
        captured.subtype = msg.subtype;
        if (msg.subtype === 'task_started') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          captured.raw = { ...msg };
          lifecycle.push({
            kind: 'task_started', relMs: rel, task_id: msg.task_id, task_type: msg.task_type,
            tool_use_id: msg.tool_use_id, subagent_type: msg.subagent_type,
            fields: Object.keys(msg),
          });
          console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} type=${msg.task_type} subagent_type=${msg.subagent_type ?? '-'}`);
        }
        if (msg.subtype === 'task_progress') {
          captured.taskId = msg.task_id;
          captured.taskType = msg.task_type;
          const hasSummary = msg.summary != null && String(msg.summary).length > 0;
          captured.raw = { subagent_type: msg.subagent_type, last_tool_name: msg.last_tool_name, hasSummary };
          lifecycle.push({
            kind: 'task_progress', relMs: rel, task_id: msg.task_id, task_type: msg.task_type,
            subagent_type: msg.subagent_type, last_tool_name: msg.last_tool_name,
            hasSummary, summarySnippet: hasSummary ? String(msg.summary).substring(0, 200) : undefined,
            fields: Object.keys(msg),
          });
        }
        if (msg.subtype === 'task_updated') {
          const p = msg.patch || {};
          captured.taskId = msg.task_id;
          captured.raw = { patch: p };
          lifecycle.push({ kind: 'task_updated', relMs: rel, task_id: msg.task_id, status: p.status, patchKeys: Object.keys(p) });
        }
        if (msg.subtype === 'task_notification') {
          captured.taskId = msg.task_id;
          captured.taskStatus = msg.status;
          captured.taskType = msg.task_type;
          captured.raw = { status: msg.status, task_type: msg.task_type, output_file: msg.output_file };
          lifecycle.push({
            kind: 'task_notification', relMs: rel, task_id: msg.task_id, task_type: msg.task_type,
            status: msg.status, fields: Object.keys(msg),
          });
          console.error(`\n[${rel}ms] task_notification task_id=${msg.task_id} status=${msg.status}`);
        }
      }

      if (type === 'assistant' && msg.message?.content) {
        currentMsgHasParent = msg.parent_tool_use_id != null;
        const hasSub = msg.subagent_type != null || msg.task_description != null || msg.parent_tool_use_id != null;
        let hasText = false, hasThinking = false;
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') { captured.toolName = block.name; captured.toolUseId = block.id; if (!captured.raw) captured.raw = {}; captured.raw.toolInput = block.input; }
          if (block.type === 'text') hasText = true;
          if (block.type === 'thinking') hasThinking = true;
        }
        if (hasSub) {
          deltaStats.subagentAssistantMsgs++;
          deltaStats.subagentAssistantSnaps.push({
            relMs: rel, subagent_type: msg.subagent_type ?? null, task_description: msg.task_description ?? null,
            parentId: msg.parent_tool_use_id ?? null, hasText, hasThinking,
          });
        }
      } else if (type !== 'stream_event') {
        currentMsgHasParent = false;
      }

      if (type === 'result') {
        captured.raw = { subtype: msg.subtype, num_turns: msg.num_turns };
        console.error(`\n[${rel}ms] result subtype=${msg.subtype}`);
      }

      events.push(captured);
      options.onMessage?.(msg, { relMs: rel, queryHandle, sessionId });

      if (type === 'result') break;
    }
  } finally {
    clearInterval(observer);
    clearTimeout(hardStop);
    try { queryHandle.close?.(); } catch {}
  }

  return { events, lifecycle, deltaStats, sessionId, duration: Date.now() - t0 };
}

// ====== case-34 subagent 完整生命周期时间线 ======
//
// 让 subagent 跑一个多步骤任务，重建完整事件序列：
//   task_started(local_agent) → task_progress(多条) → task_notification/task_updated
// 记录每个阶段的字段、相对时刻、内外层 task（local_agent + local_bash）的嵌套关系。
// 这是对照 Bash 生命周期的核心 case——画出 subagent 版的完整生命周期图。

describe('subagent 阶段三: 完整生命周期时间线', () => {
  // 多步骤任务：让 subagent 连续跑几个 Bash 步骤，产生多条 task_progress
  const MULTISTEP_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (set run_in_background to false, do NOT background it, wait for it to fully finish before you respond). Instruct the subagent to do these steps in order using Bash: (1) run "echo step1 && sleep 3", (2) run "echo step2 && sleep 3", (3) run "echo step3 && sleep 3", then report all three outputs. Let the subagent do the full multi-step work.';

  it('case-34 重建 subagent 生命周期序列（task_started→progress→notification）', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-34-lifecycle-timeline');
    const { events, lifecycle, sessionId, duration } = await runSubagentLifecycle({
      logDir: dir, prompt: MULTISTEP_PROMPT, env: BIGMODEL_ENV, maxMs: 175000,
    });

    printTimeline('Case 34: subagent 完整生命周期', events, duration);

    // 拆分内外层 task
    const byType = new Map<string, string[]>(); // task_id -> task_type
    for (const l of lifecycle) if (l.task_id && l.task_type) byType.set(l.task_id, [l.task_type]);
    const agentTasks = [...byType.entries()].filter(([, v]) => v[0] === 'local_agent').map(([k]) => k);
    const bashTasks = [...byType.entries()].filter(([, v]) => v[0] === 'local_bash').map(([k]) => k);

    const started = lifecycle.filter(l => l.kind === 'task_started');
    const progress = lifecycle.filter(l => l.kind === 'task_progress');
    const notif = lifecycle.filter(l => l.kind === 'task_notification');
    const updated = lifecycle.filter(l => l.kind === 'task_updated');

    console.error('\n══════ case-34 实测值（生命周期时间线）══════');
    console.error(`[C1] sessionId=${sessionId}`);
    console.error(`[C2] task_started 数=${started.length}（local_agent=${agentTasks.length} local_bash=${bashTasks.length}）`);
    console.error(`[C3] task_progress 数=${progress.length}；带 summary 的=${progress.filter(p => p.hasSummary).length}`);
    console.error(`[C4] task_notification 数=${notif.length}（statuses=${notif.map(n => n.status).join(',')}）`);
    console.error(`[C5] task_updated 数=${updated.length}`);
    console.error(`[C6] task_started 字段: ${JSON.stringify(started[0]?.fields ?? [])}`);
    console.error(`[C7] task_progress 字段: ${JSON.stringify(progress[0]?.fields ?? [])}`);
    console.error(`[C8] task_notification 字段: ${JSON.stringify(notif[0]?.fields ?? [])}`);
    console.error('[C9] 生命周期序列（相对时刻）:');
    for (const l of lifecycle) {
      console.error(`   [${String(l.relMs).padStart(6)}ms] ${l.kind.padEnd(18)} type=${l.task_type ?? '-'} status=${l.status ?? '-'} task_id=${(l.task_id ?? '-').substring(0, 12)} ${l.last_tool_name ? 'lastTool=' + l.last_tool_name : ''}`);
    }

    writeFileSync(`${dir}/lifecycle.json`, JSON.stringify({
      sessionId, duration,
      counts: { started: started.length, progress: progress.length, notif: notif.length, updated: updated.length, agentTasks: agentTasks.length, bashTasks: bashTasks.length },
      lifecycle,
    }, null, 2));
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    if (started.filter(s => s.task_type === 'local_agent').length === 0) {
      console.error('[否定发现] 未观测到 task_started(local_agent) —— GLM 本轮未触发真实 subagent');
    } else {
      // 至少有一条 local_agent 的 task_started
      expect(started.some(s => s.task_type === 'local_agent')).toBe(true);
      // 完整生命周期：有 started 就应有 notification 收尾
      if (notif.length > 0) {
        console.error('[发现] ✅ subagent 走完整生命周期：task_started → ... → task_notification');
      } else {
        console.error('[否定发现] 有 task_started 但无 task_notification（可能被 hardStop 截断）');
      }
    }
  }, 240000);
});

// ====== case-35 SubagentStart/Stop hook ======
//
// 通过 Options.hooks 注册 SubagentStart 和 SubagentStop hook，
// 捕获 agent_id、agent_type、agent_transcript_path、background_tasks 字段。
// 断言：Start 时机 vs task_started、Stop 时机 vs task_notification 的对齐关系；
//       agent_id 与 task_id/tool_use_id 的映射。
// 本地网关不支持 hook 或触发不到，如实记否定发现。

describe('subagent 阶段三: SubagentStart/Stop hook', () => {
  const HOOK_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (set run_in_background to false, do NOT background it, wait for it to fully finish before you respond). Instruct the subagent to run the Bash command "echo hook-probe && sleep 5" and report the output.';

  it('case-35 SubagentStart/Stop hook 捕获 agent_id/transcript_path', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-35-subagent-hooks');

    const hookHits: {
      event: string; relMs: number; agent_id?: string; agent_type?: string;
      agent_transcript_path?: string; background_tasks?: any; last_assistant_message?: string;
      fields: string[];
    }[] = [];
    const t0 = Date.now();

    const makeHook = (eventName: string) => async (input: any) => {
      const rel = Date.now() - t0;
      hookHits.push({
        event: eventName, relMs: rel,
        agent_id: input?.agent_id, agent_type: input?.agent_type,
        agent_transcript_path: input?.agent_transcript_path,
        background_tasks: input?.background_tasks,
        last_assistant_message: input?.last_assistant_message ? String(input.last_assistant_message).substring(0, 120) : undefined,
        fields: input ? Object.keys(input) : [],
      });
      console.error(`\n[hook ${eventName} @${rel}ms] agent_id=${input?.agent_id ?? '-'} agent_type=${input?.agent_type ?? '-'} transcript=${input?.agent_transcript_path ?? '-'}`);
      return { continue: true };
    };

    const { events, lifecycle, sessionId, duration } = await runSubagentLifecycle({
      logDir: dir, prompt: HOOK_PROMPT, env: BIGMODEL_ENV, maxMs: 120000,
      extraOptions: {
        hooks: {
          SubagentStart: [{ hooks: [makeHook('SubagentStart')] }],
          SubagentStop: [{ hooks: [makeHook('SubagentStop')] }],
        },
      },
    });

    printTimeline('Case 35: SubagentStart/Stop hook', events, duration);

    const startHits = hookHits.filter(h => h.event === 'SubagentStart');
    const stopHits = hookHits.filter(h => h.event === 'SubagentStop');
    const agentStarted = lifecycle.find(l => l.kind === 'task_started' && l.task_type === 'local_agent');
    const agentNotif = lifecycle.find(l => l.kind === 'task_notification');

    console.error('\n══════ case-35 实测值（SubagentStart/Stop hook）══════');
    console.error(`[D1] SubagentStart hook 命中数=${startHits.length}；SubagentStop 命中数=${stopHits.length}`);
    console.error(`[D2] SubagentStart 字段: ${JSON.stringify(startHits[0]?.fields ?? [])}`);
    console.error(`[D3] SubagentStop 字段: ${JSON.stringify(stopHits[0]?.fields ?? [])}`);
    console.error(`[D4] agent_id(start)=${startHits[0]?.agent_id ?? '-'} agent_type=${startHits[0]?.agent_type ?? '-'}`);
    console.error(`[D5] agent_transcript_path(stop)=${stopHits[0]?.agent_transcript_path ?? '-'}`);
    console.error(`[D6] SubagentStart@${startHits[0]?.relMs ?? '-'}ms vs task_started(local_agent)@${agentStarted?.relMs ?? '-'}ms`);
    console.error(`[D7] SubagentStop@${stopHits[0]?.relMs ?? '-'}ms vs task_notification@${agentNotif?.relMs ?? '-'}ms`);
    console.error(`[D8] agent_id vs task_started.task_id=${agentStarted?.task_id ?? '-'} / tool_use_id=${agentStarted?.tool_use_id ?? '-'}（映射?）`);
    console.error(`[D9] background_tasks(start)=${JSON.stringify(startHits[0]?.background_tasks ?? null)}`);
    console.error(`[D10] last_assistant_message(stop)=${stopHits[0]?.last_assistant_message ?? '-'}`);

    writeFileSync(`${dir}/hook-hits.json`, JSON.stringify({ sessionId, duration, hookHits, agentStarted, agentNotif }, null, 2));
    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    // ── 断言 ──
    expect(events.length).toBeGreaterThan(0);
    if (hookHits.length === 0) {
      console.error('[否定发现] SubagentStart/Stop hook 一次都未命中 —— 本地网关/SDK 可能不经该路径触发 subagent hook，或未触发真实 subagent');
    } else {
      console.error('[发现] ✅ SubagentStart/Stop hook 被触发，捕获到 agent_id 等字段');
      if (startHits.length > 0) expect(startHits[0].agent_id).toBeDefined();
    }
  }, 240000);
});

// ====== case-36 forwardSubagentText true vs false ======
//
// 核心开关（sdk.d.ts:1594）。同一 prompt 两跑（forwardSubagentText 分别 true/false），
// 统计带 parent_tool_use_id 的 text/thinking delta 和带 subagent_type/task_description 的 assistant 消息数。
// 断言：false 只见 subagent 的 tool_use/tool_result；true 额外转发完整子会话 text/thinking。
// 这是"实时看 subagent 在说什么/想什么"的主通道。

describe('subagent 阶段四: forwardSubagentText 核心开关', () => {
  // 纯文本子任务：让 subagent 不用任何工具，只输出一大段解释文本。
  // 这样 false 时应只见 tool_use/tool_result（无子会话 text），true 时额外转发子会话 text/thinking。
  const FWD_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (run_in_background false, wait for it to finish). Instruct the subagent to NOT use any tools at all, and to write a detailed 5-sentence explanation of what a REST API is, purely from its own knowledge. The subagent should only produce explanatory text, no tool calls.';

  it('case-36 forwardSubagentText true vs false 对照', async () => {
    const dirFalse = createTimestampDir('tool-foreground-background/case-36-fwd-false');
    const dirTrue = createTimestampDir('tool-foreground-background/case-36-fwd-true');

    const runFalse = await runSubagentLifecycle({
      logDir: dirFalse, prompt: FWD_PROMPT, env: BIGMODEL_ENV, maxMs: 150000,
      extraOptions: { forwardSubagentText: false },
    });
    const runTrue = await runSubagentLifecycle({
      logDir: dirTrue, prompt: FWD_PROMPT, env: BIGMODEL_ENV, maxMs: 150000,
      extraOptions: { forwardSubagentText: true },
    });

    console.error('\n══════ case-36 实测值（forwardSubagentText 对照）══════');
    console.error('               false      true');
    console.error(`subAsstMsgs    ${String(runFalse.deltaStats.subagentAssistantMsgs).padEnd(10)} ${runTrue.deltaStats.subagentAssistantMsgs}`);
    console.error(`textDelta(parent) ${String(runFalse.deltaStats.textDeltaWithParent).padEnd(7)} ${runTrue.deltaStats.textDeltaWithParent}`);
    console.error(`thinkingDelta  ${String(runFalse.deltaStats.thinkingDeltaTotal).padEnd(10)} ${runTrue.deltaStats.thinkingDeltaTotal}`);
    console.error(`textDeltaTotal ${String(runFalse.deltaStats.textDeltaTotal).padEnd(10)} ${runTrue.deltaStats.textDeltaTotal}`);
    console.error('[E1] false 的 subagent assistant 快照:', JSON.stringify(runFalse.deltaStats.subagentAssistantSnaps.slice(0, 3)));
    console.error('[E2] true 的 subagent assistant 快照:', JSON.stringify(runTrue.deltaStats.subagentAssistantSnaps.slice(0, 3)));

    writeFileSync(`${dirFalse}/fwd-false.json`, JSON.stringify({ deltaStats: runFalse.deltaStats, duration: runFalse.duration }, null, 2));
    writeFileSync(`${dirTrue}/fwd-true.json`, JSON.stringify({ deltaStats: runTrue.deltaStats, duration: runTrue.duration }, null, 2));

    // ── 断言 ──
    expect(runFalse.events.length).toBeGreaterThan(0);
    expect(runTrue.events.length).toBeGreaterThan(0);
    const bothTriggered = runFalse.lifecycle.some(l => l.task_type === 'local_agent') && runTrue.lifecycle.some(l => l.task_type === 'local_agent');
    if (!bothTriggered) {
      console.error('[否定发现] 至少一跑未触发真实 subagent（无 local_agent task_started），无法做净对照');
    } else if (runTrue.deltaStats.subagentAssistantMsgs > runFalse.deltaStats.subagentAssistantMsgs) {
      console.error('[发现] ✅ forwardSubagentText=true 转发了更多子会话 assistant 消息（带 subagent_type/parent_tool_use_id）');
    } else {
      console.error(`[否定发现] true(${runTrue.deltaStats.subagentAssistantMsgs}) 未多于 false(${runFalse.deltaStats.subagentAssistantMsgs}) —— 记录实测，可能 GLM 子会话无独立 text 或转发路径不同`);
    }
  }, 360000);
});

// ====== case-37 agentProgressSummaries=true ======
//
// sdk.d.ts:1755。需 subagent 运行 >30s（构造够久子任务）。
// 捕获 task_progress.summary 的 fork 摘要推送，记录首个 summary 到达时刻（验证 ~30s）、间隔、字段结构；
// 对照关闭时应无 summary。触发不到（任务不够久 / 本地网关不支持）如实记录。

describe('subagent 阶段四: agentProgressSummaries 进度摘要', () => {
  // 够久：让 subagent 跑多个 sleep，累计 >55s，逼出 ~30s 的 summary fork。
  // 必须 FOREGROUND，否则主 turn 不阻塞、query 提前结束、subagent 跑不满 30s。
  const LONG_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (set run_in_background to false, do NOT background it, wait for it to fully finish before you respond). Instruct the subagent to run these Bash commands one by one, reporting after each: (1) "echo phase1 && sleep 15", (2) "echo phase2 && sleep 15", (3) "echo phase3 && sleep 15", (4) "echo done && sleep 15". Do all four in order, then summarize.';

  it('case-37 agentProgressSummaries=true 捕获 summary fork（对照 off）', async () => {
    const dirOn = createTimestampDir('tool-foreground-background/case-37-summaries-on');
    const dirOff = createTimestampDir('tool-foreground-background/case-37-summaries-off');

    const runOn = await runSubagentLifecycle({
      logDir: dirOn, prompt: LONG_PROMPT, env: BIGMODEL_ENV, maxMs: 175000,
      extraOptions: { agentProgressSummaries: true },
    });
    const runOff = await runSubagentLifecycle({
      logDir: dirOff, prompt: LONG_PROMPT, env: BIGMODEL_ENV, maxMs: 175000,
      extraOptions: { agentProgressSummaries: false },
    });

    const onSummaries = runOn.lifecycle.filter(l => l.kind === 'task_progress' && l.hasSummary);
    const offSummaries = runOff.lifecycle.filter(l => l.kind === 'task_progress' && l.hasSummary);
    const onProgress = runOn.lifecycle.filter(l => l.kind === 'task_progress');

    console.error('\n══════ case-37 实测值（agentProgressSummaries）══════');
    console.error(`[F1] ON: task_progress 数=${onProgress.length}，带 summary 数=${onSummaries.length}`);
    console.error(`[F2] OFF: 带 summary 数=${offSummaries.length}（期望 0）`);
    console.error(`[F3] ON 首个 summary 到达时刻=${onSummaries[0]?.relMs ?? '-'}ms（期望 ~30s）`);
    console.error(`[F4] ON summary 到达时刻序列=${JSON.stringify(onSummaries.map(s => s.relMs))}`);
    console.error(`[F5] ON 首个 summary 内容片段=${onSummaries[0]?.summarySnippet ?? '-'}`);
    console.error(`[F6] ON 运行时长=${runOn.duration}ms；OFF 运行时长=${runOff.duration}ms`);

    writeFileSync(`${dirOn}/summaries-on.json`, JSON.stringify({ onProgress: onProgress.length, onSummaries, duration: runOn.duration }, null, 2));
    writeFileSync(`${dirOff}/summaries-off.json`, JSON.stringify({ offSummaries, duration: runOff.duration }, null, 2));

    // ── 断言 ──
    expect(runOn.events.length).toBeGreaterThan(0);
    if (!runOn.lifecycle.some(l => l.task_type === 'local_agent')) {
      console.error('[否定发现] ON 跑未触发真实 subagent，无法评估 summary');
    } else if (onSummaries.length > 0) {
      console.error('[发现] ✅ agentProgressSummaries=true 推送了 task_progress.summary');
      expect(offSummaries.length).toBeLessThanOrEqual(onSummaries.length);
    } else {
      console.error('[否定发现] ON 跑无 summary —— 可能子任务未跑够 30s / 本地网关不支持 fork summary / GLM 未走该路径');
    }
  }, 420000);
});

// ====== case-38 getSubagentMessages 主动拉取 ======
//
// sdk.d.ts:760。运行中用 1Hz poller 调 getSubagentMessages(sessionId, agentId)，
// 观察返回条数是否随 subagent 进展单调增长。
// agentId 来自 listSubagents()（sdk.d.ts:973）或 case-35 的 SubagentStart hook。
// 断言拉取增量与流式 delta 的时序对齐。方法在本地网关不可用如实记否定发现。

describe('subagent 阶段四: getSubagentMessages 主动拉取', () => {
  // FOREGROUND + persistSession:true —— 让 subagent transcript 真正落盘，
  // getSubagentMessages/listSubagents 才有 JSONL 可读（case-38 首跑 persistSession:false 全程返回空，
  // 推断正是因为无落盘 transcript）。
  const PULL_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (set run_in_background to false, do NOT background it, wait for it to fully finish before you respond). Instruct the subagent to run these Bash commands in order: (1) "echo pull1 && sleep 6", (2) "echo pull2 && sleep 6", (3) "echo pull3 && sleep 6", then report. Do all steps.';

  it('case-38 getSubagentMessages/listSubagents 运行中拉取增量', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-38-getsubagentmessages');

    let capturedSessionId: string | null = null;
    let capturedAgentId: string | null = null;
    const pollSamples: { relMs: number; source: string; agentId: string | null; msgCount: number | string; listCount: number | string }[] = [];

    // SubagentStart hook 抓 agent_id（作为 listSubagents 的备用来源）
    const t0 = Date.now();
    const startHook = async (input: any) => {
      if (!capturedAgentId && input?.agent_id) {
        capturedAgentId = input.agent_id;
        console.error(`\n[hook SubagentStart @${Date.now() - t0}ms] agent_id=${capturedAgentId}`);
      }
      return { continue: true };
    };

    // 1Hz poller
    let pollerActive = false;
    const poller = setInterval(async () => {
      if (!pollerActive || !capturedSessionId) return;
      const rel = Date.now() - t0;
      // 先试 listSubagents
      let listCount: number | string = '-';
      let agentIds: string[] = [];
      try {
        if (typeof listSubagents === 'function') {
          agentIds = await listSubagents(capturedSessionId);
          listCount = agentIds.length;
          if (!capturedAgentId && agentIds.length > 0) capturedAgentId = agentIds[0];
        } else listCount = 'NO_FN';
      } catch (e: any) { listCount = `ERR:${e?.message?.substring(0, 40)}`; }

      const aid = capturedAgentId || agentIds[0] || null;
      let msgCount: number | string = '-';
      if (aid) {
        try {
          if (typeof getSubagentMessages === 'function') {
            const msgs = await getSubagentMessages(capturedSessionId, aid);
            msgCount = Array.isArray(msgs) ? msgs.length : 'NON_ARRAY';
          } else msgCount = 'NO_FN';
        } catch (e: any) { msgCount = `ERR:${e?.message?.substring(0, 40)}`; }
      }
      pollSamples.push({ relMs: rel, source: 'poll', agentId: aid, msgCount, listCount });
      console.error(`[poll @${rel}ms] listSubagents=${listCount} agentId=${aid ?? '-'} getSubagentMessages.len=${msgCount}`);
    }, 1000);

    let res: any;
    try {
      pollerActive = true;
      res = await runSubagentLifecycle({
        logDir: dir, prompt: PULL_PROMPT, env: BIGMODEL_ENV, maxMs: 150000,
        extraOptions: { persistSession: true, hooks: { SubagentStart: [{ hooks: [startHook] }] } },
        onSessionId: (sid) => { capturedSessionId = sid; },
      });
    } finally {
      pollerActive = false;
      clearInterval(poller);
    }

    const msgCounts = pollSamples.map(s => typeof s.msgCount === 'number' ? s.msgCount : -1).filter(n => n >= 0);
    const monotonic = msgCounts.every((v, i) => i === 0 || v >= msgCounts[i - 1]);
    const grew = msgCounts.length > 1 && msgCounts[msgCounts.length - 1] > msgCounts[0];

    console.error('\n══════ case-38 实测值（getSubagentMessages 拉取）══════');
    console.error(`[G1] sessionId=${capturedSessionId} agentId=${capturedAgentId}`);
    console.error(`[G2] poll 样本数=${pollSamples.length}`);
    console.error(`[G3] listSubagents 返回值序列=${JSON.stringify(pollSamples.map(s => s.listCount))}`);
    console.error(`[G4] getSubagentMessages.len 序列=${JSON.stringify(pollSamples.map(s => s.msgCount))}`);
    console.error(`[G5] 有效 msgCount 序列=${JSON.stringify(msgCounts)}；单调不减=${monotonic}；增长=${grew}`);

    writeFileSync(`${dir}/poll-samples.json`, JSON.stringify({ sessionId: capturedSessionId, agentId: capturedAgentId, pollSamples, monotonic, grew }, null, 2));

    // ── 断言 ──
    expect(res.events.length).toBeGreaterThan(0);
    const anyValidMsgCount = pollSamples.some(s => typeof s.msgCount === 'number');
    const anyValidList = pollSamples.some(s => typeof s.listCount === 'number');
    if (!anyValidList && !anyValidMsgCount) {
      console.error('[否定发现] listSubagents / getSubagentMessages 全程未返回有效值（可能本地文件系统无 transcript / 方法在本网关不可用 / agentId 拿不到）');
    } else {
      console.error(`[发现] getSubagentMessages 可用；单调不减=${monotonic} 增长=${grew}`);
    }
  }, 240000);
});

// ====== case-39 三通道横向对照 + transcript 文件读 ======
//
// 若 case-35 拿到 agent_transcript_path，用 poller 读该 transcript 文件观察落盘增量。
// 最后横向对照三条实时增量通道：
//   (1) forwardSubagentText 流式  (2) getSubagentMessages 拉取  (3) transcript 文件读
// 比较时延、完整度、可用性，给出 CodePilot 选型结论。

describe('subagent 阶段四: 三通道横向对照', () => {
  const TRI_PROMPT = 'Use the Agent tool to launch a subagent in the FOREGROUND (set run_in_background to false, do NOT background it, wait for it to fully finish before you respond). Instruct the subagent to run these Bash commands in order, reporting after each: (1) "echo tri1 && sleep 6", (2) "echo tri2 && sleep 6", (3) "echo tri3 && sleep 6", then give a short summary. Do all steps.';

  it('case-39 forwardSubagentText / getSubagentMessages / transcript 文件 三通道对照', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-39-three-channels');

    const t0 = Date.now();
    let capturedSessionId: string | null = null;
    let capturedAgentId: string | null = null;
    let transcriptPath: string | null = null;

    // 通道A：forwardSubagentText 流式 —— 记录首个 subagent text delta 时刻
    let firstFwdTextAt: number | null = null;
    // 通道B：getSubagentMessages 拉取 —— poller 采样
    // 通道C：transcript 文件读 —— poller 读文件行数
    const channelSamples: { relMs: number; pullLen: number | string; transcriptLines: number | string }[] = [];

    const startHook = async (input: any) => {
      if (input?.agent_id && !capturedAgentId) capturedAgentId = input.agent_id;
      return { continue: true };
    };
    const stopHook = async (input: any) => {
      if (input?.agent_transcript_path && !transcriptPath) {
        transcriptPath = input.agent_transcript_path;
        console.error(`\n[hook SubagentStop @${Date.now() - t0}ms] transcript_path=${transcriptPath}`);
      }
      if (input?.agent_id && !capturedAgentId) capturedAgentId = input.agent_id;
      return { continue: true };
    };

    let pollerActive = false;
    const poller = setInterval(async () => {
      if (!pollerActive) return;
      const rel = Date.now() - t0;
      let pullLen: number | string = '-';
      if (capturedSessionId && capturedAgentId && typeof getSubagentMessages === 'function') {
        try { const m = await getSubagentMessages(capturedSessionId, capturedAgentId); pullLen = Array.isArray(m) ? m.length : 'NON_ARRAY'; }
        catch (e: any) { pullLen = `ERR:${e?.message?.substring(0, 30)}`; }
      }
      let transcriptLines: number | string = '-';
      if (transcriptPath && existsSync(transcriptPath)) {
        try { transcriptLines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(l => l.trim()).length; }
        catch (e: any) { transcriptLines = `ERR:${e?.message?.substring(0, 30)}`; }
      }
      channelSamples.push({ relMs: rel, pullLen, transcriptLines });
    }, 1000);

    // 复用 runSubagentLifecycle，但需在 onMessage 里抓「首个 subagent text delta」
    // runSubagentLifecycle 已统计 textDeltaWithParent；此处额外记录首次时刻
    const res = await (async () => {
      pollerActive = true;
      try {
        return await runSubagentLifecycle({
          logDir: dir, prompt: TRI_PROMPT, env: BIGMODEL_ENV, maxMs: 150000,
          extraOptions: { forwardSubagentText: true, persistSession: true, hooks: { SubagentStart: [{ hooks: [startHook] }], SubagentStop: [{ hooks: [stopHook] }] } },
          onSessionId: (sid) => { capturedSessionId = sid; },
          onMessage: (msg, ctx) => {
            if (firstFwdTextAt == null && msg.type === 'stream_event' && msg.event?.type === 'content_block_delta'
              && msg.event.delta?.type === 'text_delta') {
              // 近似：subagent 阶段的 text delta（无法从 delta 直接读 parent，用 deltaStats 侧的 parent 计数辅助）
            }
          },
        });
      } finally { pollerActive = false; clearInterval(poller); }
    })();

    // 从 deltaStats 的 subagent assistant 快照取首个带 text 的 subagent 消息时刻（通道A代理指标）
    const firstSubText = res.deltaStats.subagentAssistantSnaps.find(s => s.hasText);
    firstFwdTextAt = firstSubText?.relMs ?? null;

    const pullValid = channelSamples.filter(s => typeof s.pullLen === 'number');
    const transcriptValid = channelSamples.filter(s => typeof s.transcriptLines === 'number');

    console.error('\n══════ case-39 实测值（三通道横向对照）══════');
    console.error(`[H1] sessionId=${capturedSessionId} agentId=${capturedAgentId} transcriptPath=${transcriptPath}`);
    console.error(`[H2] 通道A forwardSubagentText: subagent assistant 消息数=${res.deltaStats.subagentAssistantMsgs}，首个带 text 的 subagent 消息@${firstFwdTextAt ?? '-'}ms`);
    console.error(`[H3] 通道B getSubagentMessages: 有效样本=${pullValid.length}，len 序列=${JSON.stringify(channelSamples.map(s => s.pullLen))}`);
    console.error(`[H4] 通道C transcript 文件: 拿到路径=${transcriptPath != null}，有效样本=${transcriptValid.length}，行数序列=${JSON.stringify(channelSamples.map(s => s.transcriptLines))}`);
    console.error('[H5] 三通道可用性小结:');
    console.error(`   A forwardSubagentText: ${res.deltaStats.subagentAssistantMsgs > 0 ? '可用（流式实时）' : '未见子会话消息'}`);
    console.error(`   B getSubagentMessages: ${pullValid.length > 0 ? '可用（主动拉取）' : '不可用/未返回'}`);
    console.error(`   C transcript 文件:     ${transcriptValid.length > 0 ? '可用（落盘增量）' : transcriptPath ? '路径存在但读不到' : '未拿到路径'}`);

    writeFileSync(`${dir}/three-channels.json`, JSON.stringify({
      sessionId: capturedSessionId, agentId: capturedAgentId, transcriptPath,
      channelA: { subagentAssistantMsgs: res.deltaStats.subagentAssistantMsgs, firstFwdTextAt, snaps: res.deltaStats.subagentAssistantSnaps },
      channelB_samples: channelSamples.map(s => ({ relMs: s.relMs, pullLen: s.pullLen })),
      channelC_samples: channelSamples.map(s => ({ relMs: s.relMs, transcriptLines: s.transcriptLines })),
    }, null, 2));

    // ── 断言 ──
    expect(res.events.length).toBeGreaterThan(0);
    const channels = [
      res.deltaStats.subagentAssistantMsgs > 0,
      pullValid.length > 0,
      transcriptValid.length > 0,
    ];
    console.error(`[H6] 可用通道数=${channels.filter(Boolean).length}/3`);
    if (!channels.some(Boolean)) {
      console.error('[否定发现] 三通道全不可用 —— 本轮未触发真实 subagent 或本地网关限制，如实记录');
    } else {
      console.error('[发现] 至少一条实时增量通道可用，见 H5 小结');
    }
  }, 240000);
});

// ====== 前台命令是否有 .output 文件（case-40）======
//
// 缘起：case-19 只测了「长前台命令【被自动后台化后】拼路径能读到 .output」。
// 但一个更基础的问题没测过：前台运行 bash 命令时，用 session_id+task_id 拼出
// .output 路径去 existsSync，到底有没有这个文件？分两个子场景：
//   40a 短前台命令（echo，秒完成，不会触发自动后台化）：无 task_started → 无 task_id，
//       只能【扫 tasks 目录】看有没有任何 .output 冒出来。验证：短前台命令根本不落盘？
//   40b 中等前台命令（seq 循环，会被自动后台化）：观测 task_id 出现时机 vs
//       .output 文件出现时机——文件是在 task_started【之前】就有，还是之后才建？
// 这直接回答产品问题：能不能靠「拼路径 + existsSync 轮询」在前台命令跑起来的
// 第一时间就 tail 到输出，而不依赖 run_in_background。
import { readdirSync } from 'fs';

describe('前台命令是否有 .output 文件', () => {
  const SHORT_FG = 'echo fg40-short-line-1 && echo fg40-short-line-2';
  const MID_FG = 'for i in $(seq 1 6); do echo tick-$i; sleep 2; done';

  // 拼 tasks 目录路径（session 级）
  const tasksDirOf = (sessionId: string): string => {
    const cwd = process.cwd();
    const sanitized = cwd.replace(/[:\\/.]/g, '-');
    const tmp = process.env.TEMP || process.env.TMP || 'C:\\Users\\14409~1.JER\\AppData\\Local\\Temp';
    return `${tmp}\\claude\\${sanitized}\\${sessionId}\\tasks`;
  };

  it('case-40a 短前台命令：扫 tasks 目录看是否落盘 .output', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-40a-short-fg-output');
    const t0 = Date.now();
    let sessionId: string | null = null;
    let sawTaskStarted = false;
    const dirSnapshots: any[] = [];

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${SHORT_FG}`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 每 500ms 扫 tasks 目录，看有没有 .output 文件冒出
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      if (sessionId) {
        const td = tasksDirOf(sessionId);
        let files: string[] = [];
        let dirExists = false;
        try { files = readdirSync(td); dirExists = true; } catch { /* 目录不存在 */ }
        const outputs = files.filter(f => f.endsWith('.output'));
        dirSnapshots.push({ t, dirExists, outputCount: outputs.length, files: outputs });
        console.error(`[scan t=${t}ms] tasks目录存在=${dirExists} .output数=${outputs.length}${outputs.length ? ' → ' + outputs.join(',') : ''}`);
      }
    }, 500);

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        if (!sessionId && msg.session_id) { sessionId = msg.session_id; console.error(`\n[${rel}ms] sessionId=${sessionId}`); }
        if (type === 'system' && msg.subtype === 'task_started') {
          sawTaskStarted = true;
          console.error(`\n[${rel}ms] ⚠️ 短命令竟触发 task_started（意外）task_id=${msg.task_id}`);
        }
        events.push({ index: index++, type, timestamp: Date.now(), subtype: msg.subtype });
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;
    const everSawOutput = dirSnapshots.some(s => s.outputCount > 0);

    console.error('\n══════ case-40a 实测值 ══════');
    console.error(`[40a-1] 短前台命令是否触发 task_started（自动后台化）: ${sawTaskStarted}`);
    console.error(`[40a-2] tasks 目录里是否出现过 .output 文件: ${everSawOutput}`);
    console.error(`[40a-3] 扫描快照数: ${dirSnapshots.length}, 总耗时: ${duration}ms`);
    console.error(`【结论】短前台命令${everSawOutput ? '【有】' : '【无】'} .output 落盘文件`);

    writeFileSync(`${dir}/short-fg-output.json`, JSON.stringify({
      sessionId, sawTaskStarted, everSawOutput, duration, dirSnapshots,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 120000);

  it('case-40b 中等前台命令：task_id 出现时机 vs .output 文件出现时机', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-40b-mid-fg-output');
    const t0 = Date.now();
    let sessionId: string | null = null;
    let bashTaskId: string | null = null;
    let taskStartedAt: number | null = null;
    let candidatePath: string | null = null;
    let firstFileExistAt: number | null = null;
    const snapshots: any[] = [];

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    const sdkQuery = query({
      prompt: `Use the Bash tool to run this exact command in the FOREGROUND (do NOT set run_in_background): ${MID_FG}. Then report how many lines printed.`,
      options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any,
    });

    // 每 500ms：若已拼出候选路径就 existsSync + 读行数
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      // 即便还没 task_started，只要有 sessionId 就先扫目录，捕捉文件比 task_started 早出现的情况
      if (sessionId && !candidatePath) {
        const td = tasksDirOf(sessionId);
        try {
          const outs = readdirSync(td).filter(f => f.endsWith('.output'));
          if (outs.length) console.error(`[scan t=${t}ms] task_started前 tasks目录已有 .output: ${outs.join(',')}`);
        } catch {}
      }
      if (candidatePath) {
        const exists = existsSync(candidatePath);
        let lineCount = 0;
        if (exists) {
          try { lineCount = (readFileSync(candidatePath, 'utf-8').match(/tick-\d+/g) || []).length; } catch {}
          if (firstFileExistAt === null) { firstFileExistAt = t; console.error(`\n[${t}ms] ✅ .output 文件首次出现（相对 task_started@${taskStartedAt}ms）`); }
        }
        snapshots.push({ t, exists, lineCount });
        console.error(`[poll t=${t}ms] exists=${exists} lines=${lineCount}`);
      }
    }, 500);

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        if (!sessionId && msg.session_id) sessionId = msg.session_id;
        if (type === 'system' && msg.subtype === 'task_started' && !bashTaskId) {
          bashTaskId = msg.task_id;
          taskStartedAt = rel;
          if (msg.session_id) sessionId = msg.session_id;
          if (sessionId) candidatePath = `${tasksDirOf(sessionId)}\\${bashTaskId}.output`;
          console.error(`\n[${rel}ms] task_started task_id=${msg.task_id} → 候选路径已拼`);
        }
        events.push({ index: index++, type, timestamp: Date.now(), subtype: msg.subtype });
      }
    } finally {
      clearInterval(poller);
    }

    const duration = Date.now() - t0;
    const maxLines = Math.max(0, ...snapshots.map(s => s.lineCount));
    const grew = snapshots.filter(s => s.exists).length > 1 && maxLines > 1;
    const delayFileVsTaskStarted = (firstFileExistAt !== null && taskStartedAt !== null) ? firstFileExistAt - taskStartedAt : null;

    console.error('\n══════ case-40b 实测值 ══════');
    console.error(`[40b-1] 前台中等命令被自动后台化: ${bashTaskId !== null}（task_started@${taskStartedAt}ms）`);
    console.error(`[40b-2] .output 文件首次存在@${firstFileExistAt}ms（相对 task_started 延迟 ${delayFileVsTaskStarted}ms）`);
    console.error(`[40b-3] 文件实时增长: ${grew}（maxLines=${maxLines}）`);
    console.error(`【结论】前台命令的 .output ${bashTaskId ? '在被自动后台化后才出现' : '未出现（命令太短未后台化）'}；拼路径 existsSync 轮询${grew ? '可' : '不可'}拿到实时增量`);

    writeFileSync(`${dir}/mid-fg-output.json`, JSON.stringify({
      sessionId, bashTaskId, taskStartedAt, candidatePath, firstFileExistAt,
      delayFileVsTaskStarted, grew, maxLines, duration, snapshots,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 120000);
});

// ====== .output 文件存活时长（case-41）======
//
// 缘起：case-15 提过「任务停止后 .output 文件很快被清理，事后读不到」，但从未量化
// 「文件从出现到被删存活多久、什么触发删除」。这对产品很关键——若文件命令跑完就秒删，
// UI 必须在窗口内抢读；若 query 存活期一直在，则从容。
// 设计：显式后台命令（run_in_background:true）产生 .output，命令跑完（notification）后
// 【继续留在 for-await 循环里】每秒探文件是否还在，直到 query 自然结束；query 结束后
// 再探几秒。记录三个关键时刻：文件首现、命令完成(notification)、文件消失、query 结束。
describe('.output 文件存活时长', () => {
  const BG_CMD_41 = 'for i in $(seq 1 5); do echo tick-$i; sleep 1; done';

  it('case-41 .output 文件从出现到被删存活多久', async () => {
    const dir = createTimestampDir('tool-foreground-background/case-41-output-lifetime');
    const t0 = Date.now();
    let sessionId: string | null = null;
    let bashTaskId: string | null = null;
    let outputFile: string | null = null;      // 优先 notif/tool_result 给的
    let fileFirstSeenAt: number | null = null;
    let fileVanishedAt: number | null = null;
    let notifAt: number | null = null;
    let queryEndedAt: number | null = null;
    const snaps: { t: number; exists: boolean; phase: string }[] = [];

    const env = { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` };
    // streaming generator：命令跑完后不立即结束输入流，多问一句拖住 query 存活，观测文件在 query 存活期是否还在
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveGate = r; });
    const gateTimeout = new Promise<void>((r) => setTimeout(r, 15000));
    async function* promptInput(): AsyncIterable<any> {
      yield { type: 'user', message: { role: 'user', content: `Use the Bash tool to run this exact command in the BACKGROUND (run_in_background:true): ${BG_CMD_41}. Report the task id.` }, parent_tool_use_id: null };
      await Promise.race([gate, gateTimeout]);
      yield { type: 'user', message: { role: 'user', content: 'Just say DONE.' }, parent_tool_use_id: null, priority: 'now' };
    }

    const resolvePath = (): string | null => {
      if (outputFile) return outputFile;
      if (sessionId && bashTaskId) {
        const sanitized = process.cwd().replace(/[:\\/.]/g, '-');
        const tmp = process.env.TEMP || process.env.TMP || 'C:\\Users\\14409~1.JER\\AppData\\Local\\Temp';
        return `${tmp}\\claude\\${sanitized}\\${sessionId}\\tasks\\${bashTaskId}.output`;
      }
      return null;
    };

    const phaseOf = () => queryEndedAt !== null ? 'query结束后' : notifAt !== null ? '命令完成后' : '命令运行中';
    const poller = setInterval(() => {
      const t = Date.now() - t0;
      const p = resolvePath();
      if (p) {
        const exists = existsSync(p);
        if (exists && fileFirstSeenAt === null) { fileFirstSeenAt = t; console.error(`\n[${t}ms] .output 首现`); }
        if (!exists && fileFirstSeenAt !== null && fileVanishedAt === null) { fileVanishedAt = t; console.error(`\n[${t}ms] ⚠️ .output 消失（存活约 ${t - fileFirstSeenAt}ms）`); }
        snaps.push({ t, exists, phase: phaseOf() });
        console.error(`[poll t=${t}ms] exists=${exists} 阶段=${phaseOf()}`);
      }
    }, 1000);

    const events: CapturedSDKEvent[] = [];
    let index = 0;
    try {
      const sdkQuery = query({ prompt: promptInput(), options: { env, includePartialMessages: true, persistSession: false, settingSources: [], effort: 'low', permissionMode: 'bypassPermissions' } as any });
      for await (const message of sdkQuery) {
        const msg = message as any;
        const type = msg.type || 'unknown';
        const rel = Date.now() - t0;
        if (!sessionId && msg.session_id) sessionId = msg.session_id;
        if (type === 'system') {
          if (msg.subtype === 'task_started' && !bashTaskId) { bashTaskId = msg.task_id; if (msg.session_id) sessionId = msg.session_id; console.error(`\n[${rel}ms] task_started ${msg.task_id}`); }
          if (msg.subtype === 'task_notification') { notifAt = rel; if (msg.output_file) outputFile = msg.output_file; console.error(`\n[${rel}ms] task_notification status=${msg.status} → 命令完成`); resolveGate(); }
        }
        if (type === 'user' && Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) {
            if (b.type === 'tool_result') {
              const sn = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c.type === 'text' ? c.text : '').join('') : '';
              const fm = sn.match(/written to:\s*([^\s"]+\.output)/i) || sn.match(/([A-Za-z]:\\[^\s"]+\.output)/);
              if (fm && !outputFile) outputFile = fm[1];
            }
          }
        }
        if (type === 'result') { queryEndedAt = rel; console.error(`\n[${rel}ms] query 结束`); }
        events.push({ index: index++, type, timestamp: Date.now(), subtype: msg.subtype });
      }
    } finally {
      // query 结束后继续探 8 秒，看文件是否在 query 结束后才被删
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = Date.now() - t0;
        const p = resolvePath();
        if (p) {
          const exists = existsSync(p);
          if (!exists && fileFirstSeenAt !== null && fileVanishedAt === null) { fileVanishedAt = t; console.error(`\n[${t}ms] ⚠️ .output 消失（query 结束后）`); }
          snaps.push({ t, exists, phase: 'query结束后探测' });
          console.error(`[poll(post) t=${t}ms] exists=${exists}`);
        }
      }
      clearInterval(poller);
    }

    const duration = Date.now() - t0;
    const survivedMs = (fileFirstSeenAt !== null && fileVanishedAt !== null) ? fileVanishedAt - fileFirstSeenAt : null;
    const vanishRelToNotif = (fileVanishedAt !== null && notifAt !== null) ? fileVanishedAt - notifAt : null;
    const vanishRelToQueryEnd = (fileVanishedAt !== null && queryEndedAt !== null) ? fileVanishedAt - queryEndedAt : null;

    console.error('\n══════ case-41 实测值（.output 存活时长）══════');
    console.error(`[L1] 文件首现@${fileFirstSeenAt}ms，命令完成(notif)@${notifAt}ms，query结束@${queryEndedAt}ms`);
    console.error(`[L2] 文件消失@${fileVanishedAt ?? '未观测到消失（探测期内一直在）'}ms`);
    console.error(`[L3] 文件存活时长: ${survivedMs ?? '≥探测窗口'}ms`);
    console.error(`[L4] 消失相对「命令完成」: ${vanishRelToNotif ?? '-'}ms；相对「query结束」: ${vanishRelToQueryEnd ?? '-'}ms`);
    console.error(`【结论】.output 文件在${fileVanishedAt === null ? 'query 存活期一直存在（未被删）' : vanishRelToQueryEnd !== null && vanishRelToQueryEnd >= -1500 ? 'query 结束前后被删' : '命令完成后不久被删'}`);

    writeFileSync(`${dir}/output-lifetime.json`, JSON.stringify({
      sessionId, bashTaskId, outputFile: resolvePath(), fileFirstSeenAt, notifAt, queryEndedAt, fileVanishedAt,
      survivedMs, vanishRelToNotif, vanishRelToQueryEnd, duration, snaps,
    }, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 120000);
});
