/**
 * SDK 用户交互机制观察性测试
 *
 * 调研课题：Claude Agent SDK 中，哪些工具需要用户交互？交互方式、通知机制、预配置方法、
 * 结果提交、数据类型和 JSON Schema 是什么？
 *
 * 具体观察：
 * 1. canUseTool 回调的触发时机和参数结构
 * 2. permissionMode 对交互的影响（default vs bypassPermissions vs dontAsk）
 * 3. allowedTools 预配置跳过交互
 * 4. AskUserQuestion 的 canUseTool 交互流程
 * 5. PermissionResult 返回值类型（allow/deny/updatedInput/updatedPermissions）
 * 6. SDKControlPermissionRequest 的 control_request 消息结构
 * 7. 不同工具类型的交互触发条件
 *
 * 方法论：控制变量实验 — 改变 permissionMode / allowedTools / canUseTool 配置，
 * 观察 SDK 对 LLM 的请求/响应差异。
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ─── 环境配置 ─────────────────────────────────────────────────────────────────

const BASE_ENV = getProfileEnv('local');

// ─── 分析工具 ─────────────────────────────────────────────────────────────────

interface InteractionAnalysis {
  totalFiles: number;
  requestFiles: number;
  responseFiles: number;
  toolsCount: number;
  toolNames: string[];
  hasBashTool: boolean;
  hasWriteTool: boolean;
  hasEditTool: boolean;
  hasReadTool: boolean;
  hasAskUserQuestionTool: boolean;
  hasWebFetchTool: boolean;
  /** request 中是否出现了 tool_use */
  hasToolUse: boolean;
  /** tool_use 的工具名称列表 */
  toolUseNames: string[];
  /** 所有 tool_use 的 input */
  toolUseInputs: Array<{ name: string; input: Record<string, unknown>; id: string }>;
  /** 是否有第二轮请求（说明工具结果被发回） */
  hasSecondRequest: boolean;
  /** 第二轮请求中是否有 tool_result */
  hasToolResult: boolean;
  /** permission_denials 在 result 中 */
  resultPermissionDenials: number;
  requestSize: number;
}

function analyzeInteractionLogs(dir: string): InteractionAnalysis {
  const allFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'))
    : [];
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const analysis: InteractionAnalysis = {
    totalFiles: allFiles.length,
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    toolsCount: 0,
    toolNames: [],
    hasBashTool: false,
    hasWriteTool: false,
    hasEditTool: false,
    hasReadTool: false,
    hasAskUserQuestionTool: false,
    hasWebFetchTool: false,
    hasToolUse: false,
    toolUseNames: [],
    toolUseInputs: [],
    hasSecondRequest: false,
    hasToolResult: false,
    resultPermissionDenials: 0,
    requestSize: 0,
  };

  for (const rf of requestFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    if (rf === requestFiles[0]) {
      analysis.requestSize = content.length;
    }

    try {
      const body = JSON.parse(content);

      // 从第一个请求中提取工具列表
      if (rf === requestFiles[0] && Array.isArray(body.tools)) {
        analysis.toolsCount = body.tools.length;
        analysis.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
        analysis.hasBashTool = analysis.toolNames.includes('Bash');
        analysis.hasWriteTool = analysis.toolNames.includes('Write');
        analysis.hasEditTool = analysis.toolNames.includes('Edit');
        analysis.hasReadTool = analysis.toolNames.includes('Read');
        analysis.hasAskUserQuestionTool = analysis.toolNames.includes('AskUserQuestion');
        analysis.hasWebFetchTool = analysis.toolNames.includes('WebFetch');
      }

      // 检查是否有后续请求
      if (rf !== requestFiles[0]) {
        analysis.hasSecondRequest = true;
      }

      // 检查第二轮请求中的 tool_result
      if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_result') {
                analysis.hasToolResult = true;
              }
            }
          }
        }
      }
    } catch {
      // response 截断等
    }
  }

  // 从 response 中提取 tool_use
  for (const rf of responseFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    try {
      const body = JSON.parse(content);
      if (Array.isArray(body.content)) {
        for (const block of body.content) {
          if (block.type === 'tool_use') {
            analysis.hasToolUse = true;
            analysis.toolUseNames.push(block.name);
            analysis.toolUseInputs.push({
              name: block.name,
              input: block.input || {},
              id: block.id || '',
            });
          }
        }
      }
    } catch {
      // 截断的 response
    }
  }

  return analysis;
}

