/**
 * Agent 工具观察性测试
 *
 * 观察 Agent 工具（子代理）在 SDK 中的调用行为：
 * - Agent 工具是否默认存在及其 schema 结构
 * - agents 配置对请求体的影响
 * - tools 选项对工具可用性的控制
 * - agent 会话模式的请求结构
 *
 * 安全设计：
 * - 所有 case 均使用简单 prompt，不触发 Agent 工具调用（不启动子代理）
 * - 通过 disallowedTools 禁止 Bash/Write/Edit 等高危工具
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ─── 公共配置 ───────────────────────────────────────────────────────────────

const BASE_ENV = getProfileEnv('local');

/** 高危工具 — 禁止使用，防止意外修改文件或执行命令 */
const DANGEROUS_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];

// ─── 分析工具 ───────────────────────────────────────────────────────────────

interface AgentToolAnalysis {
  requestFiles: number;
  responseFiles: number;
  systemPromptChars: number;
  systemHasAgentInfo: boolean;
  hasAgentTool: boolean;
  agentToolSchema: Record<string, unknown> | null;
  hasAgentToolUse: boolean;
  toolsCount: number;
  toolNames: string[];
}

function analyzeAgentLogs(dir: string): AgentToolAnalysis {
  const allFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'))
    : [];
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const analysis: AgentToolAnalysis = {
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    systemPromptChars: 0,
    systemHasAgentInfo: false,
    hasAgentTool: false,
    agentToolSchema: null,
    hasAgentToolUse: false,
    toolsCount: 0,
    toolNames: [],
  };

  for (const rf of requestFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    try {
      const body = JSON.parse(content);

      if (Array.isArray(body.tools)) {
        const agentTool = body.tools.find((t: any) => t.name === 'Agent');
        if (agentTool && !analysis.hasAgentTool) {
          analysis.hasAgentTool = true;
          analysis.agentToolSchema = agentTool.input_schema || null;
          analysis.toolsCount = body.tools.length;
          analysis.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
        }
        if (!analysis.hasAgentTool && analysis.toolsCount === 0) {
          analysis.toolsCount = body.tools.length;
          analysis.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
        }
      }

      if (analysis.systemPromptChars === 0 && Array.isArray(body.system)) {
        const systemText = body.system.map((s: any) => s.text || '').join('\n');
        analysis.systemPromptChars = systemText.length;
        analysis.systemHasAgentInfo = /agent|subagent/i.test(systemText);
      }
    } catch {
      console.error(`[analyzeAgentLogs] Failed to parse: ${rf}`);
    }
  }

  for (const rf of responseFiles) {
    const content = readFileSync(join(dir, rf), 'utf-8');
    try {
      const body = JSON.parse(content);
      if (Array.isArray(body.content)) {
        if (body.content.some((b: any) => b.type === 'tool_use' && b.name === 'Agent')) {
          analysis.hasAgentToolUse = true;
        }
      }
    } catch { /* response 可能截断 */ }
  }

  return analysis;
}

// ─── runQuery ────────────────────────────────────────────────────────────────

async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  tools?: string[];
  agents?: Record<string, any>;
  agent?: string;
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      disallowedTools: DANGEROUS_TOOLS,
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
    } as any,
  });

  let resultText = '';
  for await (const message of sdkQuery) {
    const msg = message as any;
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
      const delta = msg.event.delta;
      if (delta?.type === 'text_delta') process.stderr.write(delta.text);
    }
    if (msg.type === 'result') resultText = msg.result || '';
  }
  return resultText;
}

// ─── 测试 ───────────────────────────────────────────────────────────────────

