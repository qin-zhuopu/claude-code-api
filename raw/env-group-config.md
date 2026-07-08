# Env 配置组机制

> 调研人：Claude Code
> 日期：2026-07-08
> 状态：已实现

---

## 核心机制

在 `.env` 文件中用 `{GROUP}__KEY=VALUE` 格式定义配置组，通过 `loadEnvGroup()` 一行加载为 `{ key: value }` 对象。

### 示例 .env

```bash
# Jereh Proxy 环境
JEREH__ANTHROPIC_AUTH_TOKEN=sk-xxx
JEREH__ANTHROPIC_BASE_URL=http://aiproxy.jereh.cn:4000
JEREH__ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.6-opus
JEREH__ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.6-sonnet
JEREH__ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-haiku

# Anthropic 直连环境
ANTHROPIC__ANTHROPIC_AUTH_TOKEN=sk-ant-xxx
ANTHROPIC__ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### 使用方式

```typescript
import { loadEnvGroup, loadEnvGroupWithDefaults } from './env-groups';

// 基础用法：只加载配置组
const jerehEnv = loadEnvGroup('jereh');
// => { ANTHROPIC_AUTH_TOKEN: 'sk-xxx', ANTHROPIC_BASE_URL: 'http://aiproxy.jereh.cn:4000', ... }

// 推荐用法：带默认值
const env = loadEnvGroupWithDefaults('jereh');
// => 包含超时、遥测等默认配置 + JEREH__ 前缀的配置
```

### loadEnvGroupWithDefaults 默认值

```typescript
{
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
  // ... loadEnvGroup(group) 的配置覆盖/合并
}
```

### 解析规则

1. 自动加载项目根目录 `.env` 文件
2. 匹配 `{GROUP}__` 前缀的环境变量（大小写不敏感，group 转大写匹配）
3. 去除前缀后返回剩余 key
4. `loadEnvGroupWithDefaults` 先合并默认值，再被配置组覆盖

---

## 实际应用

### 在测试用例中使用

```typescript
import { loadEnvGroupWithDefaults } from './env-groups';

describe('My Test', () => {
  it('case-1 test', async () => {
    const dir = createTimestampDir('my-test/case-1');
    const env = loadEnvGroupWithDefaults('jereh');

    const sdkQuery = query({
      prompt: 'Hello',
      options: {
        env: {
          ...env,
          OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
        },
        // ...
      },
    });
    // ...
  });
});
```

### 多环境切换

只需修改 `.env` 中的配置组定义，测试代码无需改动：

```typescript
// 切换到 Anthropic 直连
const env = loadEnvGroupWithDefaults('anthropic');

// 切换到 Jereh Proxy
const env = loadEnvGroupWithDefaults('jereh');
```

---

## 测试文件

| 文件 | 内容 |
|------|------|
| `test/integration/env-groups.ts` | `loadEnvGroup()` 和 `loadEnvGroupWithDefaults()` 实现 |