// ─── runQuery 封装 ─────────────────────────────────────────────────────────────

interface RunQueryOptions {
  env: Record<string, string | undefined>;
  prompt: string;
  tools?: string[];
  toolConfig?: Record<string, unknown>;
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: any) => Promise<any>;
  permissionMode?: string;
  allowedTools?: string[];
  allowDangerouslySkipPermissions?: boolean;
}

async function runQuery(options: RunQueryOptions): Promise<{
  resultText: string;
  allMessages: any[];
  messageTypes: Record<string, number>;
}> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.toolConfig !== undefined ? { toolConfig: options.toolConfig } : {}),
      ...(options.canUseTool !== undefined ? { canUseTool: options.canUseTool } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions } : {}),
    } as any,
  });

  let resultText = '';
  const allMessages: any[] = [];
  const messageTypes: Record<string, number> = {};

  for await (const message of sdkQuery) {
    const msg = message as any;
    const type = msg.type || 'unknown';
    messageTypes[type] = (messageTypes[type] || 0) + 1;

    // 捕获所有非流消息（只记摘要，不存全部内容）
    if (type !== 'stream_event') {
      allMessages.push({
        type,
        subtype: msg.subtype || undefined,
        // 对于 control_request，记录详细信息
        ...(type === 'control_request' ? {
          request_id: msg.request_id,
          request_subtype: msg.request?.subtype,
          request_tool_name: msg.request?.tool_name,
        } : {}),
        // 对于 system 消息
        ...(type === 'system' ? { subtype: msg.subtype } : {}),
        // 对于 result 消息
        ...(type === 'result' ? {
          subtype: msg.subtype,
          permission_denials: msg.permission_denials?.length || 0,
        } : {}),
      });
    }

    if (type === 'stream_event' && msg.event?.type === 'content_block_delta') {
      const delta = msg.event.delta;
      if (delta?.type === 'text_delta') {
        process.stderr.write(delta.text);
      }
    }

    if (type === 'result') {
      resultText = msg.result || '';
    }
  }

  return { resultText, allMessages, messageTypes };
}

// ─── canUseTool 回调记录器 ────────────────────────────────────────────────────

interface CanUseToolCall {
  toolName: string;
  input: Record<string, unknown>;
  options: any;
  timestamp: number;
}

function createCanUseToolRecorder(
  defaultBehavior: 'allow' | 'deny' = 'allow',
  specificHandlers?: Record<string, (input: Record<string, unknown>) => Record<string, unknown>>,
) {
  const calls: CanUseToolCall[] = [];

  const callback = async (toolName: string, input: Record<string, unknown>, options: any) => {
    calls.push({
      toolName,
      input: { ...input },
      options: {
        signal: options?.signal ? 'AbortSignal' : undefined,
        suggestions: options?.suggestions || undefined,
        blockedPath: options?.blockedPath || undefined,
        decisionReason: options?.decisionReason || undefined,
        title: options?.title || undefined,
        displayName: options?.displayName || undefined,
        description: options?.description || undefined,
        toolUseID: options?.toolUseID || undefined,
        agentID: options?.agentID || undefined,
      },
      timestamp: Date.now(),
    });

    console.error(`[canUseTool] toolName=${toolName}, options=`, JSON.stringify(calls[calls.length - 1].options, null, 2));

    if (specificHandlers && specificHandlers[toolName]) {
      const modifiedInput = specificHandlers[toolName](input);
      return { behavior: 'allow', updatedInput: modifiedInput };
    }

    if (defaultBehavior === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    } else {
      return { behavior: 'deny', message: `User denied ${toolName}` };
    }
  };

  return { callback, calls };
}

// ─── 测试用例 ─────────────────────────────────────────────────────────────────

