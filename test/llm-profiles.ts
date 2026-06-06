import dotenv from 'dotenv';

dotenv.config();

export interface LlmProfile {
  baseUrl: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  tokenEnvVar: string | null; // null means hardcoded token
  hardcodedToken?: string; // only for conn-retry profiles
  apiTimeout: string;
}

export const COMMON_BEHAVIOR_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
} as const;

export const PROFILES = {
  local: {
    baseUrl: 'http://10.1.3.115:4000',
    opusModel: 'Jereh-LLM-NO-THINK-V1',
    sonnetModel: 'Jereh-LLM-NO-THINK-V1',
    haikuModel: 'Jereh-LLM-NO-THINK-V1',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN_LOCAL',
    apiTimeout: '3000000',
  },
  bigmodel: {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    opusModel: 'glm-4.7',
    sonnetModel: 'glm-4.7',
    haikuModel: 'glm-4.5-air',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN_BIGMODEL',
    apiTimeout: '3000000',
  },
  jereh: {
    baseUrl: 'http://aiproxy.jereh.cn:4000',
    opusModel: 'Jereh-qwen3.6-plus',
    sonnetModel: 'Jereh-qwen3.6-plus',
    haikuModel: 'Jereh-qwen3.5-flash',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN_JEREH',
    apiTimeout: '3000000',
  },
  'conn-retry-unreachable': {
    baseUrl: 'http://192.0.2.1:1',
    opusModel: 'test-model',
    sonnetModel: 'test-model',
    haikuModel: 'test-model',
    tokenEnvVar: null,
    hardcodedToken: 'fake-token-for-retry-test',
    apiTimeout: '5000',
  },
  'conn-retry-refused': {
    baseUrl: 'http://127.0.0.1:19999',
    opusModel: 'test-model',
    sonnetModel: 'test-model',
    haikuModel: 'test-model',
    tokenEnvVar: null,
    hardcodedToken: 'fake-token-for-retry-test',
    apiTimeout: '5000',
  },
  'conn-retry-server-error': {
    baseUrl: 'http://127.0.0.1:19998',
    opusModel: 'test-model',
    sonnetModel: 'test-model',
    haikuModel: 'test-model',
    tokenEnvVar: null,
    hardcodedToken: 'fake-token-for-retry-test',
    apiTimeout: '10000',
  },
} as const satisfies Record<string, LlmProfile>;

export type ProfileName = keyof typeof PROFILES;

export function getProfileEnv(
  profileName: ProfileName,
  options?: {
    includeBehaviorEnv?: boolean;
    overrides?: Record<string, string | undefined>;
  },
): Record<string, string | undefined> {
  const profile = PROFILES[profileName];
  const includeBehaviorEnv = options?.includeBehaviorEnv ?? true;

  const token =
    profile.tokenEnvVar !== null
      ? process.env[profile.tokenEnvVar]
      : profile.hardcodedToken;

  const env: Record<string, string | undefined> = {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.haikuModel,
    API_TIMEOUT_MS: profile.apiTimeout,
  };

  if (includeBehaviorEnv) {
    Object.assign(env, COMMON_BEHAVIOR_ENV);
  }

  if (options?.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }

  return env;
}
