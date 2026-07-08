/**
 * LLM 环境配置组加载器
 *
 * .env 文件中以 `{GROUP}__KEY=VALUE` 格式定义的配置组，
 * 通过 `loadEnvGroup('jereh')` 一行加载为 `{ key: value }` 对象。
 *
 * 示例 .env:
 *   JEREH__ANTHROPIC_AUTH_TOKEN=sk-xxx
 *   JEREH__ANTHROPIC_BASE_URL=http://aiproxy.jereh.cn:4000
 *
 * 使用:
 *   const env = loadEnvGroup('jereh')
 *   // => { ANTHROPIC_AUTH_TOKEN: 'sk-xxx', ANTHROPIC_BASE_URL: 'http://aiproxy.jereh.cn:4000' }
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

/**
 * 解析 .env 文件，提取指定前缀的配置组
 */
export function loadEnvGroup(group: string): Record<string, string> {
  // 确保 dotenv 已加载
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  const prefix = `${group.toUpperCase()}__`;
  const result: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(process.env)) {
    if (rawKey.startsWith(prefix) && typeof value === 'string') {
      const key = rawKey.slice(prefix.length);
      result[key] = value;
    }
  }

  return result;
}

/**
 * 合并默认值，确保必填字段有 fallback
 */
export function loadEnvGroupWithDefaults(
  group: string,
  defaults: Record<string, string> = {},
): Record<string, string> {
  return {
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    ...defaults,
    ...loadEnvGroup(group),
  };
}
