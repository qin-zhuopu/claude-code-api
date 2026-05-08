import { Controller, Post, Body, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { QueryService } from './query.service';
import { QueryRequestDto, InterruptRequestDto } from './dto';

@Controller('api/query')
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

  /**
   * 执行查询 - SSE 流式响应
   */
  @Post()
  async query(@Body() dto: QueryRequestDto, @Res() res: Response) {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 执行查询
    const stream$ = this.queryService.execute(dto.prompt, dto.options);

    // 订阅流并发送 SSE 事件
    const subscription = stream$.subscribe({
      next: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error) => {
        console.error('Query error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || 'Unknown error' })}\n\n`);
        res.end();
      },
      complete: () => {
        res.end();
      },
    });

    // 处理客户端断开连接
    res.on('close', () => {
      subscription.unsubscribe();
    });
  }

  /**
   * 中断查询
   */
  @Post('interrupt')
  async interrupt(@Body() dto: InterruptRequestDto) {
    try {
      await this.queryService.interrupt(dto.sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to interrupt',
      };
    }
  }

  /**
   * 获取活跃查询统计
   */
  @Post('stats')
  async stats() {
    return {
      activeQueries: this.queryService.getActiveCount(),
    };
  }
}
