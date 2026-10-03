import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { InterviewScheduleController } from './interview-schedule.controller';
import { InterviewScheduleService } from './interview-schedule.service';

@Module({
  imports: [MulterModule.register({ storage: require('multer').memoryStorage() })],
  providers: [InterviewScheduleService],
  controllers: [InterviewScheduleController],
})
export class InterviewScheduleModule {}
