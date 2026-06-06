/**
 * SDK Custom Tool 观察性测试
 *
 * 观察目标：
 * 1. tool() + createSdkMcpServer() 注册自定义 tool 后，API 请求中的 tools 列表是否包含自定义 tool
 * 2. 自定义 tool 的 input_schema 在请求中的完整结构
 * 3. tool name 格式：mcp__{serverName}__{toolName}
 * 4. LLM 调用自定义 tool 时，tool_result 如何在日志中体现
 * 5. annotations 是否反映在请求中
 * 6. tools: []（禁用内置工具）+ 自定义 tool 的组合
 *
 * 实验矩阵：
 * | case | 自定义 tool | tools 选项     | prompt            | 观察重点                    |
 * |------|-----------|---------------|-------------------|----------------------------|
 * | 1    | 无         | 默认           | say hi            | 基线：tools 列表             |
 * | 2    | 有         | 默认           | 调用自定义 tool     | tools 列表包含自定义 tool     |
 * | 3    | 有         | []            | 调用自定义 tool     | 只有自定义 tool，无内置       |
 * | 4    | 有(annotations)| 默认       | 调用自定义 tool     | annotations 是否反映        |
 * | 5    | 有         | 默认           | 不需要 tool 的 prompt | 自定义 tool 仍在列表中       |
 */
import { describe, it, expect } from 'vitest';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import dotenv from 'dotenv';
import { getProfileEnv } from '../llm-profiles';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

const BASE_ENV = getProfileEnv('local');

// ============================================================
// 自定义 tool 定义
// ============================================================

/**
 * 简单的回显 tool — 返回输入的文本
 */
const echoTool = tool(
  'echo',
  'Echo back the input text. Use this tool when asked to echo or repeat something.',
  {
    text: z.string().describe('The text to echo back'),
  },
  async (args) => {
    return {
      content: [{ type: 'text' as const, text: `Echo: ${args.text}` }],
    };
  },
);

/**
 * 带 annotations 的 tool
 */
const readOnlyTool = tool(
  'get_timestamp',
  'Get the current timestamp in ISO format.',
  {},
  async () => {
    return {
      content: [{ type: 'text' as const, text: new Date().toISOString() }],
    };
  },
  { annotations: { readOnlyHint: true, destructiveHint: false } },
);

// 包装成 MCP server
const echoServer = createSdkMcpServer({
  name: 'test-echo',
  version: '1.0.0',
  tools: [echoTool],
});

const readOnlyServer = createSdkMcpServer({
  name: 'test-ro',
  version: '1.0.0',
  tools: [readOnlyTool],
});

// ============================================================
// 工具函数
// ============================================================

async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  mcpServers?: Record<string, any>;
  tools?: any;
  allowedTools?: string[];
  permissionMode?: string;
}) {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode as any } : {}),
    } as any,
  });

  const events: any[] = [];
  let resultText = '';
  let resultObj: any = null;
  let thrownError: Error | null = null;

  try {
    for await (const message of sdkQuery) {
      const msg = message as any;
      events.push(msg);

      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        const delta = msg.event.delta;
        if (delta?.type === 'text_delta') process.stderr.write(delta.text);
      }

      if (msg.type === 'result') {
        resultText = msg.result || '';
        resultObj = msg;
      }
    }
  } catch (err) {
    thrownError = err instanceof Error ? err : new Error(String(err));
  }

  return { events, resultText, resultObj, thrownError };
}

function analyzeRequestDir(dir: string) {
  if (!existsSync(dir)) return { hasFiles: false, requests: [] as any[] };

  const allFiles = readdirSync(dir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));

  const requests: any[] = [];
  for (const f of requestFiles.sort()) {
    try {
      requests.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch { /* skip truncated */ }
  }

  const firstRequest = requests[0] || null;
  const tools: any[] = firstRequest?.tools || [];

  return {
    hasFiles: true,
    requestCount: requestFiles.length,
    requests,
    firstRequest,
    tools,
    toolsCount: tools.length,
    toolNames: tools.map((t: any) => t.name),
    // 查找自定义 tool
    findTool: (name: string) => tools.find((t: any) => t.name === name) || null,
    systemBlocks: firstRequest?.system || null,
    systemBlocksCount: Array.isArray(firstRequest?.system) ? firstRequest.system.length : 0,
  };
}

