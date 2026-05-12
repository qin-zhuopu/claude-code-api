export interface QueryEventData {
  type: 'text' | 'partial' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
}

export interface InterruptRequestDto {
  sessionId: string;
}
