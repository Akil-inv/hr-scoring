import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { JudgePortalModule } from '../judge-portal/judge-portal.module';
@Module({ imports: [JudgePortalModule], controllers: [NotificationController] })
export class NotificationModule {}