// ============================================================
// 测试
// ============================================================

describe('SDK Custom Tool 观察性测试', () => {

  it('case-1 基线：无自定义 tool，默认 tools 列表', async () => {
    const dir = createTimestampDir('sdk-custom-tool/case-1-baseline');

    const { thrownError, resultText } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "baseline-ok"',
    });

    const a = analyzeRequestDir(dir);

    console.error('\n[case-1] 基线（无自定义 tool）');
    console.error('  request files:', a.requestCount);
    console.error('  tools count:', a.toolsCount);
    console.error('  tool names:', a.toolNames.join(', '));
    console.error('  has mcp__test-echo__echo:', a.toolNames.includes('mcp__test-echo__echo'));

    expect(thrownError).toBeNull();
    expect(a.requestCount).toBeGreaterThanOrEqual(1);
    expect(a.toolsCount).toBeGreaterThan(0);
    // 基线不应包含自定义 tool
    expect(a.toolNames).not.toContain('mcp__test-echo__echo');
    // 保存基线 tools 数量供后续对比
    const baselineToolCount = a.toolsCount;
    console.error('  baseline tool count:', baselineToolCount);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2 注册自定义 echo tool → tools 列表包含 mcp__test-echo__echo', async () => {
    const dir = createTimestampDir('sdk-custom-tool/case-2-with-custom');

    const { thrownError, resultText, events } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Use the echo tool to echo back "hello-world"',
      mcpServers: { 'test-echo': echoServer },
      allowedTools: ['mcp__test-echo__echo'],
    });

    const a = analyzeRequestDir(dir);

    console.error('\n[case-2] 注册自定义 echo tool');
    console.error('  request files:', a.requestCount);
    console.error('  tools count:', a.toolsCount);
    console.error('  tool names (last 5):', a.toolNames.slice(-5).join(', '));

    // 核心断言：自定义 tool 出现在请求的 tools 列表中
    expect(thrownError).toBeNull();
    expect(a.toolNames).toContain('mcp__test-echo__echo');

    // 检查自定义 tool 的 input_schema 结构
    const echoToolDef = a.findTool('mcp__test-echo__echo');
    console.error('  echo tool def keys:', echoToolDef ? Object.keys(echoToolDef).join(', ') : 'NOT FOUND');

    expect(echoToolDef).not.toBeNull();
    expect(echoToolDef.name).toBe('mcp__test-echo__echo');
    expect(echoToolDef.description).toContain('Echo back');
    expect(echoToolDef.input_schema).toBeDefined();
    expect(echoToolDef.input_schema.type).toBe('object');
    expect(echoToolDef.input_schema.properties.text).toBeDefined();
    expect(echoToolDef.input_schema.properties.text.type).toBe('string');
    expect(echoToolDef.input_schema.required).toContain('text');

    // 检查 LLM 是否真的调用了自定义 tool（通过查看多轮请求）
    if (a.requestCount > 1) {
      console.error('  → LLM 发起了', a.requestCount, '轮请求（含 tool 调用）');
      // 第二轮请求的 messages 应包含 tool_use 和 tool_result
      const secondReq = a.requests[1];
      if (secondReq?.messages) {
        const assistantMsg = secondReq.messages.find((m: any) => m.role === 'assistant');
        const toolUseBlocks = assistantMsg?.content?.filter((b: any) => b.type === 'tool_use') || [];
        console.error('  tool_use blocks:', toolUseBlocks.map((b: any) => b.name));
        // 本地 LLM 不一定遵循指令，所以这是观察性的
      }
    }

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-3 tools=[] + 自定义 tool → 只有自定义 tool', async () => {
    const dir = createTimestampDir('sdk-custom-tool/case-3-only-custom');

    const { thrownError, resultText } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "only-custom"',
      tools: [],
      mcpServers: { 'test-echo': echoServer },
      allowedTools: ['mcp__test-echo__echo'],
    });

    const a = analyzeRequestDir(dir);

    console.error('\n[case-3] tools=[] + 自定义 tool');
    console.error('  request files:', a.requestCount);
    console.error('  tools count:', a.toolsCount);
    console.error('  tool names:', a.toolNames.join(', '));

    // 核心断言：tools=[] 清除所有内置 tool，但 MCP tool 保留
    expect(thrownError).toBeNull();
    expect(a.toolNames).toContain('mcp__test-echo__echo');
    // 不应包含内置 tool
    expect(a.toolNames).not.toContain('Bash');
    expect(a.toolNames).not.toContain('Read');
    expect(a.toolNames).not.toContain('Edit');
    // 理论上只有 1 个 tool（但 SDK 可能注入其他 tool）
    console.error('  only mcp tool?', a.toolsCount === 1);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-4 带 annotations 的 tool → 检查 _meta/annotations', async () => {
    const dir = createTimestampDir('sdk-custom-tool/case-4-annotations');

    const { thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "annotation-test"',
      mcpServers: { 'test-ro': readOnlyServer },
      allowedTools: ['mcp__test-ro__get_timestamp'],
    });

    const a = analyzeRequestDir(dir);

    console.error('\n[case-4] 带 annotations 的 tool');
    console.error('  request files:', a.requestCount);
    console.error('  tools count:', a.toolsCount);

    const roTool = a.findTool('mcp__test-ro__get_timestamp');
    console.error('  tool found:', roTool ? 'yes' : 'no');

    expect(roTool).not.toBeNull();
    expect(roTool.name).toBe('mcp__test-ro__get_timestamp');

    // 检查 annotations 是否反映在 tool 定义中
    console.error('  tool keys:', Object.keys(roTool).join(', '));
    if (roTool._meta) {
      console.error('  _meta:', JSON.stringify(roTool._meta));
    }
    if (roTool.annotations) {
      console.error('  annotations:', JSON.stringify(roTool.annotations));
    }

    // MCP tool 的 annotations 通过 _meta 传递（MCP 规范）
    // 或直接作为 tool 的顶层字段（Anthropic API 规范）
    // 观察实际行为
    const hasAnnotations = roTool.annotations !== undefined;
    const hasMeta = roTool._meta !== undefined;
    console.error('  has annotations field:', hasAnnotations);
    console.error('  has _meta field:', hasMeta);

    expect(true).toBe(true); // 观察性断言

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-5 自定义 tool 注册但 prompt 不需要调用 → tool 仍在列表', async () => {
    const dir = createTimestampDir('sdk-custom-tool/case-5-registered-but-unused');

    const { thrownError, resultText } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "no-tool-needed"',
      mcpServers: { 'test-echo': echoServer },
      allowedTools: ['mcp__test-echo__echo'],
    });

    const a = analyzeRequestDir(dir);

    console.error('\n[case-5] 自定义 tool 注册但 prompt 不需要');
    console.error('  request files:', a.requestCount);
    console.error('  tools count:', a.toolsCount);
    console.error('  has mcp__test-echo__echo:', a.toolNames.includes('mcp__test-echo__echo'));

    // 核心断言：即使不使用，自定义 tool 也应出现在 tools 列表中
    expect(thrownError).toBeNull();
    expect(a.toolNames).toContain('mcp__test-echo__echo');
    // 只有 1 轮请求（LLM 没调用 tool）
    expect(a.requestCount).toBe(1);

    prettyFormatJsonFiles(dir);
  }, 120000);

});
