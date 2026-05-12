import { Injectable } from '@nestjs/common';
import { query, Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { Observable } from 'rxjs';
import { QueryEventData, QueryOptionsDto } from './dto';

@Injectable()
export class QueryService {
  private activeQueries = new Map<string, Query>();

  /**
   * 执行查询并返回 SSE 流
   */
  execute(prompt: string, options?: QueryOptionsDto): Observable<QueryEventData> {
    const sessionId = this.generateSessionId();
    const abortController = new AbortController();

    return new Observable<QueryEventData>((subscriber) => {
      // 执行 SDK query
      const sdkQuery = query({
        prompt,
        options: {
          ...options,
          abortController,
          includePartialMessages: options?.includePartialMessages ?? false,
        } as Options,
      });

      // 保存活跃查询
      this.activeQueries.set(sessionId, sdkQuery);

      // 处理流式消息
      this.processStream(sdkQuery, subscriber)
        .catch((error) => {
          subscriber.error({
            type: 'error',
            error: error.message || 'Unknown error',
          });
        })
        .finally(() => {
          this.activeQueries.delete(sessionId);
          subscriber.complete();
        });

      // 清理函数
      return () => {
        abortController.abort();
        this.activeQueries.delete(sessionId);
      };
    });
  }

  /**
   * 中断查询
   */
  async interrupt(sessionId: string): Promise<void> {
    const activeQuery = this.activeQueries.get(sessionId);
    if (!activeQuery) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await activeQuery.interrupt();
    this.activeQueries.delete(sessionId);
  }

  /**
   * 处理 SDK 返回的 AsyncGenerator
   */
  private async processStream(
    sdkQuery: Query,
    subscriber: any,
  ): Promise<void> {
    try {
      for await (const message of sdkQuery) {
        const event = this.messageToEvent(message);
        subscriber.next(event);
      }

      // 发送完成事件
      subscriber.next({ type: 'done' });
    } catch (error) {
      subscriber.next({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 将 SDK 消息转换为 SSE 事件
   */
  private messageToEvent(message: any): QueryEventData {
    // 优先检测 stream_event（includePartialMessages 开启时的流式消息）
    // SDK yield 的 message 可能是序列化后的字符串，需要判断
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'stream_event') {
          return { type: 'partial', content: message };
        }
      } catch {}
      return { type: 'text', content: message };
    }

    if (message.type === 'stream_event') {
      return { type: 'partial', content: JSON.stringify(message) };
    }

    return { type: 'text', content: JSON.stringify(message) };
  }

  /**
   * 生成会话 ID
   */
  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 获取活跃查询数量
   */
  getActiveCount(): number {
    return this.activeQueries.size;
  }
}
