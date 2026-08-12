/**
 * NotebookEdit 工具流式事件观察性测试
 *
 * 调研课题：在流式输出场景下，NotebookEdit 工具调用的完整事件序列。
 *
 * 核心问题：
 * 1. NotebookEdit 工具的 tool_use 调用格式？input 有哪些字段？
 *    - notebook_path (必填): Jupyter notebook 文件的绝对路径
 *    - new_source (必填): 单元格的新源代码
 *    - cell_id?: 单元格 ID
 *    - cell_type?: "code" | "markdown"
 *    - edit_mode?: "replace" | "insert" | "delete"（默认 replace）
 * 2. NotebookEdit 工具的 tool_result 返回值格式？（NotebookEditOutput）
 *    - new_source, cell_id?, cell_type, language, edit_mode, error?, notebook_path, original_file, updated_file
 * 3. Edit 的 read-before-edit 机制是否也适用于 NotebookEdit？
 *    - tools-reference 中提到 NotebookEdit 使用 Edit(...) 路径格式权限
 * 4. tool_progress 的推送频率和内容？
 * 5. 失败场景（文件不存在、cell_id 不存在）的 tool_result 格式？
 *
 * 方法论：
 * - Case 1: NotebookEdit replace 模式 — 完整事件时间线
 * - Case 2: NotebookEdit insert 模式 — 插入新单元格
 * - Case 3: NotebookEdit delete 模式 — 删除单元格
 * - Case 4: NotebookEdit 失败场景 — cell_id 不存在
 * - Case 5: 纯文本基线 — 无工具调用对比
 * - Case 6: 通过 NestJS SSE — 前端视角
 *
 * 注意：NotebookEdit 工具需要权限。通过 bypassPermissions 授权。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTimestampDir } from './helpers';
import { writeFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';

dotenv.config();

// ====== 公共配置 ======

const BASE_ENV = getProfileEnv('local');

// ====== Jupyter Notebook Fixture ======

/** 最小可用的 Jupyter Notebook JSON */
function createNotebookFixture(
  cells: Array<{
    cell_type: 'code' | 'markdown';
    source: string[];
    id?: string;
  }> = [
    {
      cell_type: 'code',
      source: ['print("Hello World")'],
      id: 'cell-1',
    },
    {
      cell_type: 'markdown',
      source: ['# Title\n', 'This is a markdown cell'],
      id: 'cell-2',
    },
  ],
): object {
  return {
    cells: cells.map((c, i) => ({
      cell_type: c.cell_type,
      id: c.id || `cell-${i + 1}`,
      metadata: {},
      source: c.source,
      ...(c.cell_type === 'code'
        ? {
            execution_count: null,
            outputs: [],
          }
        : {}),
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: '3.11.0',
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

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
 * 创建测试用 Jupyter Notebook 文件
 */
function createTestNotebook(dir: string, filename: string, notebook: object): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(notebook, null, 2), 'utf-8');
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

/** 提取 NotebookEdit 和 Read 工具相关事件 */
function extractToolEvents(events: CapturedSDKEvent[], targetToolName: string = 'NotebookEdit') {
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
      if (blockToolName === targetToolName) {
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
    // 所有工具 blocks（含 Read、NotebookEdit）
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

/** 打印 NotebookEdit 工具的 input 和 result 详情 */
function printNotebookEditDetails(toolEvents: ReturnType<typeof extractToolEvents>) {
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
      if (parsed.notebook_path) console.error(`    notebook_path: "${parsed.notebook_path}"`);
      if (parsed.cell_id) console.error(`    cell_id: "${parsed.cell_id}"`);
      if (parsed.new_source) console.error(`    new_source: "${parsed.new_source.substring(0, 100)}"`);
      if (parsed.cell_type) console.error(`    cell_type: "${parsed.cell_type}"`);
      if (parsed.edit_mode) console.error(`    edit_mode: "${parsed.edit_mode}"`);
      if (parsed.file_path) console.error(`    file_path: "${parsed.file_path}"`);
    } catch {
      console.error(`    (JSON 不完整: ${block.fullJson.substring(0, 200)})`);
    }
  }
  console.error('');

  // 分析 NotebookEdit 工具的完整 input
  if (toolEvents.fullInputJson) {
    console.error('── NotebookEdit 工具完整 input JSON ──');
    try {
      const parsed = JSON.parse(toolEvents.fullInputJson);
      console.error(JSON.stringify(parsed, null, 2));
      console.error(`  字段: ${Object.keys(parsed).join(', ')}`);
    } catch {
      console.error(`  (JSON 不完整: ${toolEvents.fullInputJson.substring(0, 300)})`);
    }
  }

  // 分析 user 消息详情（tool_result）— 重点看 NotebookEdit 的结果
  if (toolEvents.userToolResult.length > 0) {
    console.error('\n── user 消息详情（tool_result）──');
    for (const e of toolEvents.userToolResult) {
      console.error(`  [index=${e.index}] tool_use_result type: ${typeof e.raw?.tool_use_result}`);
      if (typeof e.raw?.tool_use_result === 'string') {
        console.error(`    tool_use_result (string): "${e.raw.tool_use_result.substring(0, 500)}"`);
      } else if (e.raw?.tool_use_result) {
        const tr = e.raw.tool_use_result;
        console.error(`    tool_use_result keys: ${Object.keys(tr).join(', ')}`);
        // NotebookEditOutput 的字段
        if (tr.notebook_path) console.error(`    notebook_path: "${tr.notebook_path}"`);
        if (tr.cell_id) console.error(`    cell_id: "${tr.cell_id}"`);
        if (tr.cell_type) console.error(`    cell_type: "${tr.cell_type}"`);
        if (tr.edit_mode) console.error(`    edit_mode: "${tr.edit_mode}"`);
        if (tr.language) console.error(`    language: "${tr.language}"`);
        if (tr.error) console.error(`    error: "${tr.error}"`);
        if (tr.new_source) console.error(`    new_source: "${String(tr.new_source).substring(0, 200)}"`);
        if (tr.original_file) console.error(`    original_file: "${String(tr.original_file).substring(0, 200)}..."`);
        if (tr.updated_file) console.error(`    updated_file: "${String(tr.updated_file).substring(0, 200)}..."`);
      }
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
}

// ====== 测试用例 ======

describe('NotebookEdit 工具流式事件观察', () => {

  /**
   * Case 1: NotebookEdit replace 模式 — 完整事件时间线
   *
   * 观察目标：
   * - NotebookEdit 的 input_json_delta 如何流式构建 notebook_path/cell_id/new_source 参数
   * - 是否需要先 Read notebook 才能 NotebookEdit（read-before-edit）
   * - tool_result 的具体格式（NotebookEditOutput: new_source, cell_id, cell_type, language, edit_mode, error?, notebook_path, original_file, updated_file）
   * - NotebookEdit 执行期间是否有 tool_progress 事件
   */
  it('case-1 NotebookEdit replace 模式 — 完整事件时间线', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-1-replace');

    // 创建测试 notebook
    const notebook = createNotebookFixture([
      { cell_type: 'code', source: ['print("Hello World")'], id: 'abc123' },
      { cell_type: 'markdown', source: ['# Title\n', 'Description'], id: 'def456' },
    ]);
    const notebookPath = createTestNotebook(dir, 'test-notebook.ipynb', notebook);

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the notebook file ${notebookPath.replace(/\\/g, '/')}, then use the NotebookEdit tool to replace the code in cell with id "abc123" with "print('Hello Claude')". Tell me what you changed.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 1: NotebookEdit replace 模式', events, duration);

    const toolEvents = extractToolEvents(events);
    printNotebookEditDetails(toolEvents);

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

    // 检查调用的工具
    const toolNames = toolEvents.allToolBlocks.map(b => b.name);
    console.error(`\n调用的工具: ${toolNames.join(', ')}`);

    // 如果 LLM 成功调用了 NotebookEdit
    const notebookEditAssistant = toolEvents.assistantToolUse.filter(e => e.toolName === 'NotebookEdit');
    if (notebookEditAssistant.length > 0) {
      // NotebookEdit 工具应该有 input_json_delta
      expect(toolEvents.inputDeltaCount).toBeGreaterThan(0);

      // NotebookEdit 工具应该有 user tool_result
      expect(toolEvents.userToolResult.length).toBeGreaterThan(0);

      // 验证 result 消息
      expect(resultEvent).toBeDefined();

      // 检查 NotebookEdit 的 tool_result 内容
      const notebookEditUserMsg = toolEvents.userToolResult.find(e => {
        const result = e.raw?.tool_use_result;
        return result && typeof result === 'object' && (result.notebook_path || result.cell_type);
      });

      if (notebookEditUserMsg) {
        console.error('\n── NotebookEdit tool_use_result 分析 ──');
        const editResult = notebookEditUserMsg.raw.tool_use_result;
        console.error(`  notebook_path: ${editResult.notebook_path}`);
        console.error(`  cell_id: ${editResult.cell_id}`);
        console.error(`  cell_type: ${editResult.cell_type}`);
        console.error(`  edit_mode: ${editResult.edit_mode}`);
        console.error(`  language: ${editResult.language}`);
        console.error(`  new_source: "${String(editResult.new_source).substring(0, 200)}"`);
        console.error(`  error: ${editResult.error}`);
        console.error(`  original_file length: ${String(editResult.original_file || '').length}`);
        console.error(`  updated_file length: ${String(editResult.updated_file || '').length}`);

        // 断言 NotebookEditOutput 结构
        expect(editResult).toHaveProperty('notebook_path');
        expect(editResult).toHaveProperty('cell_type');
        expect(editResult).toHaveProperty('language');
        expect(editResult).toHaveProperty('edit_mode');
        expect(editResult).toHaveProperty('new_source');
      }
    } else {
      console.error('⚠️ LLM 未调用 NotebookEdit（直接文本回答或用了其他方式）');
    }

    if (resultText) {
      expect(resultText.trim().length).toBeGreaterThan(0);
    }
  }, 240000);

  /**
   * Case 2: NotebookEdit insert 模式 — 插入新单元格
   *
   * 观察目标：
   * - edit_mode=insert 时 input 是否包含 cell_type
   * - cell_id 是否用于定位插入位置
   */
  it('case-2 NotebookEdit insert 模式 — 插入新单元格', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-2-insert');

    const notebook = createNotebookFixture([
      { cell_type: 'code', source: ['print("cell 1")'], id: 'first-cell' },
    ]);
    const notebookPath = createTestNotebook(dir, 'test-insert.ipynb', notebook);

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the notebook ${notebookPath.replace(/\\/g, '/')}, then use the NotebookEdit tool to insert a new markdown cell after the cell with id "first-cell". The new cell should contain "# Section 2\\nThis is the second section."`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 2: NotebookEdit insert 模式', events, duration);

    const toolEvents = extractToolEvents(events);
    printNotebookEditDetails(toolEvents);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 3: NotebookEdit delete 模式 — 删除单元格
   *
   * 观察目标：
   * - edit_mode=delete 时 tool_result 是否包含 original_file 和 updated_file
   * - delete 模式是否需要 new_source
   */
  it('case-3 NotebookEdit delete 模式 — 删除单元格', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-3-delete');

    const notebook = createNotebookFixture([
      { cell_type: 'code', source: ['print("keep")'], id: 'keep-cell' },
      { cell_type: 'code', source: ['print("delete me")'], id: 'delete-cell' },
    ]);
    const notebookPath = createTestNotebook(dir, 'test-delete.ipynb', notebook);

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the notebook ${notebookPath.replace(/\\/g, '/')}, then use the NotebookEdit tool to delete the cell with id "delete-cell". Tell me what you deleted.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 3: NotebookEdit delete 模式', events, duration);

    const toolEvents = extractToolEvents(events);
    printNotebookEditDetails(toolEvents);

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 4: NotebookEdit 失败场景 — cell_id 不存在
   *
   * 观察目标：
   * - 失败时 tool_result 是结构化对象还是错误字符串？
   * - NotebookEditOutput.error 字段是否存在
   */
  it('case-4 NotebookEdit 失败场景 — cell_id 不存在', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-4-fail');

    const notebook = createNotebookFixture([
      { cell_type: 'code', source: ['print("hello")'], id: 'real-cell' },
    ]);
    const notebookPath = createTestNotebook(dir, 'test-fail.ipynb', notebook);

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: `Read the notebook ${notebookPath.replace(/\\/g, '/')}, then use the NotebookEdit tool to replace the content of cell with id "NONEXISTENT_CELL_XYZ". Explain what happened.`,
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 4: NotebookEdit 失败场景', events, duration);

    const toolEvents = extractToolEvents(events);
    printNotebookEditDetails(toolEvents);

    // 重点分析失败 tool_result
    console.error('\n── 失败场景 tool_result 分析 ──');
    for (const e of toolEvents.userToolResult) {
      const result = e.raw?.tool_use_result;
      if (result) {
        if (typeof result === 'string') {
          console.error(`  tool_use_result (error string): "${result.substring(0, 500)}"`);
        } else {
          console.error(`  tool_use_result (object) error: ${result.error}`);
          console.error(`  tool_use_result keys: ${Object.keys(result).join(', ')}`);
        }
      }
    }

    writeFileSync(`${dir}/sdk-events.json`, JSON.stringify(events, null, 2));

    expect(events.length).toBeGreaterThan(0);
  }, 240000);

  /**
   * Case 5: 纯文本基线 — 无工具调用对比
   */
  it('case-5 纯文本基线 — 无工具调用对比', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-5-baseline');

    const { events, resultText, duration } = await collectSDKEvents({
      prompt: 'Say exactly: "baseline test". Nothing else.',
      logDir: dir,
      bypassPermissions: true,
    });

    printTimeline('Case 5: 纯文本基线', events, duration);

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

describe('NotebookEdit 工具 SSE 深度事件分析', () => {
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
   * Case 6: NotebookEdit 通过 SSE — 前端视角
   *
   * 观察目标：
   * - 前端收到的 SSE 包装格式
   * - content_block_start(tool_use) 的完整结构（id, name）
   * - input_json_delta 拼接后的完整 JSON
   * - user 消息中 tool_result 的完整结构（NotebookEditOutput 格式）
   * - tool_progress 在 SSE 中的表现
   */
  it('case-6 NotebookEdit SSE 数据格式 — 前端解析参考', async () => {
    const dir = createTimestampDir('stream-tool-notebookedit/case-6-sse-format');

    const notebook = createNotebookFixture([
      { cell_type: 'code', source: ['import numpy as np\n', 'x = np.array([1, 2, 3])\n', 'print(x.mean())'], id: 'numpy-cell' },
      { cell_type: 'markdown', source: ['# Data Analysis\n', 'This notebook demonstrates data analysis.'], id: 'intro-cell' },
    ]);
    const notebookPath = createTestNotebook(dir, 'test-sse.ipynb', notebook);

    const { events, duration } = await collectSSEEvents(
      baseUrl,
      `Read the notebook ${notebookPath.replace(/\\/g, '/')}, then use the NotebookEdit tool to replace the code in cell with id "numpy-cell" with "import pandas as pd\\ndf = pd.DataFrame({'a': [1,2,3]})\\nprint(df.head())". Tell me what you changed.`,
    );

    console.error(`\n${'='.repeat(70)}`);
    console.error('📊 Case 6: NotebookEdit SSE 数据格式 — 前端解析参考');
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
          // 对于 NotebookEdit 工具，打印关键字段
          if (currentToolName === 'NotebookEdit') {
            console.error(`  notebook_path: ${parsed.notebook_path}`);
            console.error(`  cell_id: ${parsed.cell_id}`);
            console.error(`  new_source length: ${parsed.new_source?.length}`);
            console.error(`  cell_type: ${parsed.cell_type}`);
            console.error(`  edit_mode: ${parsed.edit_mode}`);
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
            if (block.name === 'NotebookEdit') {
              console.error(`    input.notebook_path: ${block.input?.notebook_path}`);
              console.error(`    input.cell_id: ${block.input?.cell_id}`);
              console.error(`    input.new_source: "${block.input?.new_source?.substring(0, 200)}"`);
              console.error(`    input.cell_type: ${block.input?.cell_type}`);
              console.error(`    input.edit_mode: ${block.input?.edit_mode}`);
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

    // 提取 user 消息（tool_result）— 重点分析 NotebookEdit 的结果
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
      // tool_use_result — NotebookEdit 的结构化输出
      if (e.inner?.tool_use_result !== undefined) {
        console.error(`  tool_use_result type: ${typeof e.inner.tool_use_result}`);
        if (typeof e.inner.tool_use_result === 'object' && e.inner.tool_use_result !== null) {
          const tr = e.inner.tool_use_result;
          console.error(`  tool_use_result keys: ${Object.keys(tr).join(', ')}`);
          console.error(`  tool_use_result.notebook_path: ${tr.notebook_path}`);
          console.error(`  tool_use_result.cell_id: ${tr.cell_id}`);
          console.error(`  tool_use_result.cell_type: ${tr.cell_type}`);
          console.error(`  tool_use_result.language: ${tr.language}`);
          console.error(`  tool_use_result.edit_mode: ${tr.edit_mode}`);
          console.error(`  tool_use_result.error: ${tr.error}`);
          console.error(`  tool_use_result.new_source: "${String(tr.new_source || '').substring(0, 200)}"`);
          console.error(`  tool_use_result.original_file length: ${String(tr.original_file || '').length}`);
          console.error(`  tool_use_result.updated_file length: ${String(tr.updated_file || '').length}`);
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
});
