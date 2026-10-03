import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { TimeSlotsService } from './time-slots.service';
import { RoomsResolver } from './rooms.resolver';

@Module({
  providers: [RoomsService, TimeSlotsService, RoomsResolver],
  exports: [RoomsService, TimeSlotsService],
})
export class RoomsModule {}
