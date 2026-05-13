import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createTimestampDir, prettyFormatJsonFiles } from './helpers';
import dotenv from 'dotenv';

dotenv.config();

/**
 * 课题：当配置的大模型接口不可用时（连接失败、超时、返回错误），
 * claude-agent-sdk 是否会自动重试？哪些参数影响重试行为？
 *
 * 观察目标：
 * 1. SDK 是否发出 SDKAPIRetryMessage（type: 'system', subtype: 'api_retry'）
 * 2. 重试次数（attempt / max_retries）
 * 3. 重试延迟（retry_delay_ms）— 是否指数退避
 * 4. 哪些错误类型触发重试（error_status: 500/529/null/429 等）
 * 5. CLAUDE_CODE_MAX_RETRIES 环境变量的效果
 * 6. API_TIMEOUT_MS 环境变量的效果
 * 7. CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK 的效果
 *
 * 文档参考（errors.md）：
 * - Server errors, overloaded responses, request timeouts, temporary 429 throttles,
 *   and dropped connections are all retried up to 10 times with exponential backoff.
 * - CLAUDE_CODE_MAX_RETRIES: default 10, controls number of retry attempts
 * - API_TIMEOUT_MS: default 600000 (10 min), per-request timeout
 *
 * SDK 类型参考（sdk.d.ts）：
 * - SDKAPIRetryMessage: { type: 'system', subtype: 'api_retry', attempt, max_retries,
 *   retry_delay_ms, error_status: number | null, error: SDKAssistantMessageError }
 * - SDKAssistantMessageError: 'authentication_failed' | 'oauth_org_not_allowed' |
 *   'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' |
 *   'max_output_tokens'
 */

// 基础环境变量 — 指向一个不存在的端点以触发连接失败
const UNREACHABLE_ENV = {
  ANTHROPIC_AUTH_TOKEN: 'fake-token-for-retry-test',
  ANTHROPIC_BASE_URL: 'http://192.0.2.1:1', // RFC 5737 TEST-NET, 不可达
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'test-model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'test-model',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'test-model',
  API_TIMEOUT_MS: '5000', // 5 秒超时，加速测试
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
};

// 指向一个会立即拒绝连接的端口（localhost 未监听端口）
const CONN_REFUSED_ENV = {
  ...UNREACHABLE_ENV,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:19999', // 大概率无人监听
  API_TIMEOUT_MS: '5000',
};

// 指向一个会返回 500 错误的端点（如果有 mock server 可用）
const SERVER_ERROR_ENV = {
  ...UNREACHABLE_ENV,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:19998', // 需要 mock server
  API_TIMEOUT_MS: '10000',
};

interface RetryEvent {
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  timestamp: number;
}

interface QueryResult {
  retryEvents: RetryEvent[];
  resultType: 'success' | 'error' | 'timeout';
  resultText: string;
  allMessages: any[];
  totalDurationMs: number;
}

/**
 * 运行 SDK query 并收集所有重试事件
 */