describe('Agent 工具观察性测试', () => {

  it('case-1 基线：默认配置，简单 prompt', async () => {
    const dir = createTimestampDir('agent-tool/case-1-baseline');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hello". Nothing else.',
    });

    const analysis = analyzeAgentLogs(dir);
    console.error('\n[case-1 基线]', JSON.stringify(analysis, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.hasAgentTool).toBe(true);
    expect(analysis.toolNames).not.toContain('Bash');
    expect(analysis.toolNames).not.toContain('Write');
    expect(analysis.toolNames).not.toContain('Edit');
    expect(analysis.toolNames).toContain('Agent');
    expect(analysis.toolNames).toContain('Read');
    expect(analysis.hasAgentToolUse).toBe(false);
    expect(analysis.systemHasAgentInfo).toBe(true);

    const schema = analysis.agentToolSchema as any;
    expect(schema.required).toContain('description');
    expect(schema.required).toContain('prompt');
    expect(schema.properties).toHaveProperty('subagent_type');
    expect(schema.properties).toHaveProperty('model');
    expect(schema.properties).toHaveProperty('run_in_background');
    expect(schema.properties).toHaveProperty('isolation');
    expect(schema.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku']);
    expect(schema.properties.isolation.enum).toEqual(['worktree']);

    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2 自定义 agents 配置', async () => {
    const dir = createTimestampDir('agent-tool/case-2-custom-agents');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hello". Nothing else.',
      agents: {
        'code-reviewer': {
          description: 'Reviews code for quality and best practices',
          prompt: 'You are a code reviewer.',
          tools: ['Read', 'Grep', 'Glob'],
        },
        'summarizer': {
          description: 'Summarizes text content',
          prompt: 'You are a summarizer.',
          tools: ['Read'],
        },
      },
    });

    const analysis = analyzeAgentLogs(dir);
    console.error('\n[case-2 自定义 agents]', JSON.stringify(analysis, null, 2));

    expect(analysis.hasAgentTool).toBe(true);
    expect(analysis.toolNames).toContain('Agent');
    expect(analysis.toolNames).not.toContain('code-reviewer');
    expect(analysis.hasAgentToolUse).toBe(false);
    expect(analysis.systemHasAgentInfo).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-3 Agent 工具 input_schema 结构', async () => {
    const dir = createTimestampDir('agent-tool/case-3-schema');
    await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "ok".',
    });

    const analysis = analyzeAgentLogs(dir);
    console.error('\n[case-3 schema]', JSON.stringify(analysis.agentToolSchema, null, 2));

    expect(analysis.hasAgentTool).toBe(true);
    expect(analysis.agentToolSchema).not.toBeNull();

    const schema = analysis.agentToolSchema as any;
    const props = Object.keys(schema.properties);
    expect(props).toHaveLength(6);
    expect(props).toContain('description');
    expect(props).toContain('prompt');
    expect(props).toContain('subagent_type');
    expect(props).toContain('model');
    expect(props).toContain('run_in_background');
    expect(props).toContain('isolation');
    expect(schema.required).toEqual(['description', 'prompt']);
    expect(schema.additionalProperties).toBe(false);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-4 禁用 Agent 工具', async () => {
    const dir = createTimestampDir('agent-tool/case-4-no-agent-tool');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "hello". Nothing else.',
      tools: ['Read', 'Grep', 'Glob'],
    });

    const analysis = analyzeAgentLogs(dir);
    console.error('\n[case-4 禁用 Agent]', JSON.stringify(analysis, null, 2));

    expect(analysis.hasAgentTool).toBe(false);
    expect(analysis.toolNames).not.toContain('Agent');
    expect(analysis.toolsCount).toBe(3);
    expect(analysis.toolNames).toContain('Read');
    expect(analysis.toolNames).toContain('Grep');
    expect(analysis.toolNames).toContain('Glob');
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-5 agent 会话模式', async () => {
    const dir = createTimestampDir('agent-tool/case-5-agent-session');
    const result = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say exactly: "I am the code-reviewer agent". Nothing else.',
      agent: 'code-reviewer',
      agents: {
        'code-reviewer': {
          description: 'Reviews code for quality',
          prompt: 'You are a code reviewer. When asked to identify yourself, say "I am the code-reviewer agent".',
          tools: ['Read', 'Grep'],
        },
      },
    });

    const analysis = analyzeAgentLogs(dir);
    console.error('\n[case-5 agent 会话模式]', JSON.stringify(analysis, null, 2));

    expect(analysis.toolNames).toContain('Read');
    expect(analysis.toolNames).toContain('Grep');
    expect(analysis.toolsCount).toBe(2);
    expect(analysis.hasAgentTool).toBe(false);
    expect(analysis.systemPromptChars).toBeLessThan(500);
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);
    prettyFormatJsonFiles(dir);
  }, 120000);
});
