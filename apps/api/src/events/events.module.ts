import { PrismaService } from "../prisma/prisma.service";
import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsResolver } from './events.resolver';

@Module({
  providers: [EventsService, EventsResolver],
  exports: [EventsService],
})
export class EventsModule {}
