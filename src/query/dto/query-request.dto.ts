import { IsOptional, IsString, IsBoolean, IsNotEmpty, IsArray, IsObject, IsNumber, IsEnum, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryOptionsDto {
  // ===== 会话 =====
  @IsOptional()
  @IsString()
  resume?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsBoolean()
  'continue'?: boolean;

  @IsOptional()
  @IsBoolean()
  forkSession?: boolean;

  @IsOptional()
  @IsString()
  resumeSessionAt?: string;

  @IsOptional()
  @IsBoolean()
  persistSession?: boolean;

  // ===== 模型 =====
  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  fallbackModel?: string;

  @IsOptional()
  effort?: any;

  @IsOptional()
  @IsNumber()
  maxThinkingTokens?: number;

  @IsOptional()
  thinking?: any;

  @IsOptional()
  @IsNumber()
  maxTurns?: number;

  @IsOptional()
  @IsNumber()
  maxBudgetUsd?: number;

  // ===== Agent =====
  @IsOptional()
  @IsString()
  agent?: string;

  @IsOptional()
  @IsObject()
  agents?: Record<string, any>;

  // ===== 工具 =====
  @IsOptional()
  @IsArray()
  allowedTools?: string[];

  @IsOptional()
  @IsArray()
  disallowedTools?: string[];

  @IsOptional()
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };

  @IsOptional()
  @IsObject()
  toolConfig?: Record<string, any>;

  @IsOptional()
  @IsArray()
  skills?: string[] | 'all';

  // ===== 权限 =====
  @IsOptional()
  @IsString()
  permissionMode?: string;

  @IsOptional()
  @IsString()
  planModeInstructions?: string;

  @IsOptional()
  @IsBoolean()
  allowDangerouslySkipPermissions?: boolean;

  @IsOptional()
  @IsString()
  permissionPromptToolName?: string;

  // ===== 流式输出 =====
  @IsOptional()
  @IsBoolean()
  includePartialMessages?: boolean;

  @IsOptional()
  @IsBoolean()
  includeHookEvents?: boolean;

  @IsOptional()
  @IsBoolean()
  forwardSubagentText?: boolean;

  @IsOptional()
  @IsBoolean()
  promptSuggestions?: boolean;

  @IsOptional()
  @IsBoolean()
  agentProgressSummaries?: boolean;

  // ===== 环境 =====
  @IsOptional()
  @IsString()
  cwd?: string;

  @IsOptional()
  @IsArray()
  additionalDirectories?: string[];

  @IsOptional()
  @IsObject()
  env?: Record<string, string | undefined>;

  @IsOptional()
  @IsString()
  executable?: 'bun' | 'deno' | 'node';

  @IsOptional()
  @IsArray()
  executableArgs?: string[];

  @IsOptional()
  @IsObject()
  extraArgs?: Record<string, string | null>;

  // ===== MCP =====
  @IsOptional()
  @IsObject()
  mcpServers?: Record<string, any>;

  // ===== 输出 =====
  @IsOptional()
  @IsObject()
  outputFormat?: { type: string; schema?: any };

  // ===== 其他 =====
  @IsOptional()
  @IsBoolean()
  enableFileCheckpointing?: boolean;

  @IsOptional()
  betas?: ('context-1m-2025-08-07')[];

  @IsOptional()
  @IsBoolean()
  debug?: boolean;

  @IsOptional()
  @IsString()
  debugFile?: string;

  @IsOptional()
  @IsObject()
  sandbox?: any;

  @IsOptional()
  settings?: string | Record<string, any>;

  @IsOptional()
  @IsObject()
  managedSettings?: Record<string, any>;

  @IsOptional()
  @IsArray()
  settingSources?: string[];

  @IsOptional()
  @IsObject()
  taskBudget?: { total: number };

  @IsOptional()
  @IsArray()
  plugins?: any[];
}

export class QueryRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QueryOptionsDto)
  options?: QueryOptionsDto;
}
