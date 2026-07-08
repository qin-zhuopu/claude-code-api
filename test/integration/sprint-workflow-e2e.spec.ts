/**
 * Sprint 工作流端到端测试
 *
 * 验证完整的 sprint-serial 工作流在 Jereh Proxy LLM 下的实际运行：
 * - Workflow 工具被调用
 * - 内部 Agent 工具按预期串行执行（dev → test 交替）
 * - 每个 API 请求都有正确的时间戳和模型信息
 * - OTEL 日志记录了完整的 request/response 链路
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { loadEnvGroupWithDefaults } from './env-groups';

dotenv.config();

// ====== 工作流脚本 ======
const SPRINT_SCRIPT_PATH = resolve(__dirname, 'workflows', 'sprint-serial.js');

// ====== Sprint 任务定义（简单任务用于快速验证） ======
const SPRINT_TASKS = [
  {
    name: 'math-add',
    devPrompt: 'Create a file at test/output/math-add.js that exports a function add(a, b) returning a + b.',
    testCmd: 'node -e "const m = require(\'./test/output/math-add.js\'); console.log(m.add(2, 3) === 5 ? \'PASS\' : \'FAIL\')"',
  },
  {
    name: 'math-mul',
    devPrompt: 'Create a file at test/output/math-mul.js that exports a function mul(a, b) returning a * b.',
    testCmd: 'node -e "const m = require(\'./test/output/math-mul.js\'); console.log(m.mul(3, 4) === 12 ? \'PASS\' : \'FAIL\')"',
  },
];

// ====== OTEL 日志分析 ======

interface ApiCallRecord {
  file: string;
  timestamp: string;
  model: string;
  tools: string[];
  hasWorkflowTool: boolean;
  hasAgentTool: boolean;
  hasBashTool: boolean;
  hasReadTool: boolean;
  requestSize: number;
  responseSize: number;
}

function analyzeOtelDir(dir: string): { apiCalls: ApiCallRecord[]; allTools: Set<string> } {
  const apiCalls: ApiCallRecord[] = [];
  const allTools = new Set<string>();

  const requestFiles = readdirSync(dir)
    .filter(f => f.endsWith('.request.json'))
    .sort();

  for (const rf of requestFiles) {
    try {
      const raw = readFileSync(join(dir, rf), 'utf-8');
      if (raw.length === 0) continue;
      const obj = JSON.parse(raw);

      // 从文件名或内容提取时间戳
      const fileTimeMatch = rf.match(/(\d{4}-\d{2}-\d{2}T\d{2}[:.]\d{2}[:.]\d{2})/);
      const timestamp = fileTimeMatch?.[0].replace(/[.]/g, ':') || 'unknown';

      const tools = (obj.tools || []).map((t: any) => t.name || '');
      const model = obj.model || 'unknown';

      const hasWorkflowTool = tools.includes('Workflow');
      const hasAgentTool = tools.includes('Agent');
      const hasBashTool = tools.includes('Bash');
      const hasReadTool = tools.includes('Read');

      tools.forEach((t: string) => t && allTools.add(t));

      // 找对应的 response 文件
      const respFile = rf.replace('.request.json', '.response.json');
      let responseSize = 0;
      try {
        const respRaw = readFileSync(join(dir, respFile), 'utf-8');
        responseSize = respRaw.length;
      } catch { /* no response file */ }

      apiCalls.push({
        file: rf,
        timestamp,
        model,
        tools,
        hasWorkflowTool,
        hasAgentTool,
        hasBashTool,
        hasReadTool,
        requestSize: raw.length,
        responseSize,
      });
    } catch { /* skip */ }
  }

  return { apiCalls, allTools };
}

// ====== 确保输出目录存在 ======
import { mkdirSync, existsSync } from 'fs';
const OUTPUT_DIR = resolve(process.cwd(), 'test', 'output');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

