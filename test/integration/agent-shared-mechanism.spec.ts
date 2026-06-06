/**
 * Agent 共享机制观察性测试
 *
 * 课题：Claude Code CLI 和 Claude Agent SDK 是否共享同样的 agent 机制？
 *
 * 实验设计：
 * - 在一个目录中声明一个 filesystem-based agent（.claude/agents/greeter.md）
 * - 分别用 SDK 的 programmatic agents 和 filesystem-based agents 调用
 * - 观察 agent 的 prompt 和 tools 在不同调用方式下的行为差异
 *
 * 对比维度：
 * - SDK programmatic agents vs filesystem-based agents
 * - settingSources 对 filesystem agent 发现的影响
 * - agent prompt 注入 vs tools 限制的独立性
 * - programmatic agent 对 filesystem agent 的优先级覆盖
 *
 * 安全设计：
 * - greeter agent 只有 Read 工具，不会修改文件
 * - prompt 要求输出固定短语，便于断言
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { getProfileEnv } from './llm-profiles';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// ─── 公共配置 ───────────────────────────────────────────────────────────────

const BASE_ENV = getProfileEnv('local');

/** fixture 目录：包含 .claude/agents/greeter.md */
const FIXTURE_DIR = resolve(__dirname, 'fixtures/project-with-agents');

/** agent 的标识短语 — 用于断言 agent prompt 是否生效 */
const AGENT_MARKER = 'GREETER_AGENT_ACTIVE';

// ─── 分析工具 ───────────────────────────────────────────────────────────────

interface AgentMechanismAnalysis {
  requestFiles: number;
  responseFiles: number;
  /** system prompt 所有 block 的总字符数 */
  systemPromptChars: number;
  /** system prompt 的 block 数量 */
  systemBlockCount: number;
  /** system prompt 前 2000 字符（用于调试） */
  systemPromptContent: string;
  /** system prompt 是否包含 AGENT_MARKER */
  systemContainsMarker: boolean;
  /** system prompt 是否包含 greeter agent 的 prompt 内容 */
  systemContainsGreeterPrompt: boolean;
  /** 工具数量 */
  toolsCount: number;
  /** 工具名称列表 */
  toolNames: string[];
  /** 是否包含 Agent 工具 */
  hasAgentTool: boolean;
  /** 模型输出是否包含 AGENT_MARKER */
  resultContainsMarker: boolean;
  /** user message 中是否包含 CLAUDE.md 内容 */
  hasClaudeMd: boolean;
}

function analyzeAgentMechanismLogs(dir: string, result: string): AgentMechanismAnalysis {
  const allFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.pretty.json'))
    : [];
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json')).sort();
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json')).sort();

  const analysis: AgentMechanismAnalysis = {
    requestFiles: requestFiles.length,
    responseFiles: responseFiles.length,
    systemPromptChars: 0,
    systemBlockCount: 0,
    systemPromptContent: '',
    systemContainsMarker: false,
    systemContainsGreeterPrompt: false,
    toolsCount: 0,
    toolNames: [],
    hasAgentTool: false,
    resultContainsMarker: result.includes(AGENT_MARKER),
    hasClaudeMd: false,
  };

  // 分析第一个 request 文件（主请求）
  if (requestFiles.length > 0) {
    const content = readFileSync(join(dir, requestFiles[0]), 'utf-8');
    try {
      const body = JSON.parse(content);

      // 分析 system prompt
      if (Array.isArray(body.system)) {
        analysis.systemBlockCount = body.system.length;
        const systemText = body.system.map((s: any) => s.text || '').join('\n');
        analysis.systemPromptChars = systemText.length;
        analysis.systemPromptContent = systemText.substring(0, 2000);
        analysis.systemContainsMarker = systemText.includes(AGENT_MARKER);
        analysis.systemContainsGreeterPrompt = systemText.includes('greeter agent')
          || systemText.includes('GREETER_AGENT_ACTIVE');
      }

      // 分析 tools
      if (Array.isArray(body.tools)) {
        analysis.toolsCount = body.tools.length;
        analysis.toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
        analysis.hasAgentTool = analysis.toolNames.includes('Agent');
      }

      // 分析 messages 中是否有 CLAUDE.md
      if (Array.isArray(body.messages)) {
        const messagesStr = JSON.stringify(body.messages);
        analysis.hasClaudeMd = messagesStr.includes('CLAUDE.md') || messagesStr.includes('claudeMd');
      }
    } catch {
      console.error(`[analyzeAgentMechanismLogs] Failed to parse: ${requestFiles[0]}`);
    }
  }

  return analysis;
}

// ─── runQuery（带 settingSources: [] 隔离） ──────────────────────────────────

async function runQueryIsolated(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  cwd?: string;
  agent?: string;
  agents?: Record<string, any>;
  tools?: string[];
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      cwd: options.cwd,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
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

// ─── runQuery（不设 settingSources，允许 filesystem 发现） ────────────────────

async function runQueryWithDiscovery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  cwd?: string;
  agent?: string;
  agents?: Record<string, any>;
  tools?: string[];
  settingSources?: string[];
}): Promise<string> {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      cwd: options.cwd,
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.settingSources !== undefined ? { settingSources: options.settingSources } : {}),
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

