import { Module } from '@nestjs/common';
import { QueryModule } from './query/query.module';
import { EventsModule } from './events/events.module';

@Module({
  imports: [QueryModule, EventsModule],
})
export class AppModule {}
