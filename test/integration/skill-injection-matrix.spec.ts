/**
 * 变量控制法：观察 tools / settingSources / cwd / additionalDirectories 对 skill 注入的影响
 *
 * 变量：
 *   - tools: [] | ['Skill'] | 不设置(默认全量)
 *   - settingSources: [] | ['user'] | ['project'] | ['local'] | ['user','project'] | 不设置(默认)
 *   - cwd: 有 .claude/skills/ 的目录 | 无 skill 的空目录
 *   - additionalDirectories: 有 .claude/skills/ 的目录 | 不设置
 *
 * 每个用例的日志目录按编号区分，便于事后观察：
 *   test/integration/tmp/skill-matrix/case-1-baseline/
 *   test/integration/tmp/skill-matrix/case-2-tools-empty/
 *   ...
 *   test/integration/tmp/skill-matrix/case-9-settings-user-only/
 *   test/integration/tmp/skill-matrix/case-10-settings-project-only/
 *   ...
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

// --- 固定路径 ---
const DIR_WITH_SKILLS = resolve(__dirname, 'fixtures', 'project-with-skills');
const DIR_ADDITIONAL = resolve(__dirname, 'fixtures', 'additional-dir');
const DIR_EMPTY = resolve(__dirname, 'fixtures', 'empty-project');
const CONFIG_WITH_SKILLS = resolve(__dirname, 'fixtures', 'custom-config');
const CONFIG_EMPTY = resolve(__dirname, 'fixtures', 'empty-config');

// --- 公共 env ---
const BASE_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN_LOCAL,
  ANTHROPIC_BASE_URL: 'http://10.1.3.115:4000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Jereh-LLM-NO-THINK-V1',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Jereh-LLM-NO-THINK-V1',
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

// --- 辅助函数 ---

interface RequestAnalysis {
  hasSkillTool: boolean;
  toolNames: string[];
  toolCount: number;
  skillList: string[];       // system-reminder 中列出的 skill 名称
  hasCustomSkill: boolean;   // 是否包含自定义项目级 skill (greet/joke)
  hasUserSkill: boolean;     // 是否包含用户级 skill (如 brainstorming, tdd 等)
  allText: string;           // user message 全文
}

function analyzeRequest(apiBodyDir: string): RequestAnalysis {
  const allFiles = readdirSync(apiBodyDir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
  if (requestFiles.length === 0) {
    return { hasSkillTool: false, toolNames: [], toolCount: 0, skillList: [], hasCustomSkill: false, hasUserSkill: false, allText: '' };
  }

  const firstFile = requestFiles.sort()[0];
  const content = readFileSync(join(apiBodyDir, firstFile), 'utf-8');
  const requestBody = JSON.parse(content);

  // tools 分析
  const tools: any[] = requestBody.tools || [];
  const toolNames = tools.map((t: any) => t.name);
  const hasSkillTool = toolNames.includes('Skill');

  // user message 文本
  const userMessage = requestBody.messages?.[0];
  const allText = userMessage?.content
    ?.filter((block: any) => block.type === 'text')
    ?.map((block: any) => block.text)
    ?.join('\n') || '';

  // 从 system-reminder 中提取 skill 列表
  const skillListMatch = allText.match(/The following skills are available[\s\S]*?<\/system-reminder>/);
  const skillList: string[] = [];
  if (skillListMatch) {
    const matches = skillListMatch[0].matchAll(/^- (\S+?):/gm);
    for (const m of matches) {
      skillList.push(m[1]);
    }
  }

  const hasCustomSkill = skillList.includes('greet') || skillList.includes('joke');

  // 用户级 skill 标志（来自 ~/.claude/skills/，如 brainstorming, tdd 等）
  const USER_LEVEL_SKILLS = ['brainstorming', 'tdd', 'systematic-debugging', 'skill-creator'];
  const hasUserSkill = USER_LEVEL_SKILLS.some(s => skillList.includes(s));

  return { hasSkillTool, toolNames, toolCount: tools.length, skillList, hasCustomSkill, hasUserSkill, allText };
}

async function runQuery(options: any): Promise<string> {
  const sdkQuery = query({ prompt: 'say hello', options });
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

// --- 测试用例 ---

describe('Skill 注入变量控制矩阵', () => {

  // Case 1: 基准（对照组）
  // tools: ['Skill'], settingSources: 默认, cwd: 有skill, additionalDirectories: 无
  it('case-1 基准: tools=Skill, cwd有skill → 自定义skill出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-1-baseline');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-1] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.toolCount).toBe(1);
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 2: tools=[] → Skill 工具和列表都应消失
  it('case-2 tools空数组: tools=[], cwd有skill → 无Skill工具，无skill列表', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-2-tools-empty');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: [],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-2] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(false);
    expect(analysis.toolCount).toBe(0);
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.skillList).toHaveLength(0);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 3: tools 不设置（默认全量）→ Skill 工具出现 + 其他工具也出现
  it('case-3 tools默认: tools不设置, cwd有skill → Skill工具+其他工具都出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-3-tools-default');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      // tools 不设置
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-3] toolCount:', analysis.toolCount, 'toolNames:', analysis.toolNames.slice(0, 5), '...');
    console.error('[case-3] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.toolCount).toBeGreaterThan(1); // 应该有很多工具
    expect(analysis.hasCustomSkill).toBe(true);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 4: 加 settingSources=[] → 自定义 skill 被阻止
  it('case-4 settingSources空: tools=Skill, cwd有skill, settingSources=[] → 自定义skill消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-4-settings-empty');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-4] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // 自定义 skill 不应出现
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.skillList).not.toContain('greet');
    expect(analysis.skillList).not.toContain('joke');
    // bundled skills 仍然存在
    expect(analysis.skillList.length).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 5: cwd 改为空目录 → 自定义 skill 消失
  it('case-5 cwd空目录: tools=Skill, cwd无skill → 自定义skill消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-5-cwd-empty');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-5] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.skillList).not.toContain('greet');
    expect(analysis.skillList).not.toContain('joke');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 6: cwd 空目录 + additionalDirectories 有 skill → 仅靠 additionalDirectories 注入
  it('case-6 仅additionalDirs: cwd空, additionalDirectories有skill → 自定义skill出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-6-additional-only');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      additionalDirectories: [DIR_ADDITIONAL],
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-6] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 7: cwd 有 skill + additionalDirectories 也有 skill → 两边都出现（去重还是叠加？）
  it('case-7 双来源: cwd有skill + additionalDirectories有skill → 观察去重/叠加', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-7-both-sources');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      additionalDirectories: [DIR_ADDITIONAL],
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-7] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    // greet 和 joke 应该出现（可能去重，也可能各出现一次）
    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.hasCustomSkill).toBe(true);

    // 统计 greet 出现次数，观察是去重还是叠加
    const greetCount = analysis.skillList.filter(s => s === 'greet').length;
    const jokeCount = analysis.skillList.filter(s => s === 'joke').length;
    console.error(`[case-7] greet出现${greetCount}次, joke出现${jokeCount}次 → ${greetCount === 1 ? '去重' : '叠加'}`);

    expect(greetCount).toBeGreaterThanOrEqual(1);
    expect(jokeCount).toBeGreaterThanOrEqual(1);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 8: cwd有skill + settingSources=[] + additionalDirectories有skill → settingSources 是否同时阻止两个来源
  it('case-8 settingSources阻止双来源: cwd有skill + additionalDirs有skill + settingSources=[] → 全部被阻止', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-8-settings-blocks-all');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      additionalDirectories: [DIR_ADDITIONAL],
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-8] toolNames:', analysis.toolNames, 'skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // settingSources=[] 应该同时阻止 cwd 和 additionalDirectories 的自定义 skill
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.skillList).not.toContain('greet');
    expect(analysis.skillList).not.toContain('joke');
    // bundled skills 仍然存在
    expect(analysis.skillList.length).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // ========== settingSources 细粒度测试 ==========

  // Case 9: settingSources=['user'] → 只加载用户级 skill，不加载项目级
  it('case-9 settingSources=user: cwd有skill → 用户级skill出现，项目级skill消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-9-settings-user-only');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-9] skills:', analysis.skillList);
    console.error('[case-9] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 用户级 skill 应该出现
    expect(analysis.hasUserSkill).toBe(true);
    // 项目级自定义 skill 不应出现（因为没加载 'project'）
    expect(analysis.hasCustomSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 10: settingSources=['project'] → 只加载项目级 skill，不加载用户级
  it('case-10 settingSources=project: cwd有skill → 项目级skill出现，用户级skill消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-10-settings-project-only');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['project'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-10] skills:', analysis.skillList);
    console.error('[case-10] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 项目级自定义 skill 应该出现
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    // 用户级 skill 不应出现
    expect(analysis.hasUserSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 11: settingSources=['local'] → 只加载 local settings，用户级和项目级 skill 都不出现
  it('case-11 settingSources=local: cwd有skill → 用户级和项目级skill都消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-11-settings-local-only');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['local'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-11] skills:', analysis.skillList);
    console.error('[case-11] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 用户级和项目级 skill 都不应出现
    expect(analysis.hasUserSkill).toBe(false);
    expect(analysis.hasCustomSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 12: settingSources=['user','project'] → 用户级和项目级 skill 都出现
  it('case-12 settingSources=user+project: cwd有skill → 用户级和项目级skill都出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-12-settings-user-project');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user', 'project'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-12] skills:', analysis.skillList);
    console.error('[case-12] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 两者都应出现
    expect(analysis.hasUserSkill).toBe(true);
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 13: settingSources=['project'] + additionalDirectories → project 是否也控制 additionalDirectories 的 skill
  it('case-13 settingSources=project + additionalDirs: 观察 additionalDirs 的 skill 是否受 project 控制', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-13-project-with-additional');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      additionalDirectories: [DIR_ADDITIONAL],
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['project'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-13] skills:', analysis.skillList);
    console.error('[case-13] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 用户级 skill 不应出现（没有 'user'）
    expect(analysis.hasUserSkill).toBe(false);
    // additionalDirectories 的 skill 是否出现？这是要观察的
    console.error(`[case-13] additionalDirs skill 在 settingSources=['project'] 下: ${analysis.hasCustomSkill ? '出现' : '不出现'}`);
    // 不做硬断言，记录结果即可（如果出现说明 additionalDirs 不受 settingSources 中 project 的约束）
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // ========== skills 选项过滤测试 ==========

  // Case 14: skills='all' → 所有发现的 skill 都出现（等同于不设 skills）
  it('case-14 skills=all: 所有发现的skill都出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-14-skills-all');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
      skills: 'all',
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-14] skills:', analysis.skillList);
    console.error('[case-14] hasUserSkill:', analysis.hasUserSkill, 'hasCustomSkill:', analysis.hasCustomSkill);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.hasUserSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 15: skills=['greet'] → 只有 greet 出现，joke 和其他 skill 都不出现
  it('case-15 skills=[greet]: 只有greet出现，其他skill消失', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-15-skills-greet-only');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
      skills: ['greet'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-15] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // 只有 greet 应该出现
    expect(analysis.skillList).toContain('greet');
    // joke 不应出现
    expect(analysis.skillList).not.toContain('joke');
    // 用户级 skill 不应出现
    expect(analysis.hasUserSkill).toBe(false);
    // bundled skills 也不应出现（被过滤掉）
    expect(analysis.skillList).not.toContain('loop');
    expect(analysis.skillList).not.toContain('simplify');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 16: skills=['greet','joke'] → 只有 greet 和 joke 出现
  it('case-16 skills=[greet,joke]: 只有greet和joke出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-16-skills-greet-joke');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
      skills: ['greet', 'joke'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-16] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    // 其他 skill 不应出现
    expect(analysis.hasUserSkill).toBe(false);
    expect(analysis.skillList).not.toContain('loop');
    expect(analysis.skillList).not.toContain('update-config');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 17: skills=['greet'] + settingSources=[] → skills 过滤是否依赖 settingSources 发现
  it('case-17 skills=[greet] + settingSources=[]: skills过滤是否依赖settingSources', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-17-skills-filter-with-empty-settings');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: ['Skill'],
      skills: ['greet'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-17] skills:', analysis.skillList);
    console.error('[case-17] settingSources=[] 下 skills=[greet] 的效果:', analysis.hasCustomSkill ? 'greet出现' : 'greet不出现');

    expect(analysis.hasSkillTool).toBe(true);
    // 观察：settingSources=[] 是否阻止了 skills 选项的过滤能力
    // 如果 greet 不出现，说明 skills 选项依赖 settingSources 先发现 skill
    // 如果 greet 出现，说明 skills 选项可以绕过 settingSources 的限制
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 18: skills=['loop'] → 只保留 bundled skill，自定义 skill 被过滤
  it('case-18 skills=[loop]: 只保留bundled skill loop，自定义skill被过滤', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-18-skills-bundled-only');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
      skills: ['loop'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-18] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // 只有 loop 应该出现
    expect(analysis.skillList).toContain('loop');
    // 自定义 skill 不应出现
    expect(analysis.hasCustomSkill).toBe(false);
    // 其他 bundled skill 也不应出现
    expect(analysis.skillList).not.toContain('simplify');
    expect(analysis.skillList).not.toContain('update-config');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 19: skills=[] → 空数组是否禁用所有 skill（包括 bundled）
  it('case-19 skills=[]: 空数组是否禁用所有skill', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-19-skills-empty-array');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}` },
      includePartialMessages: true,
      persistSession: false,
      effort: 'low',
      tools: ['Skill'],
      skills: [],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-19] skills:', analysis.skillList);
    console.error('[case-19] Skill工具是否存在:', analysis.hasSkillTool);
    console.error('[case-19] skill列表长度:', analysis.skillList.length);

    // 观察：skills=[] 是否移除所有 skill（包括 bundled）
    // 或者 Skill 工具本身是否还存在
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // ========== CLAUDE_CONFIG_DIR 环境变量测试 ==========

  // Case 20: CLAUDE_CONFIG_DIR 指向有 skill 的自定义 config + settingSources=['user'] → 自定义 config 的 skill 出现
  it('case-20 CLAUDE_CONFIG_DIR有skill + settingSources=user: 自定义config的skill出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-20-config-dir-with-skills');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        CLAUDE_CONFIG_DIR: CONFIG_WITH_SKILLS,
      },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-20] skills:', analysis.skillList);
    console.error('[case-20] hasCustomSkill:', analysis.hasCustomSkill, 'hasUserSkill:', analysis.hasUserSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 自定义 config 目录的 skill 应该出现（替代了 ~/.claude/skills/）
    expect(analysis.hasCustomSkill).toBe(true);
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).toContain('joke');
    // 原始用户级 skill 不应出现（被 CLAUDE_CONFIG_DIR 替换了）
    expect(analysis.hasUserSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 21: CLAUDE_CONFIG_DIR 指向空 config + settingSources=['user'] → 无用户级 skill
  it('case-21 CLAUDE_CONFIG_DIR空 + settingSources=user: 无用户级skill', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-21-config-dir-empty');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        CLAUDE_CONFIG_DIR: CONFIG_EMPTY,
      },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-21] skills:', analysis.skillList);
    console.error('[case-21] hasCustomSkill:', analysis.hasCustomSkill, 'hasUserSkill:', analysis.hasUserSkill);

    expect(analysis.hasSkillTool).toBe(true);
    // 空 config 目录没有 skill
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.hasUserSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 22: CLAUDE_CONFIG_DIR有skill + settingSources=[] → settingSources 仍然阻止发现
  it('case-22 CLAUDE_CONFIG_DIR有skill + settingSources=[]: settingSources仍阻止', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-22-config-dir-blocked');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        CLAUDE_CONFIG_DIR: CONFIG_WITH_SKILLS,
      },
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-22] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // settingSources=[] 应该阻止即使 CLAUDE_CONFIG_DIR 有 skill
    expect(analysis.hasCustomSkill).toBe(false);
    expect(analysis.hasUserSkill).toBe(false);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 23: CLAUDE_CONFIG_DIR有skill + cwd有skill + settingSources=['user','project'] → 两者都出现
  it('case-23 CLAUDE_CONFIG_DIR有skill + cwd有skill: 两个来源都出现', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-23-config-dir-plus-cwd');
    const result = await runQuery({
      cwd: DIR_WITH_SKILLS,
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        CLAUDE_CONFIG_DIR: CONFIG_WITH_SKILLS,
      },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user', 'project'],
      effort: 'low',
      tools: ['Skill'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-23] skills:', analysis.skillList);
    const greetCount = analysis.skillList.filter(s => s === 'greet').length;
    console.error(`[case-23] greet出现${greetCount}次 → ${greetCount > 1 ? '叠加' : '去重'}`);

    expect(analysis.hasSkillTool).toBe(true);
    expect(analysis.hasCustomSkill).toBe(true);
    // 观察：CLAUDE_CONFIG_DIR 的 skill 和 cwd 的 skill 是否叠加
    expect(greetCount).toBeGreaterThanOrEqual(1);
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);

  // Case 24: CLAUDE_CONFIG_DIR有skill + skills过滤 → 精确控制最终可见 skill
  it('case-24 CLAUDE_CONFIG_DIR有skill + skills=[greet]: 完整隔离方案验证', async () => {
    const apiBodyDir = createTimestampDir('skill-matrix/case-24-config-dir-with-filter');
    const result = await runQuery({
      cwd: DIR_EMPTY,
      env: {
        ...BASE_ENV,
        OTEL_LOG_RAW_API_BODIES: `file:${apiBodyDir}`,
        CLAUDE_CONFIG_DIR: CONFIG_WITH_SKILLS,
      },
      includePartialMessages: true,
      persistSession: false,
      settingSources: ['user'],
      effort: 'low',
      tools: ['Skill'],
      skills: ['greet'],
    });

    const analysis = analyzeRequest(apiBodyDir);
    console.error('\n[case-24] skills:', analysis.skillList);

    expect(analysis.hasSkillTool).toBe(true);
    // 只有 greet 出现，joke 被 skills 过滤掉
    expect(analysis.skillList).toContain('greet');
    expect(analysis.skillList).not.toContain('joke');
    expect(analysis.hasUserSkill).toBe(false);
    expect(analysis.skillList).not.toContain('loop');
    expect(result.trim().length).toBeGreaterThan(0);

    prettyFormatJsonFiles(apiBodyDir);
  }, 120000);
});
