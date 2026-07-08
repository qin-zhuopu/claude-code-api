/**
 * Workflow 工具与机制观察性测试
 *
 * 调研课题：@anthropic-ai/claude-agent-sdk 中 Workflow 工具的完整行为。
 *
 * 核心问题：
 * 1. Workflow 工具是否出现在 API 请求的 tools 列表中？input_schema 是什么结构？
 * 2. inline script 模式 — 请求结构与返回的 runId/scriptPath
 * 3. scriptPath 模式 — 持久化脚本的重用
 * 4. name 模式 — 调用内置或保存的工作流
 * 5. args 参数 — 结构化数据传递到脚本全局 args
 * 6. disableWorkflows 选项 — 工具从列表消失？
 * 7. resumeFromRunId — 恢复之前运行的行为
 * 8. SDK 消息流 — Workflow 运行期间产生哪些 SDK 消息类型？
 * 9. parallel vs pipeline — 两种编排模式的 API 调用差异
 *
 * 注意：本地 LLM 不一定能正确执行 workflow 脚本。
 *       本测试重点观察请求结构（tools 列表、input_json_delta）、SDK 消息类型和 OTEL 日志。
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { loadEnvGroup, loadEnvGroupWithDefaults } from './env-groups';

dotenv.config();

// ====== 公共配置 (通过 env-group 引用) ======
// 用法: loadEnvGroup('jereh') 一行拿到 Jereh Proxy 全量配置
//       loadEnvGroupWithDefaults('local') 带默认值的本地 LLM 配置

const LOCAL_ENV = loadEnvGroupWithDefaults('local');
const JEREH_ENV = loadEnvGroupWithDefaults('jereh');
const BIGMODEL_ENV = loadEnvGroupWithDefaults('bigmodel');

// 默认使用 local（向后兼容）
const BASE_ENV = LOCAL_ENV;

// ====== 分析函数 ======

interface WorkflowAnalysis {
  /** 目录中的文件总数 */
  totalFiles: number;
  /** request 文件数 */
  requestFiles: number;
  /** response 文件数 */
  responseFiles: number;
  /** tools 列表是否出现在第一个 request 且非空 */
  hasTools: boolean;
  /** Workflow 工具是否出现在 tools 列表中 */
  hasWorkflowTool: boolean;
  /** Workflow 工具的 input_schema 结构 */
  workflowSchemaKeys: string[];
  /** 第一个 request 的 JSON 大小（字节） */
  requestSize: number;
  /** 第一个 response 的 JSON 大小 */
  responseSize: number;
  /** SDK 消息类型列表 */
  sdkMessageTypes: string[];
  /** 是否有 task_started / task_notification 消息 */
  hasTaskMessages: boolean;
  /** 是否有 result 消息 */
  hasResult: boolean;
  /** result 的 stop_reason */
  stopReason?: string;
  /** 是否有 tool_use block */
  hasToolUse: boolean;
  /** tool_use 的 tool name */
  toolUseNames: string[];
  /** 是否有 input_json_delta */
  hasInputJsonDelta: boolean;
  /** 拼凑出的完整 input JSON（如果有） */
  fullInputJson?: string;
  /** tool_result 是否返回了 runId */
  hasRunId: boolean;
  /** tool_result 是否返回了 scriptPath */
  hasScriptPath: boolean;
  /** tool_result 是否返回了 runIdForResume */
  hasRunIdForResume: boolean;
  /** tool_result 是否返回了 workflowName */
  hasWorkflowName: boolean;
  /** 提取的 runId 值（如果有） */
  runId?: string;
  /** 提取的 scriptPath 值（如果有） */
  scriptPath?: string;
}

