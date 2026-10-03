import { Module } from '@nestjs/common';
import { RankingsService } from './rankings.service';
import { RankingsResolver } from './rankings.resolver';

@Module({
  providers: [RankingsService, RankingsResolver],
  exports: [RankingsService],
})
export class RankingsModule {}
