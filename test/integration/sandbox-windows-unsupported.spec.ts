/**
 * Sandbox Windows 不支持观察性测试
 *
 * 观察目标：
 * 1. Windows 上 sandbox.enabled=true 时 SDK 行为（报错？静默降级？结果消息？）
 * 2. failIfUnavailable=true/false 对 Windows 平台的影响
 * 3. sandbox 配置是否影响请求结构（tools/system prompt/messages）
 *
 * 文档声明：
 * - sandboxing.md: "supports macOS, Linux, and WSL2. WSL1 and native Windows are not supported."
 * - sandbox-environments.md: "This option does not support native Windows."
 * - sdk.d.ts: "failIfUnavailable defaults to true when enabled:true is passed via this option"
 *
 * 本机环境：原生 Windows（非 WSL）
 *
 * 实验矩阵：
 * | case | enabled | failIfUnavailable | 预期行为                          |
 * |------|---------|-------------------|-----------------------------------|
 * | 1    | 未设置  | -                 | 正常完成（基线）                   |
 * | 2    | true    | 默认(=true)       | 抛异常，Windows 不支持             |
 * | 3    | true    | false             | 降级，正常完成，sandbox 未实际启用  |
 * | 4    | true    | true（显式）       | 抛异常，Windows 不支持             |
 * | 5    | true    | false + 全配置    | 降级，正常完成                     |
 * | 6    | false   | -                 | 正常完成，等同基线                  |
 */
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
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

/**
 * 通用 runQuery 封装，收集流式事件和结果。
 * SDK 在 sandbox 不满足时会抛异常（不走 result 通道），
 * 所以此函数返回 error 字段而非 reject。
 */
