import { Module } from '@nestjs/common';
import { ReviewModule } from '../review/review.module';
import { EventControlResolver } from './event-control.resolver';
import { EventControlService } from './event-control.service';

@Module({
  imports: [ReviewModule],
  providers: [EventControlService, EventControlResolver],
  exports: [EventControlService],
})
export class EventControlModule {}