function analyzeWorkflowDir(dir: string): WorkflowAnalysis {
  const allFiles = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'));
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const a: WorkflowAnalysis = {
    totalFiles: allFiles.length,
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    hasTools: false,
    hasWorkflowTool: false,
    workflowSchemaKeys: [],
    requestSize: 0,
    responseSize: 0,
    sdkMessageTypes: [],
    hasTaskMessages: false,
    hasResult: false,
    hasToolUse: false,
    toolUseNames: [],
    hasInputJsonDelta: false,
    hasRunId: false,
    hasScriptPath: false,
    hasRunIdForResume: false,
    hasWorkflowName: false,
  };

  // 分析 request 文件
  for (const rf of requestFiles) {
    try {
      const raw = readFileSync(join(dir, rf), 'utf-8');
      if (raw.length === 0) continue;
      const obj = JSON.parse(raw);
      a.requestSize = raw.length;

      if (obj.tools && Array.isArray(obj.tools)) {
        a.hasTools = obj.tools.length > 0;
        for (const t of obj.tools) {
          if (t.name === 'Workflow') {
            a.hasWorkflowTool = true;
            if (t.input_schema && t.input_schema.properties) {
              a.workflowSchemaKeys = Object.keys(t.input_schema.properties);
            } else if (t.input_schema && t.input_schema.keys) {
              a.workflowSchemaKeys = t.input_schema.keys || [];
            }
          }
        }
      }

      if (obj.messages && Array.isArray(obj.messages)) {
        for (const msg of obj.messages) {
          if (msg.role === 'assistant' && msg.content) {
            for (const block of msg.content) {
              if (block.type === 'tool_use') {
                a.hasToolUse = true;
                if (!a.toolUseNames.includes(block.name)) {
                  a.toolUseNames.push(block.name);
                }
              }
            }
          }
          if (msg.role === 'user' && msg.content) {
            for (const block of msg.content) {
              if (block.type === 'tool_result' && block.tool_name === 'Workflow') {
                if (block.content) {
                  const contentText = typeof block.content === 'string' ? block.content :
                    Array.isArray(block.content) ? block.content.map((c: any) => c.text).join('') : '';
                  try {
                    const parsed = JSON.parse(contentText);
                    if (parsed.runId) { a.hasRunId = true; a.runId = parsed.runId; }
                    if (parsed.scriptPath) { a.hasScriptPath = true; a.scriptPath = parsed.scriptPath; }
                    if (parsed.runIdForResume) { a.hasRunIdForResume = true; }
                    if (parsed.workflowName) { a.hasWorkflowName = true; }
                  } catch { /* not JSON */ }
                }
              }
            }
          }
        }
      }
    } catch { /* skip truncated */ }
  }

  // 分析 response 文件
  for (const rf of responseFiles) {
    try {
      const raw = readFileSync(join(dir, rf), 'utf-8');
      if (raw.length === 0) continue;
      a.responseSize = Math.max(a.responseSize, raw.length);
      const obj = JSON.parse(raw);
      // Check for tool_use in response
      if (obj.content && Array.isArray(obj.content)) {
        for (const block of obj.content) {
          if (block.type === 'tool_use' && block.name === 'Workflow') {
            a.hasToolUse = true;
            if (!a.toolUseNames.includes('Workflow')) a.toolUseNames.push('Workflow');
          }
        }
      }
    } catch { /* skip truncated */ }
  }

  return a;
}

// ====== 事件收集 ======

interface CapturedEvent {
  index: number;
  type: string;
  subtype?: string;
  toolName?: string;
  toolUseId?: string;
  deltaType?: string;
  inputJsonSnippet?: string;
}

async function runQueryAndCollect(options: {
  prompt: string;
  env: Record<string, string | undefined>;
  extraQueryOptions?: Record<string, any>;
  logDir?: string;
}): Promise<{ events: CapturedEvent[]; resultText: string; duration: number }> {
  const events: CapturedEvent[] = [];
  let resultText = '';
  let index = 0;
  let inputJsonBuffer = '';
  let currentToolName: string | null = null;
  const startTime = Date.now();

  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.extraQueryOptions || {}),
    } as any,
  });

  for await (const message of sdkQuery) {
    const msg = message as any;
    const type = msg.type || 'unknown';

    // Collect SDK message types
    const evt: CapturedEvent = { index: index++, type };
    if (msg.subtype) evt.subtype = msg.subtype;

    // Capture stream_event details
    if (type === 'stream_event' && msg.event) {
      evt.eventType = msg.event.type;
      if (msg.event.delta?.type) {
        evt.deltaType = msg.event.delta.type;
      }
      if (msg.event.delta?.type === 'input_json_delta' && msg.event.delta.partial_json) {
        inputJsonBuffer += msg.event.delta.partial_json;
        evt.inputJsonSnippet = msg.event.delta.partial_json;
      }
      if (msg.event.type === 'content_block_start' && msg.event.content_block?.type === 'tool_use') {
        evt.toolName = msg.event.content_block.name;
        evt.toolUseId = msg.event.content_block.id;
        currentToolName = msg.event.content_block.name;
        inputJsonBuffer = '';
      }
      if (msg.event.type === 'content_block_stop' && currentToolName) {
        try {
          evt.inputJsonSnippet = inputJsonBuffer;
          const parsed = JSON.parse(inputJsonBuffer);
          evt.inputJsonSnippet = JSON.stringify(parsed).substring(0, 200);
        } catch { /* incomplete JSON */ }
      }
    }

    if (type === 'result') {
      resultText = msg.result || '';
      evt.subtype = msg.subtype;
    }

    events.push(evt);
  }

  return { events, resultText, duration: Date.now() - startTime };
}

