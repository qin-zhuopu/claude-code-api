import { Controller, Sse, MessageEvent } from '@nestjs/common';
import { interval, Observable } from 'rxjs';
import { map, take } from 'rxjs/operators';

@Controller('events')
export class EventsController {
  @Sse('timer')
  sendTimer(): Observable<MessageEvent> {
    return interval(1000).pipe(
      take(5),
      map(() => ({ data: { timestamp: Date.now() } })),
    );
  }
}