describe('Sprint Workflow E2E (Jereh Proxy)', () => {

  it('case-1 sprint-serial — 完整运行 sprint 工作流并断言 OTEL 日志（前台）', async () => {
    const dir = createTimestampDir('workflow/sprint-e2e');
    const env = loadEnvGroupWithDefaults('jereh');

    console.error('\n🚀 Starting sprint-serial workflow (FOREGROUND)...');
    console.error(`   Tasks: ${SPRINT_TASKS.map(t => t.name).join(', ')}`);
    console.error(`   OTEL log dir: ${dir}`);

    const sdkQuery = query({
      prompt: `You must execute this workflow SYNCHRONOUSLY in the foreground. Do NOT launch it as a background task. Wait for it to complete and return the results.

Run the workflow script at ${SPRINT_SCRIPT_PATH} with these task parameters:
${JSON.stringify({ tasks: SPRINT_TASKS, maxRetries: 2 }, null, 2)}`,
      options: {
        env: {
          ...env,
          OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        },
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        effort: 'low',
        permissionMode: 'bypassPermissions',
      } as any,
    });

    const queryStart = Date.now();

    // 收集所有 SDK 消息
    const messages: any[] = [];
    const taskEvents: any[] = [];
    let queryReturnedAt = 0;

    for await (const message of sdkQuery) {
      const msg = message as any;
      messages.push({ type: msg.type, subtype: msg.subtype, task_id: msg.task_id });

      // 收集 task 事件
      if (msg.subtype?.startsWith('task_')) {
        taskEvents.push({
          subtype: msg.subtype,
          task_id: msg.task_id,
          description: msg.description,
          status: msg.status,
          workflow_name: msg.workflow_name,
        });
      }

      // 实时打印
      if (msg.type === 'text' || msg.type === 'partial') {
        try {
          const content = JSON.parse(msg.content);
          if (content.type === 'assistant') {
            for (const item of content.message?.content || []) {
              if (item.type === 'text' && item.text) {
                process.stderr.write(item.text.substring(0, 200) + '...\n');
              }
            }
          }
        } catch { /* not JSON */ }
      }

      // 记录 result 消息到达时间
      if (msg.type === 'result') {
        queryReturnedAt = Date.now();
      }
    }

    const queryDuration = queryReturnedAt ? (queryReturnedAt - queryStart) : (Date.now() - queryStart);
    console.error(`\n\n📊 Sprint workflow completed (FOREGROUND).`);
    console.error(`   Total SDK messages: ${messages.length}`);
    console.error(`   Task events: ${taskEvents.length}`);
    console.error(`   for await duration: ${queryDuration}ms`);

    // ====== 断言 1: SDK 消息中应有 task_started（workflow 启动了） ======
    const taskStartedEvents = taskEvents.filter(e => e.subtype === 'task_started');
    console.error(`\n   Task started events: ${taskStartedEvents.length}`);
    if (taskStartedEvents.length > 0) {
      console.error(`   Workflow names: ${taskStartedEvents.map(e => e.workflow_name).filter(Boolean).join(', ')}`);
    }
    expect(taskStartedEvents.length).toBeGreaterThanOrEqual(1);

    // ====== 断言 2: OTEL 日志分析 ======
    const { apiCalls, allTools } = analyzeOtelDir(dir);
    console.error(`\n   Total API calls recorded in OTEL: ${apiCalls.length}`);
    console.error(`   Unique tools seen: ${[...allTools].join(', ')}`);

    expect(apiCalls.length).toBeGreaterThan(0);

    // ====== 断言 3: 至少一个请求包含 Workflow 工具 ======
    const callsWithWorkflow = apiCalls.filter(c => c.hasWorkflowTool);
    console.error(`\n   API calls with Workflow tool: ${callsWithWorkflow.length}`);
    expect(callsWithWorkflow.length).toBeGreaterThan(0);

    // ====== 断言 4: 所有 API 调用都使用了配置的模型 ======
    for (const call of apiCalls) {
      expect(call.model).toMatch(/qwen3\.6/i);
    }

    // ====== 断言 5: Agent 工具出现在至少一个请求中（workflow 内部调用了 agent） ======
    const callsWithAgent = apiCalls.filter(c => c.hasAgentTool);
    console.error(`\n   API calls with Agent tool: ${callsWithAgent.length}`);
    expect(callsWithAgent.length).toBeGreaterThan(0);

    // ====== 断言 6: 每个请求都有合理的大小 ======
    for (const call of apiCalls) {
      expect(call.requestSize).toBeGreaterThan(100);
    }

    // ====== 断言 7: SDK task events 中包含 workflow 的 task_started ======
    const workflowTasks = taskEvents.filter(e => e.workflow_name === 'sprint-serial');
    console.error(`\n   Workflow task events: ${workflowTasks.length}`);
    expect(workflowTasks.length).toBeGreaterThan(0);

    // ====== 打印详细时间线 ======
    console.error('\n\n📋 OTEL API Call Timeline:');
    console.error('─'.repeat(80));
    for (const call of apiCalls) {
      const toolSummary = [
        call.hasWorkflowTool ? '🔧Workflow' : '',
        call.hasAgentTool ? '🤖Agent' : '',
        call.hasBashTool ? '💻Bash' : '',
        call.hasReadTool ? '📖Read' : '',
      ].filter(Boolean).join(' ');
      console.error(`  ${call.timestamp} | ${call.model.padEnd(20)} | ${call.tools.length.toString().padStart(3)} tools | ${toolSummary}`);
    }
    console.error('─'.repeat(80));

    // 保存 pretty 日志
    prettyFormatJsonFiles(dir);
  }, 300000);

  // ── Case 2: Background workflow ──
  it('case-2 sprint-serial — 后台运行 sprint 工作流并断言 OTEL 日志', async () => {
    const dir = createTimestampDir('workflow/sprint-e2e-bg');
    const env = loadEnvGroupWithDefaults('jereh');

    console.error('\n🚀 Starting sprint-serial workflow (BACKGROUND)...');
    console.error(`   Tasks: ${SPRINT_TASKS.map(t => t.name).join(', ')}`);
    console.error(`   OTEL log dir: ${dir}`);

    const sdkQuery = query({
      prompt: `Launch this workflow in the background and let it run. I'll check the results later. Do NOT wait for it to complete.

Run the workflow script at ${SPRINT_SCRIPT_PATH} with these task parameters:
${JSON.stringify({ tasks: SPRINT_TASKS, maxRetries: 2 }, null, 2)}`,
      options: {
        env: {
          ...env,
          OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        },
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        effort: 'low',
        permissionMode: 'bypassPermissions',
      } as any,
    });

    const messages: any[] = [];
    const taskEvents: any[] = [];
    const queryStart = Date.now();
    let queryReturnedAt = 0;
    let taskNotifReceived = false;

    for await (const message of sdkQuery) {
      const msg = message as any;
      messages.push({ type: msg.type, subtype: msg.subtype, task_id: msg.task_id });

      if (msg.subtype?.startsWith('task_')) {
        taskEvents.push({
          subtype: msg.subtype,
          task_id: msg.task_id,
          description: msg.description,
          status: msg.status,
          workflow_name: msg.workflow_name,
          summary: msg.summary,
          output_file: msg.output_file,
        });
      }

      if (msg.subtype === 'task_notification') {
        taskNotifReceived = true;
        console.error(`\n   📬 task_notification received: status=${msg.status}, summary=${msg.summary?.substring(0, 100)}`);
        console.error(`      output_file: ${msg.output_file}`);
      }

      if (msg.type === 'result') {
        queryReturnedAt = Date.now();
      }
    }

    const queryDuration = queryReturnedAt ? (queryReturnedAt - queryStart) : (Date.now() - queryStart);
    console.error(`\n\n📊 Background workflow completed.`);
    console.error(`   Total SDK messages: ${messages.length}`);
    console.error(`   Task events: ${taskEvents.length}`);
    console.error(`   for await duration: ${queryDuration}ms`);
    console.error(`   Task notification received: ${taskNotifReceived}`);

    // ====== 断言 0: 后台模式的核心特征 ======
    // 注意: SDK query() 总是等待整个 turn 完成（包括后台任务），所以 for await 持续时间
    // 不能区分前台/后台。真正的区别在于：
    // - 前台: result 消息包含 workflow 的最终结果
    // - 后台: result 消息是 "workflow 已在后台启动"，实际结果在 task_notification 的 output_file 中
    expect(taskNotifReceived).toBe(true);
    console.error(`   ✅ task_notification received confirms background task mode`);

    // ====== 断言 1: task_started 事件 ======
    const taskStartedEvents = taskEvents.filter(e => e.subtype === 'task_started');
    expect(taskStartedEvents.length).toBeGreaterThanOrEqual(1);

    // ====== 断言 2: OTEL 日志分析 ======
    const { apiCalls, allTools } = analyzeOtelDir(dir);
    console.error(`\n   Total API calls recorded in OTEL: ${apiCalls.length}`);
    console.error(`   Unique tools seen: ${[...allTools].join(', ')}`);
    expect(apiCalls.length).toBeGreaterThan(0);

    // ====== 断言 3: 至少一个请求包含 Workflow 工具 ======
    const callsWithWorkflow = apiCalls.filter(c => c.hasWorkflowTool);
    expect(callsWithWorkflow.length).toBeGreaterThan(0);

    // ====== 断言 4: 所有 API 调用都使用了配置的模型 ======
    for (const call of apiCalls) {
      expect(call.model).toMatch(/qwen3\.6/i);
    }

    // ====== 打印详细时间线 ======
    console.error('\n\n📋 OTEL API Call Timeline (Background):');
    console.error('─'.repeat(80));
    for (const call of apiCalls) {
      const toolSummary = [
        call.hasWorkflowTool ? '🔧Workflow' : '',
        call.hasAgentTool ? '🤖Agent' : '',
        call.hasBashTool ? '💻Bash' : '',
        call.hasReadTool ? '📖Read' : '',
      ].filter(Boolean).join(' ');
      console.error(`  ${call.timestamp} | ${call.model.padEnd(20)} | ${call.tools.length.toString().padStart(3)} tools | ${toolSummary}`);
    }
    console.error('─'.repeat(80));

    prettyFormatJsonFiles(dir);
  }, 300000);

});