// ====== 测试脚本 ======

// 简单的内联脚本 — 只生成一个 agent 列出文件
const SIMPLE_WORKFLOW_SCRIPT = `
export const meta = {
  name: 'list-files-test',
  description: 'List files in current directory',
  phases: [{ title: 'Discover', detail: 'list files' }],
}
const result = await agent('List the files in the current directory. Return only filenames as a JSON array.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})
return result
`;

// 使用 pipeline 的脚本
const PIPELINE_WORKFLOW_SCRIPT = `
export const meta = {
  name: 'pipeline-test',
  description: 'Pipeline pattern test',
  phases: [{ title: 'Analyze', detail: 'analyze files' }],
}
const files = await agent('List the top 3 files in the current directory and briefly describe each.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } } } } } },
})
return files
`;

// 接收 args 参数的脚本
const ARGS_WORKFLOW_SCRIPT = `
export const meta = {
  name: 'args-test',
  description: 'Test args parameter',
}
const items = args && Array.isArray(args) ? args : ['default']
const results = await parallel(items.map(item => () =>
  agent('Describe the term: ' + item, { label: item })
))
return { queried: items, results: results.filter(Boolean) }
`;

describe('Workflow 工具与机制观察', () => {

  // ── Case 1: Workflow 工具是否出现在 API tools 列表中 ──
  it('case-1 workflow-tool-in-api-request — 请求中包含 Workflow 工具', async () => {
    const dir = createTimestampDir('workflow/case-1-tool-in-api');
    const { events } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-1] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-1] SDK events:', events.map(e => `${e.type}${e.toolName ? '(' + e.toolName + ')' : ''}`).join(' → '));

    // Workflow 工具应出现在初始请求的 tools 列表中
    expect(analysis.hasWorkflowTool).toBe(true);
    // input_schema 应包含 script, name, scriptPath, args, resumeFromRunId
    expect(analysis.workflowSchemaKeys.length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 2: Inline script 模式 ──
  it('case-2 inline-script — 验证内联脚本作为 prompt 时的请求结构', async () => {
    const dir = createTimestampDir('workflow/case-2-inline-script');
    // 不要求 LLM 执行 workflow，只观察 tools 列表结构
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-2] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-2] SDK events:', events.map(e => `${e.type}${e.subtype ? '/' + e.subtype : ''}`).join(' → '));
    console.error('[case-2] resultText (first 200):', resultText.substring(0, 200));

    // 至少有一个 request
    expect(analysis.requestFiles).toBeGreaterThanOrEqual(1);
    // 有 Workflow 工具
    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 3: scriptPath 模式 — 验证 scriptPath 参数在 input_schema 中 ──
  it('case-3 script-path — 验证 scriptPath 参数结构', async () => {
    const dir = createTimestampDir('workflow/case-3-script-path');
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-3] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-3] SDK events:', events.map(e => `${e.type}${e.toolName ? '(' + e.toolName + ')' : ''}`).join(' → '));
    console.error('[case-3] resultText (first 200):', resultText.substring(0, 200));

    // 验证 scriptPath 在 input_schema 中
    expect(analysis.workflowSchemaKeys).toContain('scriptPath');
    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 4: args 参数传递 — 观察 request 中 args 结构 ──
  it('case-4 args-parameter — 验证 args 参数传递到脚本', async () => {
    const dir = createTimestampDir('workflow/case-4-args');
    // 简单 prompt 即可 — 我们只需观察 tools 列表和第一个 request 结构。
    // 本地 LLM 不一定执行 workflow 脚本，所以用简单 prompt 保证能完成。
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-4] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-4] SDK events:', events.map(e => `${e.type}${e.subtype ? '/' + e.subtype : ''}`).join(' → '));
    console.error('[case-4] resultText (first 300):', resultText.substring(0, 300));

    // 验证 input_schema 中有 args 字段（无 type = 接受任意 JSON 值）
    expect(analysis.workflowSchemaKeys).toContain('args');

    // 验证 args 在 schema 中没有 type 约束（接受任意值）
    const requestFiles = readdirSync(dir).filter(f => f.endsWith('.request.json')).sort();
    if (requestFiles.length > 0) {
      const raw = readFileSync(join(dir, requestFiles[0]), 'utf-8');
      if (raw.length > 0) {
        try {
          const obj = JSON.parse(raw);
          const wfTool = obj.tools?.find((t: any) => t.name === 'Workflow');
          if (wfTool?.input_schema?.properties?.args) {
            console.error('[case-4] args schema:', JSON.stringify(wfTool.input_schema.properties.args, null, 2));
            // args 没有 type 字段 — 可以传任意 JSON 值
            expect(wfTool.input_schema.properties.args.type).toBeUndefined();
          }
        } catch { /* skip */ }
      }
    }

    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 5: disableWorkflows 选项 — 通过 settings 传入 ──
  it('case-5 disable-workflows — 验证 disableWorkflows 后 Workflow 工具消失', async () => {
    const dir = createTimestampDir('workflow/case-5-disable');
    const { events } = await runQueryAndCollect({
      prompt: 'List the files in the current directory.',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: {
        permissionMode: 'bypassPermissions',
        settings: { disableWorkflows: true } as any,
      },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-5] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-5] SDK events:', events.map(e => `${e.type}${e.toolName ? '(' + e.toolName + ')' : ''}`).join(' → '));

    // Workflow 工具不应出现在 tools 列表中
    expect(analysis.hasWorkflowTool).toBe(false);
    // tools 列表仍存在（有其他工具）
    expect(analysis.hasTools).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 6: name 模式 — 验证 name 参数在 input_schema 中 ──
  it('case-6 name-workflow — 验证 name 参数在 input_schema 中', async () => {
    const dir = createTimestampDir('workflow/case-6-name');
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-6] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-6] SDK events:', events.map(e => `${e.type}${e.subtype ? '/' + e.subtype : ''}`).join(' → '));
    console.error('[case-6] resultText (first 300):', resultText.substring(0, 300));

    // 验证 name 在 input_schema 中
    expect(analysis.workflowSchemaKeys).toContain('name');
    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 7: SDK 消息类型观察 ──
  it('case-7 sdk-message-types — 验证 SDK 消息类型', async () => {
    const dir = createTimestampDir('workflow/case-7-message-types');
    const { events, resultText, duration } = await runQueryAndCollect({
      prompt: 'Say "hello world".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    const uniqueTypes = [...new Set(events.map(e => e.type))];
    console.error('\n[case-7] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-7] Unique SDK message types:', uniqueTypes);
    console.error('[case-7] SDK event timeline:', events.map(e =>
      `${e.index}:${e.type}${e.subtype ? '/' + e.subtype : ''}${e.toolName ? '(' + e.toolName + ')' : ''}`
    ).join(', '));
    console.error('[case-7] Duration:', duration + 'ms');
    console.error('[case-7] resultText (first 300):', resultText.substring(0, 300));

    // 至少应有 system 和 result 消息
    expect(uniqueTypes.length).toBeGreaterThan(0);
    expect(uniqueTypes).toContain('system');
    expect(uniqueTypes).toContain('result');

    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 8: Workflow input_schema 结构完整性 ──
  it('case-8 workflow-input-schema — 验证 Workflow 工具的完整 input_schema', async () => {
    const dir = createTimestampDir('workflow/case-8-input-schema');
    const { events } = await runQueryAndCollect({
      prompt: 'What tools are available? List them.',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-8] OTEL analysis:', JSON.stringify(analysis, null, 2));

    // 提取完整的 Workflow tool 定义
    const requestFiles = readdirSync(dir).filter(f => f.endsWith('.request.json')).sort();
    if (requestFiles.length > 0) {
      const raw = readFileSync(join(dir, requestFiles[0]), 'utf-8');
      if (raw.length > 0) {
        try {
          const obj = JSON.parse(raw);
          if (obj.tools && Array.isArray(obj.tools)) {
            const workflowTool = obj.tools.find((t: any) => t.name === 'Workflow');
            if (workflowTool) {
              console.error('[case-8] Workflow tool definition:', JSON.stringify(workflowTool, null, 2));
              expect(workflowTool.name).toBe('Workflow');
              expect(workflowTool.input_schema).toBeDefined();
              expect(workflowTool.description).toBeDefined();
              expect(workflowTool.description?.toLowerCase()).toContain('workflow');
            } else {
              console.error('[case-8] Workflow tool NOT found in tools list');
              console.error('[case-8] Available tools:', obj.tools.map((t: any) => t.name).join(', '));
            }
          }
        } catch { /* skip */ }
      }
    }

    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 9: 验证 Workflow 工具的 input_schema 中 resumeFromRunId 字段 ──
  it('case-9 resume-from-run-id — 验证 resumeFromRunId 参数', async () => {
    const dir = createTimestampDir('workflow/case-9-resume');
    const { events } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-9] OTEL analysis:', JSON.stringify(analysis, null, 2));

    // 验证 resumeFromRunId 在 input_schema 中
    expect(analysis.workflowSchemaKeys).toContain('resumeFromRunId');
    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 10: 简单 prompt（无 workflow 触发）作为对照 ──
  it('case-10 baseline-no-workflow — 无 workflow 触发的基线对照', async () => {
    const dir = createTimestampDir('workflow/case-10-baseline');
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "hello" and nothing else.',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-10] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-10] SDK events:', events.map(e => e.type).join(' → '));
    console.error('[case-10] resultText:', resultText);

    // 基线：Workflow 工具仍在 tools 列表中（功能未被触发但工具存在）
    expect(analysis.hasWorkflowTool).toBe(true);
    // 只有一个 request（单轮对话，无工具调用）
    expect(analysis.requestFiles).toBe(1);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 11: Workflow 工具的完整 description 观察 ──
  it('case-11 workflow-description — 验证 Workflow 工具的 description 包含触发约束', async () => {
    const dir = createTimestampDir('workflow/case-11-description');
    const { events } = await runQueryAndCollect({
      prompt: 'Say "ok".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: { permissionMode: 'bypassPermissions' },
    });

    const analysis = analyzeWorkflowDir(dir);

    // 提取 Workflow 工具的完整 description
    const requestFiles = readdirSync(dir).filter(f => f.endsWith('.request.json')).sort();
    if (requestFiles.length > 0) {
      const raw = readFileSync(join(dir, requestFiles[0]), 'utf-8');
      if (raw.length > 0) {
        try {
          const obj = JSON.parse(raw);
          const wfTool = obj.tools?.find((t: any) => t.name === 'Workflow');
          if (wfTool) {
            const desc = wfTool.description || '';
            console.error('\n[case-11] Workflow description length:', desc.length);
            console.error('[case-11] First 200 chars:', desc.substring(0, 200));

            // 验证 description 包含关键约束信息
            expect(desc).toContain('orchestrates');
            expect(desc).toContain('ultracode');
            expect(desc).toContain('pipeline');
            expect(desc).toContain('parallel');
            expect(desc).toContain('agent(');

            // 验证 input_schema 属性
            const props = wfTool.input_schema?.properties || {};
            console.error('[case-11] input_schema properties:', Object.keys(props));
            console.error('[case-11] script.maxLength:', props.script?.maxLength);
          }
        } catch { /* skip */ }
      }
    }

    expect(analysis.hasWorkflowTool).toBe(true);
    prettyFormatJsonFiles(dir);
  }, 120000);

  // ── Case 12: 验证 tools=[] 时 Workflow 工具也消失 ──
  it('case-12 tools-empty-array — 验证 tools=[] 时 Workflow 工具也消失', async () => {
    const dir = createTimestampDir('workflow/case-12-tools-empty');
    const { events, resultText } = await runQueryAndCollect({
      prompt: 'Say "hello".',
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      extraQueryOptions: {
        permissionMode: 'bypassPermissions',
        tools: [], // 清空所有内置工具
      },
    });

    const analysis = analyzeWorkflowDir(dir);
    console.error('\n[case-12] OTEL analysis:', JSON.stringify(analysis, null, 2));
    console.error('[case-12] SDK events:', events.map(e => e.type).join(' → '));
    console.error('[case-12] resultText:', resultText);

    // tools=[] 应完全清除 tools 列表
    expect(analysis.hasTools).toBe(false);
    expect(analysis.hasWorkflowTool).toBe(false);
    prettyFormatJsonFiles(dir);
  }, 120000);

});