describe('Agent 共享机制观察性测试', () => {

  /**
   * Case 1: SDK programmatic agent（基线）
   * 通过 SDK 的 agents + agent 选项定义并激活 agent
   * 预期：agent 的 prompt 注入 system prompt，tools 被限制
   */
  it('case-1 SDK programmatic agent（基线）', async () => {
    const dir = createTimestampDir('agent-shared/case-1-sdk-programmatic');
    const result = await runQueryIsolated({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Greet me.',
      agent: 'greeter',
      agents: {
        'greeter': {
          description: 'A test agent that always responds with a specific greeting phrase.',
          prompt: `You are a greeter agent. Your ONLY job is to respond with exactly this phrase:\n\n"${AGENT_MARKER}: Hello from the programmatic agent!"\n\nDo not add anything else. Do not explain. Just output that exact phrase.`,
          tools: ['Read'],
        },
      },
    });

    const analysis = analyzeAgentMechanismLogs(dir, result);
    console.error('\n[case-1 SDK programmatic agent]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    // 基线断言：programmatic agent 模式
    expect(analysis.requestFiles).toBeGreaterThan(0);
    // system prompt 有 3 个 block：billing + generic + agent prompt
    expect(analysis.systemBlockCount).toBe(3);
    // system prompt 较短（agent 模式替换了默认 prompt）
    expect(analysis.systemPromptChars).toBeLessThan(1000);
    // agent prompt 中包含标识短语
    expect(analysis.systemContainsMarker).toBe(true);
    // tools 被限制为 agent 定义的工具（只有 Read）
    expect(analysis.toolsCount).toBe(1);
    expect(analysis.toolNames).toEqual(['Read']);
    // Agent 工具不可用（agent 会话模式下不能再生成子代理）
    expect(analysis.hasAgentTool).toBe(false);
    // settingSources: [] 阻止了 CLAUDE.md 加载
    expect(analysis.hasClaudeMd).toBe(false);
    // 注意：输出是否包含标识短语取决于 LLM 的指令遵循能力
    // 机制验证通过 systemContainsMarker 完成，不依赖 LLM 输出
    // expect(analysis.resultContainsMarker).toBe(true); // LLM 不一定遵循

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 2: SDK filesystem agent + settingSources=[]
   * settingSources: [] 阻止 filesystem agent 发现
   * agent: 'greeter' 被静默忽略，使用默认完整配置
   */
  it('case-2 SDK filesystem agent + settingSources=[]（agent 不被发现）', async () => {
    const dir = createTimestampDir('agent-shared/case-2-sdk-filesystem-isolated');
    const result = await runQueryIsolated({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Say "hello".',
      cwd: FIXTURE_DIR,
      agent: 'greeter',
      // 不传 agents — 依赖 filesystem 发现，但 settingSources: [] 会阻止
    });

    const analysis = analyzeAgentMechanismLogs(dir, result);
    console.error('\n[case-2 SDK filesystem + settingSources=[]]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    // settingSources: [] 阻止了 filesystem agent 发现
    expect(analysis.requestFiles).toBeGreaterThan(0);
    // agent 未生效 → 使用完整默认工具集（23 个）
    expect(analysis.toolsCount).toBe(23);
    expect(analysis.hasAgentTool).toBe(true);
    // agent prompt 未注入
    expect(analysis.systemContainsMarker).toBe(false);
    expect(analysis.systemContainsGreeterPrompt).toBe(false);
    // system prompt 只有 2 个 block（billing + generic，无 agent prompt）
    expect(analysis.systemBlockCount).toBe(2);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 3: SDK filesystem agent + 默认 settingSources（允许发现）
   * 不传 settingSources，SDK 使用默认行为扫描 cwd/.claude/agents/
   * 关键发现：tools 限制生效，但 prompt 不注入 system prompt
   */
  it('case-3 SDK filesystem agent + 默认 settingSources（部分生效）', async () => {
    const dir = createTimestampDir('agent-shared/case-3-sdk-filesystem-discovery');
    const result = await runQueryWithDiscovery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Greet me.',
      cwd: FIXTURE_DIR,
      agent: 'greeter',
      // 不传 settingSources — 允许 filesystem 发现
    });

    const analysis = analyzeAgentMechanismLogs(dir, result);
    console.error('\n[case-3 SDK filesystem + 默认 settingSources]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    // filesystem agent 被发现 — tools 限制生效
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.toolsCount).toBe(1); // 只有 Read
    expect(analysis.toolNames).toEqual(['Read']);
    expect(analysis.hasAgentTool).toBe(false);

    // 关键发现：filesystem agent 的 prompt 不注入 system prompt
    // system prompt 只有 2 个 block（billing + generic），没有第 3 个 agent prompt block
    expect(analysis.systemBlockCount).toBe(2);
    expect(analysis.systemContainsMarker).toBe(false);
    expect(analysis.systemContainsGreeterPrompt).toBe(false);

    // CLAUDE.md 被加载到 user message 中（因为没有 settingSources: []）
    expect(analysis.hasClaudeMd).toBe(true);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 4: SDK filesystem agent + settingSources=['project']
   * 显式指定 settingSources 包含 'project'，验证是否能发现 agent
   */
  it('case-4 SDK filesystem agent + settingSources=[project]', async () => {
    const dir = createTimestampDir('agent-shared/case-4-sdk-filesystem-project');
    const result = await runQueryWithDiscovery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Greet me.',
      cwd: FIXTURE_DIR,
      agent: 'greeter',
      settingSources: ['project'],
    });

    const analysis = analyzeAgentMechanismLogs(dir, result);
    console.error('\n[case-4 SDK filesystem + settingSources=[project]]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    expect(analysis.requestFiles).toBeGreaterThan(0);
    // settingSources=['project'] 也能发现 filesystem agent
    // tools 限制生效（只有 Read）
    expect(analysis.toolsCount).toBe(1);
    expect(analysis.toolNames).toEqual(['Read']);
    expect(analysis.hasAgentTool).toBe(false);
    // 但 prompt 仍然不注入（与 case-3 一致）
    expect(analysis.systemBlockCount).toBe(2);
    expect(analysis.systemContainsMarker).toBe(false);
    expect(analysis.systemContainsGreeterPrompt).toBe(false);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 5: programmatic agent 覆盖 filesystem agent（同名优先级）
   * 同时传 agents（programmatic）和 cwd（filesystem），验证优先级
   */
  it('case-5 programmatic agent 覆盖 filesystem agent（优先级）', async () => {
    const dir = createTimestampDir('agent-shared/case-5-priority');
    const result = await runQueryIsolated({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'Greet me.',
      cwd: FIXTURE_DIR,
      agent: 'greeter',
      agents: {
        'greeter': {
          description: 'Programmatic greeter (should override filesystem)',
          prompt: `You are a PROGRAMMATIC greeter. Respond with exactly: "${AGENT_MARKER}: Hello from PROGRAMMATIC override!"\n\nNothing else.`,
          tools: ['Read'],
        },
      },
    });

    const analysis = analyzeAgentMechanismLogs(dir, result);
    console.error('\n[case-5 优先级对比]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    // programmatic agent 应该覆盖 filesystem agent
    expect(analysis.requestFiles).toBeGreaterThan(0);
    expect(analysis.systemBlockCount).toBe(3); // billing + generic + agent prompt
    expect(analysis.systemContainsMarker).toBe(true);
    // 验证是 PROGRAMMATIC 的 prompt 生效
    expect(analysis.systemPromptContent).toContain('PROGRAMMATIC');
    expect(analysis.toolsCount).toBe(1);
    expect(analysis.toolNames).toEqual(['Read']);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 6: CLI --agent flag（需要 claude CLI 可用）
   * 通过 CLI 的 --agent flag 在含 .claude/agents/ 的目录中调用 agent
   * 如果 CLI 不可用则跳过
   */
  it.skip('case-6 CLI --agent flag with filesystem agent（需要 claude CLI）', async () => {
    const dir = createTimestampDir('agent-shared/case-6-cli-filesystem');

    let cliResult = '';
    let cliExitCode = 0;
    try {
      cliResult = execSync(
        `claude -p "Greet me." --agent greeter --output-format json`,
        {
          cwd: FIXTURE_DIR,
          encoding: 'utf-8',
          timeout: 120000,
          env: {
            ...process.env,
            ...BASE_ENV,
            OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
          },
        },
      );
    } catch (e: any) {
      cliExitCode = e.status || 1;
      cliResult = e.stdout || e.stderr || '';
      console.error('\n[case-6] CLI error:', e.message);
    }

    console.error('\n[case-6] CLI exit code:', cliExitCode);
    console.error('[case-6] CLI output:', cliResult.substring(0, 500));

    let parsedResult = '';
    try {
      const json = JSON.parse(cliResult);
      parsedResult = json.result || '';
    } catch {
      parsedResult = cliResult;
    }

    const analysis = analyzeAgentMechanismLogs(dir, parsedResult);
    console.error('\n[case-6 CLI filesystem agent]', JSON.stringify({
      ...analysis,
      systemPromptContent: analysis.systemPromptContent.substring(0, 500),
    }, null, 2));

    // CLI 应该发现 filesystem agent 并注入 prompt
    if (cliExitCode === 0) {
      // CLI 的 --agent 应该完整激活 agent（包括 prompt 注入）
      expect(analysis.systemContainsGreeterPrompt).toBe(true);
      expect(analysis.toolsCount).toBe(1);
      expect(analysis.toolNames).toEqual(['Read']);
    }

    prettyFormatJsonFiles(dir);
  }, 120000);
});
