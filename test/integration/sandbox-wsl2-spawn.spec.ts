/**
 * Sandbox WSL2 Spawn 实验性测试
 *
 * 观察目标：
 * 1. 能否通过 SDK 的 spawnClaudeCodeProcess 钩子，从 Windows 穿透到 WSL2 启动 Linux 版 Claude
 * 2. WSL2 里的 Claude 是否能正常启用 sandbox
 * 3. 对比：Windows 原生 Claude + sandbox.enabled=true（抛异常）vs WSL2 Claude + sandbox.enabled=true（是否正常）
 *
 * 前置条件：
 * - Windows 上的 WSL2 发行版 Ubuntu-24.04 已安装
 * - WSL2 里已安装：node(v22)、claude-code(npm global)、bubblewrap、socat
 *
 * 实验矩阵：
 * | case | spawn 方式  | sandbox.enabled | 预期行为                          |
 * |------|------------|----------------|----------------------------------|
 * | 1    | Windows 默认 | true           | 抛异常 "windows not supported"    |
 * | 2    | WSL2 钩子   | 无             | 正常完成（WSL2 基线）             |
 * | 3    | WSL2 钩子   | true           | 正常完成，sandbox 生效            |
 * | 4    | WSL2 钩子   | true+全配置    | 正常完成，sandbox 配置生效         |
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';

dotenv.config();

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

const WSL_DISTRO = 'Ubuntu-24.04';

/**
 * 创建 WSL2 spawn 钩子函数。
 * 将 SDK 默认的 claude.exe 调用改为 wsl -d <distro> -- claude ...
 * 关键：把 SDK 传入的 env 变量注入到 WSL2 的 bash 命令中
 */
function createWslSpawn(distro: string) {
  return (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => {
    // 构建 env export 语句
    const envExports = Object.entries(options.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}=${shellescape(v!)}`)
      .join('; ');

    // 把 claude 的 args 透传到 WSL2 里
    const claudeCmd = options.args.map(a => shellescape(a)).join(' ');
    const fullBashCmd = [
      'source /root/.nvm/nvm.sh 2>/dev/null',
      envExports,
      `claude ${claudeCmd}`,
    ].join('; ');

    const wslArgs = ['-d', distro, '--', 'bash', '-lc', fullBashCmd];

    console.error(`[WSL spawn] command: wsl`);
    console.error(`[WSL spawn] claude args: ${claudeCmd.substring(0, 120)}...`);
    console.error(`[WSL spawn] env vars: ${Object.keys(options.env).length}`);

    const proc = spawn('wsl', wslArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return proc;
  };
}

/**
 * 简易 shell 转义
 */
function shellescape(s: string): string {
  if (/[^A-Za-z0-9_\/:.\-]/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

/**
 * 通用 runQuery 封装
 */
async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  sandbox?: any;
  spawnFn?: (options: any) => ChildProcess;
}) {
  const sdkQuery = query({
    prompt: options.prompt,
    options: {
      env: options.env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      effort: 'low',
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
      ...(options.spawnFn ? { spawnClaudeCodeProcess: options.spawnFn } : {}),
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
  if (!existsSync(dir)) return { hasFiles: false };

  const allFiles = readdirSync(dir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));

  const requests: any[] = [];
  for (const f of requestFiles.sort()) {
    try {
      requests.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch { /* skip */ }
  }

  return {
    hasFiles: true,
    requestCount: requestFiles.length,
    firstRequest: requests[0] || null,
    tools: requests[0]?.tools || null,
    toolsCount: requests[0]?.tools?.length ?? 0,
  };
}

describe('Sandbox WSL2 Spawn 实验', () => {

  it('case-1 对照组：Windows 默认 spawn + sandbox.enabled=true → 抛异常', async () => {
    const dir = createTimestampDir('sandbox-wsl2/case-1-windows-sandbox');

    const { thrownError, events } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "test-1"',
      sandbox: { enabled: true },
      // 不设 spawnFn → 用 Windows 默认的 claude.exe
    });

    console.error('\n[case-1] Windows 默认 + sandbox.enabled=true');
    console.error('  thrownError:', thrownError?.message?.substring(0, 200) ?? 'none');

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain('windows is not supported');
  }, 120000);

  it('case-2 WSL2 spawn + 无 sandbox → 正常完成', async () => {
    const dir = createTimestampDir('sandbox-wsl2/case-2-wsl-baseline');

    const { thrownError, resultText, resultObj, events } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "wsl-test-ok"',
      spawnFn: createWslSpawn(WSL_DISTRO) as any,
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-2] WSL2 spawn + 无 sandbox');
    console.error('  thrownError:', thrownError?.message?.substring(0, 200) ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  result subtype:', resultObj?.subtype);
    console.error('  result text:', resultText.substring(0, 100));
    console.error('  events count:', events.length);
    console.error('  request files:', analysis.hasFiles ? analysis.requestCount : 0);

    // 核心断言：WSL2 spawn 应该正常工作
    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);

    if (analysis.hasFiles && analysis.requestCount > 0) {
      prettyFormatJsonFiles(dir);
    }
  }, 120000);

  it('case-3 WSL2 spawn + sandbox.enabled=true → 验证 sandbox 在 Linux 下是否生效', async () => {
    const dir = createTimestampDir('sandbox-wsl2/case-3-wsl-sandbox');

    const { thrownError, resultText, resultObj, events } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "wsl-sandbox-test"',
      spawnFn: createWslSpawn(WSL_DISTRO) as any,
      sandbox: { enabled: true },
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-3] WSL2 spawn + sandbox.enabled=true');
    console.error('  thrownError:', thrownError?.message?.substring(0, 200) ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  result subtype:', resultObj?.subtype);
    console.error('  result text:', resultText.substring(0, 100));
    console.error('  events count:', events.length);
    console.error('  request files:', analysis.hasFiles ? analysis.requestCount : 0);
    if (resultObj) {
      console.error('  resultObj keys:', Object.keys(resultObj).join(', '));
    }

    // 核心断言：WSL2 是 Linux 平台，sandbox.enabled=true 不会抛异常
    expect(thrownError).toBeNull();
    expect(resultObj?.type).toBe('result');
    expect(resultObj?.subtype).toBe('success');
    expect(resultText.trim().length).toBeGreaterThan(0);

    if (analysis.hasFiles && analysis.requestCount > 0) {
      prettyFormatJsonFiles(dir);
    }
  }, 120000);

  it('case-4 WSL2 spawn + sandbox 全配置 → 验证 filesystem/network 配置', async () => {
    const dir = createTimestampDir('sandbox-wsl2/case-4-wsl-sandbox-full');

    const { thrownError, resultText, resultObj, events } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "wsl-sandbox-full"',
      spawnFn: createWslSpawn(WSL_DISTRO) as any,
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          allowWrite: ['/tmp/wsl-test'],
        },
        network: {
          allowedDomains: ['example.com'],
        },
      },
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-4] WSL2 spawn + sandbox 全配置');
    console.error('  thrownError:', thrownError?.message?.substring(0, 200) ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  result subtype:', resultObj?.subtype);
    console.error('  result text:', resultText.substring(0, 100));
    console.error('  request files:', analysis.hasFiles ? analysis.requestCount : 0);

    // 核心断言：WSL2 + sandbox 全配置也能正常完成
    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);

    if (analysis.hasFiles && analysis.requestCount > 0) {
      prettyFormatJsonFiles(dir);
    }
  }, 120000);
});