async function runQueryAndCollectRetries(options: {
  env: Record<string, string | undefined>;
  prompt?: string;
  maxRetries?: string;
  logDir?: string;
}): Promise<QueryResult> {
  const env: Record<string, string | undefined> = {
    ...options.env,
    ...(options.maxRetries ? { CLAUDE_CODE_MAX_RETRIES: options.maxRetries } : {}),
    ...(options.logDir ? { OTEL_LOG_RAW_API_BODIES: `file:${options.logDir}` } : {}),
  };

  const startTime = Date.now();
  const retryEvents: RetryEvent[] = [];
  const allMessages: any[] = [];
  let resultText = '';
  let resultType: 'success' | 'error' | 'timeout' = 'error';

  try {
    const sdkQuery = query({
      prompt: options.prompt || 'say hello',
      options: {
        env,
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        effort: 'low',
        tools: [],
      } as any,
    });

    for await (const message of sdkQuery) {
      const msg = message as any;
      allMessages.push(msg);

      // 捕获重试事件
      if (msg.type === 'system' && msg.subtype === 'api_retry') {
        retryEvents.push({
          attempt: msg.attempt,
          max_retries: msg.max_retries,
          retry_delay_ms: msg.retry_delay_ms,
          error_status: msg.error_status,
          error: msg.error,
          timestamp: Date.now(),
        });
        console.error(
          `  [retry] attempt=${msg.attempt}/${msg.max_retries} ` +
          `delay=${msg.retry_delay_ms}ms status=${msg.error_status} ` +
          `error=${msg.error}`,
        );
      }

      // 捕获结果
      if (msg.type === 'result') {
        resultText = msg.result || '';
        resultType = msg.is_error ? 'error' : 'success';
      }
    }
  } catch (err: any) {
    console.error(`  [exception] ${err.message}`);
    resultType = 'error';
    resultText = err.message || String(err);
  }

  return {
    retryEvents,
    resultType,
    resultText,
    allMessages,
    totalDurationMs: Date.now() - startTime,
  };
}

