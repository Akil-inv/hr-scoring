import { Module } from '@nestjs/common';
import { ScorecardsService } from './scorecards.service';
import { ScorecardsResolver } from './scorecards.resolver';
import { RankingsModule } from '../rankings/rankings.module';
import { ScoringCoreService } from './scoring-core.service';

@Module({
  imports: [RankingsModule],
  providers: [ScorecardsService, ScorecardsResolver, ScoringCoreService],
  exports: [ScorecardsService],
})
export class ScorecardsModule {}
