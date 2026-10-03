import { Module } from '@nestjs/common';
import { OperationsService } from './operations.service';
import { OperationsResolver } from './operations.resolver';

@Module({
  providers: [OperationsService, OperationsResolver],
  exports: [OperationsService],
})
export class OperationsModule {}