describe('SDK 用户交互机制', () => {

  /**
   * Case 1: bypassPermissions 模式 — 无需交互
   * 观察：bypassPermissions 下所有工具自动批准，canUseTool 不应被调用。
   * 同时观察 SDK 消息流中是否出现 control_request 类型消息。
   */
  it('case-1 bypassPermissions 模式无需交互', async () => {
    const dir = createTimestampDir('user-interaction/case-1-bypass');
    const recorder = createCanUseToolRecorder('allow');

    const { resultText, allMessages, messageTypes } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "bypass test". Nothing else.',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool: recorder.callback,
    });

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-1] recorder.calls.length=', recorder.calls.length);
    console.error('[case-1] messageTypes:', JSON.stringify(messageTypes, null, 2));
    console.error('[case-1] allMessages:', JSON.stringify(allMessages, null, 2));
    console.error('[case-1] analysis=', JSON.stringify(analysis, null, 2));

    // bypassPermissions 模式下 canUseTool 不应被调用
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.hasBashTool).toBe(true);
    expect(analysis.hasWriteTool).toBe(true);
    expect(analysis.hasEditTool).toBe(true);
    expect(resultText.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 2: canUseTool 回调 — 观察 options 参数结构
   * 观察：当 LLM 触发需要权限的工具（Write）时，canUseTool 收到的完整 options 结构。
   * 使用 Write 工具（而非 Bash echo），因为 Write 总是需要权限确认。
   */
  it('case-2 canUseTool 回调 options 参数结构', async () => {
    const dir = createTimestampDir('user-interaction/case-2-canusetool-options');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write the text "hello from test" to the file /tmp/case2-test-output.txt',
        canUseTool: recorder.callback,
      });
      console.error('[case-2] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-2] allMessages:', JSON.stringify(allMessages, null, 2));
    } catch (e: any) {
      console.error('[case-2] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-2] recorder.calls.length=', recorder.calls.length);

    // 打印每次调用的完整结构
    for (let i = 0; i < recorder.calls.length; i++) {
      const call = recorder.calls[i];
      console.error(`\n[case-2] call[${i}]:`, JSON.stringify({
        toolName: call.toolName,
        inputKeys: Object.keys(call.input),
        options: call.options,
      }, null, 2));
    }

    expect(analysis.requestFiles).toBeGreaterThan(0);

    // 如果有 canUseTool 调用，检查 options 结构
    if (recorder.calls.length > 0) {
      const call = recorder.calls[0];
      console.error('[case-2] toolUseID:', call.options?.toolUseID);
      console.error('[case-2] title:', call.options?.title);
      console.error('[case-2] displayName:', call.options?.displayName);
      console.error('[case-2] description:', call.options?.description);
      console.error('[case-2] decisionReason:', call.options?.decisionReason);
      console.error('[case-2] suggestions:', call.options?.suggestions);
    }

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 3: canUseTool deny — 观察 deny 后 SDK 的行为
   * 观察：denied 工具后 LLM 是否收到拒绝消息，是否尝试替代方案。
   * 使用 Write 工具确保触发 canUseTool。
   */
  it('case-3 canUseTool deny 后 LLM 行为', async () => {
    const dir = createTimestampDir('user-interaction/case-3-deny');
    const recorder = createCanUseToolRecorder('deny');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write "hello" to the file /tmp/case3-test.txt',
        canUseTool: recorder.callback,
      });
      console.error('[case-3] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-3] resultText:', resultText?.substring(0, 200));
    } catch (e: any) {
      console.error('[case-3] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-3] recorder.calls.length=', recorder.calls.length);
    console.error('[case-3] analysis=', JSON.stringify(analysis, null, 2));

    for (const call of recorder.calls) {
      console.error(`[case-3] toolName=${call.toolName}`);
    }

    expect(analysis.requestFiles).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 4: allowedTools 预配置 — 跳过交互
   * 观察：allowedTools=['Write'] 后 Write 工具不再触发 canUseTool
   */
  it('case-4 allowedTools 预配置跳过交互', async () => {
    const dir = createTimestampDir('user-interaction/case-4-allowed-tools');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write "allowed tools test" to /tmp/case4-test.txt',
        allowedTools: ['Write'],
        canUseTool: recorder.callback,
      });
      console.error('[case-4] messageTypes:', JSON.stringify(messageTypes, null, 2));
    } catch (e: any) {
      console.error('[case-4] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-4] recorder.calls.length=', recorder.calls.length);
    console.error('[case-4] analysis=', JSON.stringify(analysis, null, 2));

    for (const call of recorder.calls) {
      console.error(`[case-4] toolName=${call.toolName}`);
    }

    expect(analysis.requestFiles).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 5: dontAsk 模式 — 非预批准工具被自动拒绝
   * 观察：dontAsk + allowedTools 之外的调用被拒，不会触发 canUseTool。
   * 使用 Write 工具确保需要权限。
   */
  it('case-5 dontAsk 模式自动拒绝', async () => {
    const dir = createTimestampDir('user-interaction/case-5-dontask');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write "dontask test" to the file /tmp/case5-test.txt',
        permissionMode: 'dontAsk',
        canUseTool: recorder.callback,
      });
      console.error('[case-5] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-5] allMessages:', JSON.stringify(allMessages, null, 2));
      console.error('[case-5] resultText:', resultText?.substring(0, 300));
    } catch (e: any) {
      console.error('[case-5] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-5] recorder.calls.length=', recorder.calls.length);
    console.error('[case-5] analysis=', JSON.stringify(analysis, null, 2));

    // dontAsk 模式下 canUseTool 不应被调用
    expect(recorder.calls.length).toBe(0);
    expect(analysis.requestFiles).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 6: AskUserQuestion + canUseTool 完整交互流程
   * 观察：AskUserQuestion 的 input 结构、canUseTool 的 options、
   * 返回 allow + updatedInput 的格式
   */
  it('case-6 AskUserQuestion 交互流程', async () => {
    const dir = createTimestampDir('user-interaction/case-6-ask-user');
    const recorder = createCanUseToolRecorder('allow', {
      AskUserQuestion: (input) => {
        const questions = (input as any).questions || [];
        const answers: Record<string, string> = {};
        for (const q of questions) {
          if (q.options && q.options.length > 0) {
            answers[q.question] = q.options[0].label;
          }
        }
        console.error('[case-6] AskUserQuestion answers:', JSON.stringify(answers));
        return { questions, answers } as any;
      },
    });

    let resultText = '';
    let allMessages6: any[] = [];
    let messageTypes6: Record<string, number> = {};
    try {
      ({ resultText, allMessages: allMessages6, messageTypes: messageTypes6 } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Use the AskUserQuestion tool to ask me which language I prefer: TypeScript or JavaScript. Then tell me my choice.',
        canUseTool: recorder.callback,
      }));
      console.error('[case-6] messageTypes:', JSON.stringify(messageTypes6, null, 2));
      console.error('[case-6] allMessages:', JSON.stringify(allMessages6, null, 2));
    } catch (e: any) {
      console.error('[case-6] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-6] recorder.calls.length=', recorder.calls.length);
    console.error('[case-6] analysis=', JSON.stringify(analysis, null, 2));

    for (let i = 0; i < recorder.calls.length; i++) {
      const call = recorder.calls[i];
      console.error(`\n[case-6] call[${i}]: toolName=${call.toolName}`);
      console.error(`[case-6] call[${i}] input:`, JSON.stringify(call.input, null, 2));
      console.error(`[case-6] call[${i}] options:`, JSON.stringify(call.options, null, 2));
    }

    expect(analysis.requestFiles).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 240000);

  /**
   * Case 7: PermissionResult.updatedPermissions — 观察 suggestions 结构
   * 观察：canUseTool options 中是否包含 suggestions 字段。
   * 使用 Write 触发 canUseTool。
   */
  it('case-7 canUseTool suggestions 结构', async () => {
    const dir = createTimestampDir('user-interaction/case-7-suggestions');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write "suggestions test" to /tmp/case7-test.txt',
        canUseTool: recorder.callback,
      });
      console.error('[case-7] messageTypes:', JSON.stringify(messageTypes, null, 2));
    } catch (e: any) {
      console.error('[case-7] error:', e.message);
    }

    console.error('\n[case-7] recorder.calls.length=', recorder.calls.length);

    // 详细打印每个 call 的 suggestions
    for (let i = 0; i < recorder.calls.length; i++) {
      const call = recorder.calls[i];
      console.error(`\n[case-7] call[${i}] toolName=${call.toolName}`);
      console.error(`[case-7] call[${i}] suggestions:`, JSON.stringify(call.options?.suggestions, null, 2));
      console.error(`[case-7] call[${i}] decisionReason:`, call.options?.decisionReason);
      console.error(`[case-7] call[${i}] blockedPath:`, call.options?.blockedPath);
    }

    expect(true).toBe(true); // 观察性测试，不做强制断言

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 8: 工具权限类型总结 — 观察哪些工具触发 canUseTool
   * 观察：Read（不应触发）vs Write（应触发）vs Bash（取决于命令）的差异
   */
  it('case-8 工具权限类型总结', async () => {
    const dir = createTimestampDir('user-interaction/case-8-tool-types');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'First read the file ./package.json, then run echo "test", then write "hello" to a file called /tmp/case8-test-output.txt. Do all three actions.',
        canUseTool: recorder.callback,
      });
      console.error('[case-8] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-8] allMessages:', JSON.stringify(allMessages, null, 2));
    } catch (e: any) {
      console.error('[case-8] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-8] recorder.calls.length=', recorder.calls.length);
    console.error('[case-8] analysis=', JSON.stringify(analysis, null, 2));

    // 总结哪些工具触发了 canUseTool
    const triggeredTools = recorder.calls.map(c => c.toolName);
    const uniqueTriggeredTools = [...new Set(triggeredTools)];
    console.error('\n[case-8] 触发 canUseTool 的工具:', uniqueTriggeredTools);
    console.error('[case-8] 未触发 canUseTool 的工具:',
      analysis.toolNames.filter(t => !uniqueTriggeredTools.includes(t)));

    // Read 不应触发 canUseTool（默认允许）
    expect(triggeredTools).not.toContain('Read');
    // Grep/Glob 也不应触发
    expect(triggeredTools).not.toContain('Grep');
    expect(triggeredTools).not.toContain('Glob');

    prettyFormatJsonFiles(dir);
  }, 240000);

  /**
   * Case 9: default 模式下 Read 的权限行为
   * 观察：Read 在 default 模式下是否需要权限
   */
  it('case-9 Read 工具在 default 模式下不需权限', async () => {
    const dir = createTimestampDir('user-interaction/case-9-read-default');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Read the file ./package.json and tell me the package name.',
        canUseTool: recorder.callback,
      });
      console.error('[case-9] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-9] allMessages:', JSON.stringify(allMessages, null, 2));
    } catch (e: any) {
      console.error('[case-9] error:', e.message);
    }

    const analysis = analyzeInteractionLogs(dir);
    console.error('\n[case-9] recorder.calls.length=', recorder.calls.length);
    console.error('[case-9] analysis=', JSON.stringify(analysis, null, 2));

    // Read 应该自动批准，不触发 canUseTool
    const readCalls = recorder.calls.filter(c => c.toolName === 'Read');
    console.error('[case-9] Read canUseTool calls:', readCalls.length);

    expect(readCalls.length).toBe(0);
    expect(analysis.requestFiles).toBeGreaterThan(0);

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 10: Write 工具触发 canUseTool 并观察 input 参数
   * 观察：Write 的 input 中包含哪些字段（file_path, content）
   */
  it('case-10 Write 工具 input 参数结构', async () => {
    const dir = createTimestampDir('user-interaction/case-10-write-input');
    const recorder = createCanUseToolRecorder('allow');

    try {
      const { resultText, allMessages, messageTypes } = await runQuery({
        env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
        prompt: 'Write "test content" to the file /tmp/case10-test-write.txt',
        canUseTool: recorder.callback,
      });
      console.error('[case-10] messageTypes:', JSON.stringify(messageTypes, null, 2));
      console.error('[case-10] allMessages:', JSON.stringify(allMessages, null, 2));
    } catch (e: any) {
      console.error('[case-10] error:', e.message);
    }

    console.error('\n[case-10] recorder.calls.length=', recorder.calls.length);

    const writeCalls = recorder.calls.filter(c => c.toolName === 'Write');
    for (let i = 0; i < writeCalls.length; i++) {
      const call = writeCalls[i];
      console.error(`\n[case-10] Write call[${i}] input keys:`, Object.keys(call.input));
      console.error(`[case-10] Write call[${i}] input:`, JSON.stringify(call.input, null, 2));
      console.error(`[case-10] Write call[${i}] options:`, JSON.stringify(call.options, null, 2));
    }

    expect(true).toBe(true); // 观察性测试

    prettyFormatJsonFiles(dir);
  }, 180000);
});
