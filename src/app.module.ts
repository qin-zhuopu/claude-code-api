import { Module } from '@nestjs/common';
import { QueryModule } from './query/query.module';

@Module({
  imports: [QueryModule],
})
export class AppModule {}