async function runQuery(options: {
  env: Record<string, string | undefined>;
  prompt: string;
  sandbox?: any;
  tools?: any[];
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
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
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

/**
 * 从日志目录分析请求结构
 */
function analyzeRequestDir(dir: string) {
  if (!existsSync(dir)) return { hasFiles: false };

  const allFiles = readdirSync(dir);
  const requestFiles = allFiles.filter(f => f.endsWith('.request.json'));
  const responseFiles = allFiles.filter(f => f.endsWith('.response.json'));

  const requests: any[] = [];
  for (const f of requestFiles.sort()) {
    try {
      const content = readFileSync(join(dir, f), 'utf-8');
      requests.push(JSON.parse(content));
    } catch {
      // 截断文件，跳过
    }
  }

  const firstRequest = requests[0] || null;

  return {
    hasFiles: true,
    requestCount: requestFiles.length,
    responseCount: responseFiles.length,
    allFiles,
    requests,
    firstRequest,
    tools: firstRequest?.tools || null,
    toolsCount: firstRequest?.tools?.length ?? 0,
    systemBlocks: firstRequest?.system || null,
    systemBlocksCount: Array.isArray(firstRequest?.system) ? firstRequest.system.length : 0,
  };
}

describe('Sandbox - Windows 不支持', () => {
  it('case-1 基线：sandbox 不启用，正常请求', async () => {
    const dir = createTimestampDir('sandbox-windows/case-1-baseline');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-ok"',
    });

    const analysis = analyzeRequestDir(dir);
    console.error('\n[case-1] 基线（无 sandbox）');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  result subtype:', resultObj?.subtype);
    console.error('  request files:', analysis.requestCount);
    console.error('  tools count:', analysis.toolsCount);

    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);
    expect(analysis.hasFiles).toBe(true);
    expect(analysis.requestCount).toBeGreaterThanOrEqual(1);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-2 sandbox.enabled=true，failIfUnavailable 未设置（默认=true）→ 抛异常', async () => {
    const dir = createTimestampDir('sandbox-windows/case-2-enabled-default');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-2"',
      sandbox: { enabled: true },
    });

    console.error('\n[case-2] sandbox.enabled=true（默认 failIfUnavailable）');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  resultObj:', resultObj ? 'present' : 'null');
    console.error('  events count:', events.length);

    // 核心断言：Windows 上 sandbox.enabled=true + 默认 failIfUnavailable=true → 抛异常
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain('windows is not supported');
    expect(thrownError!.message).toContain('sandbox.enabled is set');
    expect(thrownError!.message).toContain('failIfUnavailable=false');

    // 异常时不会产出请求文件
    const analysis = analyzeRequestDir(dir);
    console.error('  request files:', analysis.hasFiles ? analysis.requestCount : 0);
    expect(analysis.hasFiles ? analysis.requestCount : 0).toBe(0);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-3 sandbox.enabled=true, failIfUnavailable=false → 降级运行', async () => {
    const dir = createTimestampDir('sandbox-windows/case-3-enabled-graceful');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-3"',
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
      },
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-3] sandbox.enabled=true, failIfUnavailable=false');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  result subtype:', resultObj?.subtype);
    console.error('  result text length:', resultText.length);
    console.error('  request files:', analysis.requestCount);
    console.error('  tools count:', analysis.toolsCount);
    if (resultObj) {
      console.error('  full resultObj keys:', Object.keys(resultObj));
    }

    // failIfUnavailable=false → 降级，不抛异常，正常完成
    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);
    expect(analysis.requestCount).toBeGreaterThanOrEqual(1);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-4 sandbox.enabled=true, failIfUnavailable=true（显式）→ 抛异常', async () => {
    const dir = createTimestampDir('sandbox-windows/case-4-enabled-hardfail');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-4"',
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
      },
    });

    console.error('\n[case-4] sandbox.enabled=true, failIfUnavailable=true（显式）');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  resultObj:', resultObj ? 'present' : 'null');

    // 与 case-2 行为一致：抛异常
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain('windows is not supported');

    const analysis = analyzeRequestDir(dir);
    expect(analysis.hasFiles ? analysis.requestCount : 0).toBe(0);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-5 sandbox 全配置 + failIfUnavailable=false → 降级运行', async () => {
    const dir = createTimestampDir('sandbox-windows/case-5-full-config');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-5"',
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          allowWrite: ['/tmp/test'],
          denyRead: ['~/.ssh'],
        },
        network: {
          allowedDomains: ['example.com'],
        },
      },
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-5] sandbox 全配置（filesystem + network）+ failIfUnavailable=false');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  request files:', analysis.requestCount);
    console.error('  tools count:', analysis.toolsCount);
    if (analysis.systemBlocks) {
      console.error('  system blocks count:', analysis.systemBlocksCount);
    }

    // 全配置也不影响降级行为
    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);
    expect(analysis.requestCount).toBeGreaterThanOrEqual(1);

    prettyFormatJsonFiles(dir);
  }, 120000);

  it('case-6 sandbox.enabled=false（显式禁用）→ 等同基线', async () => {
    const dir = createTimestampDir('sandbox-windows/case-6-explicit-disabled');

    const { events, resultText, resultObj, thrownError } = await runQuery({
      env: { ...BASE_ENV, OTEL_LOG_RAW_API_BODIES: `file:${dir}` },
      prompt: 'say "sandbox-test-6"',
      sandbox: {
        enabled: false,
      },
    });

    const analysis = analyzeRequestDir(dir);

    console.error('\n[case-6] sandbox.enabled=false（显式禁用）');
    console.error('  thrownError:', thrownError?.message ?? 'none');
    console.error('  result type:', resultObj?.type);
    console.error('  request files:', analysis.requestCount);
    console.error('  tools count:', analysis.toolsCount);

    // 显式 false 等同于基线
    expect(thrownError).toBeNull();
    expect(resultText.trim().length).toBeGreaterThan(0);
    expect(analysis.requestCount).toBeGreaterThanOrEqual(1);

    prettyFormatJsonFiles(dir);
  }, 120000);
});
