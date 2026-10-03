import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { SchedulingResolver } from './scheduling.resolver';

@Module({
  providers: [SchedulingService, SchedulingResolver],
  exports: [SchedulingService],
})
export class SchedulingModule {}