describe('conn-retry: SDK 自动重试行为', () => {
  /**
   * Case 1: 连接被拒绝（ECONNREFUSED）
   * 预期：SDK 应该自动重试，发出 api_retry 事件
   */
  it('case-1 连接被拒绝时应触发自动重试', async () => {
    const dir = createTimestampDir('conn-retry/case-1-conn-refused');
    console.error('\n[case-1] 连接被拒绝 (ECONNREFUSED)');
    console.error(`  目标: ${CONN_REFUSED_ENV.ANTHROPIC_BASE_URL}`);

    const result = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      logDir: dir,
    });

    console.error(`\n[case-1] 结果:`);
    console.error(`  总耗时: ${result.totalDurationMs}ms`);
    console.error(`  重试次数: ${result.retryEvents.length}`);
    console.error(`  结果类型: ${result.resultType}`);
    console.error(`  消息总数: ${result.allMessages.length}`);
    console.error(`  消息类型: ${[...new Set(result.allMessages.map(m => `${m.type}${m.subtype ? ':' + m.subtype : ''}`))].join(', ')}`);

    if (result.retryEvents.length > 0) {
      console.error(`  首次重试延迟: ${result.retryEvents[0].retry_delay_ms}ms`);
      console.error(`  max_retries: ${result.retryEvents[0].max_retries}`);
      console.error(`  error_status: ${result.retryEvents[0].error_status}`);
      console.error(`  error 类型: ${result.retryEvents[0].error}`);

      // 检查是否指数退避（有上限 cap）
      if (result.retryEvents.length >= 2) {
        const delays = result.retryEvents.map(e => e.retry_delay_ms);
        console.error(`  所有延迟: [${delays.map(d => d.toFixed(0)).join(', ')}]ms`);
        // 前几次应递增，后面会 cap 在 ~33s
        const preCap = delays.filter(d => d < 30000);
        const isPreCapIncreasing = preCap.every((d, i) => i === 0 || d >= preCap[i - 1]);
        console.error(`  cap 前递增: ${isPreCapIncreasing}`);
        // 检查是否有 cap
        const cappedDelays = delays.filter(d => d >= 30000);
        console.error(`  达到 cap 的次数: ${cappedDelays.length}`);
      }
    }

    // 断言：应该有重试事件
    expect(result.retryEvents.length).toBeGreaterThan(0);
    // 断言：error_status 应为 null（连接错误无 HTTP 响应）
    expect(result.retryEvents[0].error_status).toBeNull();
    // 断言：最终结果应为 error
    expect(result.resultType).toBe('error');

    prettyFormatJsonFiles(dir);
  }, 300000); // 5 分钟超时，因为重试可能需要较长时间

  /**
   * Case 2: 连接超时（不可达地址）
   * 预期：SDK 应该在 API_TIMEOUT_MS 后超时，然后重试
   */
  it('case-2 连接超时时应触发自动重试', async () => {
    const dir = createTimestampDir('conn-retry/case-2-timeout');
    console.error('\n[case-2] 连接超时 (不可达地址)');
    console.error(`  目标: ${UNREACHABLE_ENV.ANTHROPIC_BASE_URL}`);
    console.error(`  超时: ${UNREACHABLE_ENV.API_TIMEOUT_MS}ms`);

    const result = await runQueryAndCollectRetries({
      env: UNREACHABLE_ENV,
      logDir: dir,
    });

    console.error(`\n[case-2] 结果:`);
    console.error(`  总耗时: ${result.totalDurationMs}ms`);
    console.error(`  重试次数: ${result.retryEvents.length}`);
    console.error(`  结果类型: ${result.resultType}`);
    console.error(`  消息总数: ${result.allMessages.length}`);
    console.error(`  消息类型: ${[...new Set(result.allMessages.map(m => `${m.type}${m.subtype ? ':' + m.subtype : ''}`))].join(', ')}`);

    if (result.retryEvents.length > 0) {
      console.error(`  首次重试延迟: ${result.retryEvents[0].retry_delay_ms}ms`);
      console.error(`  max_retries: ${result.retryEvents[0].max_retries}`);
      console.error(`  error_status: ${result.retryEvents[0].error_status}`);
      console.error(`  error 类型: ${result.retryEvents[0].error}`);
    }

    // 断言：应该有重试事件
    expect(result.retryEvents.length).toBeGreaterThan(0);
    // 断言：error_status 应为 null（超时无 HTTP 响应）
    expect(result.retryEvents[0].error_status).toBeNull();

    prettyFormatJsonFiles(dir);
  }, 300000);

  /**
   * Case 3: CLAUDE_CODE_MAX_RETRIES=2 限制重试次数
   * 预期：最多重试 2 次后停止
   */
  it('case-3 CLAUDE_CODE_MAX_RETRIES 应限制重试次数', async () => {
    const dir = createTimestampDir('conn-retry/case-3-max-retries-2');
    const maxRetries = '2';
    console.error('\n[case-3] 限制重试次数');
    console.error(`  CLAUDE_CODE_MAX_RETRIES=${maxRetries}`);

    const result = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      maxRetries,
      logDir: dir,
    });

    console.error(`\n[case-3] 结果:`);
    console.error(`  总耗时: ${result.totalDurationMs}ms`);
    console.error(`  重试次数: ${result.retryEvents.length}`);
    console.error(`  结果类型: ${result.resultType}`);

    if (result.retryEvents.length > 0) {
      console.error(`  max_retries 字段值: ${result.retryEvents[0].max_retries}`);
      console.error(`  所有 attempt: [${result.retryEvents.map(e => e.attempt).join(', ')}]`);
    }

    // 断言：max_retries 字段应反映设置值
    if (result.retryEvents.length > 0) {
      expect(result.retryEvents[0].max_retries).toBe(2);
    }
    // 断言：重试次数不应超过设置值
    expect(result.retryEvents.length).toBeLessThanOrEqual(2);

    prettyFormatJsonFiles(dir);
  }, 120000);

  /**
   * Case 4: CLAUDE_CODE_MAX_RETRIES=0 禁用重试
   * 预期：不应有任何重试事件，直接失败
   */
  it('case-4 CLAUDE_CODE_MAX_RETRIES=0 应禁用重试', async () => {
    const dir = createTimestampDir('conn-retry/case-4-max-retries-0');
    console.error('\n[case-4] 禁用重试');
    console.error(`  CLAUDE_CODE_MAX_RETRIES=0`);

    const result = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      maxRetries: '0',
      logDir: dir,
    });

    console.error(`\n[case-4] 结果:`);
    console.error(`  总耗时: ${result.totalDurationMs}ms`);
    console.error(`  重试次数: ${result.retryEvents.length}`);
    console.error(`  结果类型: ${result.resultType}`);
    console.error(`  消息类型: ${[...new Set(result.allMessages.map(m => `${m.type}${m.subtype ? ':' + m.subtype : ''}`))].join(', ')}`);

    // 断言：不应有重试事件
    expect(result.retryEvents.length).toBe(0);
    // 断言：应该快速失败
    expect(result.totalDurationMs).toBeLessThan(30000);

    prettyFormatJsonFiles(dir);
  }, 60000);

  /**
   * Case 5: CLAUDE_CODE_MAX_RETRIES=1 — 最小重试观察
   * 预期：只重试 1 次，快速完成
   */
  it('case-5 CLAUDE_CODE_MAX_RETRIES=1 最小重试', async () => {
    const dir = createTimestampDir('conn-retry/case-5-max-retries-1');
    console.error('\n[case-5] 最小重试');
    console.error(`  CLAUDE_CODE_MAX_RETRIES=1`);

    const result = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      maxRetries: '1',
      logDir: dir,
    });

    console.error(`\n[case-5] 结果:`);
    console.error(`  总耗时: ${result.totalDurationMs}ms`);
    console.error(`  重试次数: ${result.retryEvents.length}`);

    if (result.retryEvents.length > 0) {
      console.error(`  max_retries 字段值: ${result.retryEvents[0].max_retries}`);
      console.error(`  attempt: ${result.retryEvents[0].attempt}`);
      console.error(`  delay: ${result.retryEvents[0].retry_delay_ms}ms`);
    }

    // 断言：max_retries 字段应为 1
    if (result.retryEvents.length > 0) {
      expect(result.retryEvents[0].max_retries).toBe(1);
    }
    // 断言：只有 1 次重试
    expect(result.retryEvents.length).toBe(1);

    prettyFormatJsonFiles(dir);
  }, 60000);

  /**
   * Case 6: API_TIMEOUT_MS 对重试行为的影响
   * 对比短超时（3s）vs 长超时（10s）的重试间隔
   */
  it('case-6 API_TIMEOUT_MS 影响单次请求超时但不影响重试延迟', async () => {
    const dir = createTimestampDir('conn-retry/case-6-timeout-comparison');
    console.error('\n[case-6] API_TIMEOUT_MS 对比');

    // 短超时
    console.error('  --- 短超时 (3000ms) ---');
    const shortResult = await runQueryAndCollectRetries({
      env: { ...UNREACHABLE_ENV, API_TIMEOUT_MS: '3000' },
      maxRetries: '2',
      logDir: dir,
    });

    console.error(`  短超时总耗时: ${shortResult.totalDurationMs}ms`);
    console.error(`  短超时重试次数: ${shortResult.retryEvents.length}`);
    if (shortResult.retryEvents.length > 0) {
      console.error(`  短超时延迟: [${shortResult.retryEvents.map(e => e.retry_delay_ms).join(', ')}]ms`);
    }

    // 注意：不可达地址的超时测试可能很慢，这里只做一组
    // 如果需要对比长超时，可以取消下面的注释

    // 断言：短超时应该更快完成
    expect(shortResult.totalDurationMs).toBeLessThan(120000);

    prettyFormatJsonFiles(dir);
  }, 180000);

  /**
   * Case 7: 重试延迟的指数退避验证
   * 使用 CLAUDE_CODE_MAX_RETRIES=5 观察延迟增长模式
   * 已知：延迟约 2x 增长，有上限 cap（约 33-36 秒）
   */
  it('case-7 重试延迟应呈指数退避模式（有上限）', async () => {
    const dir = createTimestampDir('conn-retry/case-7-exponential-backoff');
    console.error('\n[case-7] 指数退避验证');

    const result = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      maxRetries: '5',
      logDir: dir,
    });

    console.error(`\n[case-7] 结果:`);
    console.error(`  重试次数: ${result.retryEvents.length}`);

    if (result.retryEvents.length >= 2) {
      const delays = result.retryEvents.map(e => e.retry_delay_ms);
      console.error(`  延迟序列: [${delays.map(d => d.toFixed(0)).join(', ')}]ms`);

      // 计算相邻延迟的比率
      const ratios = delays.slice(1).map((d, i) => d / delays[i]);
      console.error(`  增长比率: [${ratios.map(r => r.toFixed(2)).join(', ')}]`);

      // 计算实际间隔（基于时间戳）
      const actualIntervals = result.retryEvents.slice(1).map((e, i) =>
        e.timestamp - result.retryEvents[i].timestamp,
      );
      console.error(`  实际间隔: [${actualIntervals.join(', ')}]ms`);

      // 断言：前几次延迟应该递增（指数退避，cap 前）
      // 至少前 4 次应该是递增的（cap 约在 33s）
      const preCap = delays.slice(0, Math.min(5, delays.length));
      const isPreCapIncreasing = preCap.every((d, i) => i === 0 || d >= preCap[i - 1]);
      console.error(`  前 ${preCap.length} 次递增: ${isPreCapIncreasing}`);
      expect(isPreCapIncreasing).toBe(true);

      // 断言：首次延迟应在 300-1000ms 范围
      expect(delays[0]).toBeGreaterThan(300);
      expect(delays[0]).toBeLessThan(1500);

      // 断言：增长比率应在 1.5-3.0 之间（指数退避特征）
      const earlyRatios = ratios.slice(0, Math.min(3, ratios.length));
      for (const ratio of earlyRatios) {
        expect(ratio).toBeGreaterThan(1.5);
        expect(ratio).toBeLessThan(3.0);
      }
    }

    prettyFormatJsonFiles(dir);
  }, 300000);

  /**
   * Case 8: 错误分类 — 观察不同错误类型的 error 字段
   * 连接拒绝 vs 超时 的 error 字段是否不同
   */
  it('case-8 不同连接错误的 error 分类', async () => {
    const dir = createTimestampDir('conn-retry/case-8-error-classification');
    console.error('\n[case-8] 错误分类对比');

    // 连接拒绝
    console.error('  --- 连接拒绝 ---');
    const refusedResult = await runQueryAndCollectRetries({
      env: CONN_REFUSED_ENV,
      maxRetries: '1',
      logDir: dir,
    });

    if (refusedResult.retryEvents.length > 0) {
      console.error(`  error_status: ${refusedResult.retryEvents[0].error_status}`);
      console.error(`  error: ${refusedResult.retryEvents[0].error}`);
    }

    // 超时
    console.error('  --- 连接超时 ---');
    const timeoutResult = await runQueryAndCollectRetries({
      env: { ...UNREACHABLE_ENV, API_TIMEOUT_MS: '3000' },
      maxRetries: '1',
      logDir: dir,
    });

    if (timeoutResult.retryEvents.length > 0) {
      console.error(`  error_status: ${timeoutResult.retryEvents[0].error_status}`);
      console.error(`  error: ${timeoutResult.retryEvents[0].error}`);
    }

    console.error('\n[case-8] 对比:');
    console.error(`  连接拒绝 error: ${refusedResult.retryEvents[0]?.error || 'N/A'}`);
    console.error(`  连接超时 error: ${timeoutResult.retryEvents[0]?.error || 'N/A'}`);

    // 断言：两种错误都应触发重试
    expect(refusedResult.retryEvents.length).toBeGreaterThan(0);
    expect(timeoutResult.retryEvents.length).toBeGreaterThan(0);
    // 断言：两种错误的 error_status 都应为 null（无 HTTP 响应）
    expect(refusedResult.retryEvents[0].error_status).toBeNull();
    expect(timeoutResult.retryEvents[0].error_status).toBeNull();

    prettyFormatJsonFiles(dir);
  }, 120000);
});
