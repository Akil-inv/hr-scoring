import { Module } from '@nestjs/common';
import { ConflictsService } from './conflicts.service';
import { ConflictsResolver } from './conflicts.resolver';

@Module({
  providers: [ConflictsService, ConflictsResolver],
  exports: [ConflictsService],
})
export class ConflictsModule {}
