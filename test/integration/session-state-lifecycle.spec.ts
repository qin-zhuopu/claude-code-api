/**
 * Workflow 生命周期消息观测测试
 *
 * 核心发现：
 * 1. session_state_changed 在 Transport.readMessages() 的 StdoutMessage 中出现
 * 2. 但 query() 的 for-await 过滤了它 — 不 yield 给消费者
 * 3. 它也不被持久化到 session journal 中
 * 4. 所以 Web UI 无法通过 SDK 直接拿到 session_state_changed
 *
 * 替代方案：
 * - 用 task_started / task_notification 判断 workflow 生命周期
 * - 用 task_progress 获取实时进度
 * - 用 task_notification.output_file 读取 workflow 返回的结构化结果
 * - BackgroundTaskSummary 类型在 SDK 类型定义中存在，但 SDK 未暴露获取它的 API
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import { loadEnvGroupWithDefaults } from './env-groups';

dotenv.config();

const SPRINT_SCRIPT_PATH = resolve(__dirname, 'workflows', 'sprint-serial.js');

const SPRINT_TASKS = [
  {
    name: 'math-add',
    devPrompt: 'Create a file at test/output/math-add.js that exports add(a, b) returning a + b.',
    testCmd: 'node -e "const m = require(\'./test/output/math-add.js\'); console.log(m.add(2, 3) === 5 ? \'PASS\' : \'FAIL\')"',
  },
  {
    name: 'math-mul',
    devPrompt: 'Create a file at test/output/math-mul.js that exports mul(a, b) returning a * b.',
    testCmd: 'node -e "const m = require(\'./test/output/math-mul.js\'); console.log(m.mul(3, 4) === 12 ? \'PASS\' : \'FAIL\')"',
  },
];

const OUTPUT_DIR = resolve(process.cwd(), 'test', 'output');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

describe('Workflow 生命周期消息观测', () => {

  it('case-1 query-yield — 验证 query() for-await 能拿到哪些消息', async () => {
    const dir = createTimestampDir('workflow/lifecycle');
    const env = loadEnvGroupWithDefaults('jereh');

    console.error('\n🔬 Testing query() for-await message yield...');

    const sdkQuery = query({
      prompt: `Run the workflow at ${SPRINT_SCRIPT_PATH} with:
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

    const allMessages: any[] = [];
    const taskEvents: any[] = [];
    let totalMessageCount = 0;
    let sessionId = '';

    for await (const message of sdkQuery) {
      const msg = message as any;
      totalMessageCount++;
      if (!sessionId && msg.session_id) sessionId = msg.session_id;
      allMessages.push({ type: msg.type, subtype: msg.subtype });

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
    }

    // ====== 消息类型统计 ======
    const typeCounts: Record<string, number> = {};
    for (const m of allMessages) {
      const key = `${m.type}${m.subtype ? '/' + m.subtype : ''}`;
      typeCounts[key] = (typeCounts[key] || 0) + 1;
    }

    console.error(`\n  Session ID: ${sessionId}`);
    console.error(`  Total messages via query(): ${totalMessageCount}`);
    console.error(`\n  Message types distribution:`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.error(`    ${type}: ${count}`);
    }

    // ====== session_state_changed 确认不在 query() yield 中 ======
    const hasSessionState = allMessages.some(m => m.subtype === 'session_state_changed');
    console.error(`\n  session_state_changed in query(): ${hasSessionState}`);
    expect(hasSessionState).toBe(false);

    // ====== task 事件分析 ======
    const taskStarted = taskEvents.filter(e => e.subtype === 'task_started');
    const taskProgress = taskEvents.filter(e => e.subtype === 'task_progress');
    const taskNotif = taskEvents.filter(e => e.subtype === 'task_notification');

    console.error(`\n  task_started:       ${taskStarted.length}`);
    console.error(`  task_progress:      ${taskProgress.length}`);
    console.error(`  task_notification:  ${taskNotif.length}`);

    // ====== task_notification 的结构化信息 ======
    console.error(`\n  task_notification structured data:`);
    for (const n of taskNotif) {
      console.error(`    task_id:    ${n.task_id}`);
      console.error(`    status:     ${n.status}`);
      console.error(`    summary:    ${n.summary?.substring(0, 200)}`);
      console.error(`    output_file: ${n.output_file}`);

      // 读取 output_file 获取 workflow 返回的结构化 JSON
      if (n.output_file && existsSync(n.output_file)) {
        try {
          const raw = readFileSync(n.output_file, 'utf-8');
          const result = JSON.parse(raw);
          console.error(`    result:     ${JSON.stringify(result).substring(0, 500)}`);
        } catch { /* not JSON */ }
      }
    }

    // ====== 断言 ======
    expect(taskStarted.length).toBeGreaterThan(0);
    expect(taskNotif.length).toBeGreaterThan(0);
    expect(allMessages.some(m => m.type === 'result')).toBe(true);
    expect(allMessages.some(m => m.type === 'system')).toBe(true);

    prettyFormatJsonFiles(dir);
  }, 300000);

  // ====== Case 2: 后台任务信息分析 ======
  it('case-2 background-task-info — 验证能从 task_notification 获取哪些结构化信息', async () => {
    const dir = createTimestampDir('workflow/bg-task-info');
    const env = loadEnvGroupWithDefaults('jereh');

    console.error('\n📋 Testing background task structured information...');

    const sdkQuery = query({
      prompt: `Run the workflow at ${SPRINT_SCRIPT_PATH} with:
${JSON.stringify({ tasks: SPRINT_TASKS.slice(0, 1), maxRetries: 1 }, null, 2)}`,
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

    const taskNotifReceived: any[] = [];
    const taskProgressReceived: any[] = [];

    for await (const message of sdkQuery) {
      const msg = message as any;
      if (msg.subtype === 'task_notification') {
        taskNotifReceived.push(msg);
      }
      if (msg.subtype === 'task_progress') {
        taskProgressReceived.push(msg);
      }
    }

    console.error(`\n  task_notification received: ${taskNotifReceived.length}`);
    console.error(`  task_progress received:       ${taskProgressReceived.length}`);

    // task_progress 的结构
    if (taskProgressReceived.length > 0) {
      const sample = taskProgressReceived[0];
      console.error(`\n  task_progress sample fields:`);
      console.error(`    task_id:        ${sample.task_id}`);
      console.error(`    description:    ${sample.description?.substring(0, 100)}`);
      console.error(`    subagent_type:  ${sample.subagent_type}`);
      console.error(`    last_tool_name: ${sample.last_tool_name}`);
      console.error(`    summary:        ${sample.summary?.substring(0, 100)}`);
      console.error(`    usage.total_tokens:   ${sample.usage?.total_tokens}`);
      console.error(`    usage.tool_uses:      ${sample.usage?.tool_uses}`);
      console.error(`    usage.duration_ms:    ${sample.usage?.duration_ms}`);
    }

    // task_notification 的结构
    if (taskNotifReceived.length > 0) {
      const sample = taskNotifReceived[0];
      console.error(`\n  task_notification sample fields:`);
      console.error(`    task_id:     ${sample.task_id}`);
      console.error(`    tool_use_id: ${sample.tool_use_id}`);
      console.error(`    status:      ${sample.status}`);
      console.error(`    output_file: ${sample.output_file}`);
      console.error(`    summary:     ${sample.summary?.substring(0, 200)}`);
      console.error(`    usage.total_tokens:   ${sample.usage?.total_tokens}`);
      console.error(`    usage.tool_uses:      ${sample.usage?.tool_uses}`);
      console.error(`    usage.duration_ms:    ${sample.usage?.duration_ms}`);
    }

    // ====== 断言 ======
    expect(taskNotifReceived.length).toBeGreaterThan(0);
    expect(taskProgressReceived.length).toBeGreaterThan(0);

    // 验证 task_progress 有结构化字段
    if (taskProgressReceived.length > 0) {
      const sample = taskProgressReceived[taskProgressReceived.length - 1]; // 用最后一个（有累计数据）
      expect(sample.task_id).toBeTruthy();
      expect(sample.usage).toBeDefined();
      expect(sample.usage.duration_ms).toBeGreaterThanOrEqual(0);
    }

    // 验证 task_notification 有 output_file
    if (taskNotifReceived.length > 0) {
      const sample = taskNotifReceived[0];
      expect(sample.task_id).toBeTruthy();
      expect(sample.output_file).toBeTruthy();
      expect(sample.status).toBeTruthy();
      expect(sample.usage).toBeDefined();
    }

    prettyFormatJsonFiles(dir);
  }, 300000);

});
