import { Module } from '@nestjs/common';
import { JudgePortalService } from './judge-portal.service';
import { JudgePortalResolver } from './judge-portal.resolver';
import { JudgePortalController } from './judge-portal.controller';
import { JudgeLinksController } from './judge-links.controller';
import { ScorecardsModule } from '../scorecards/scorecards.module';
import { ScoringCoreService } from '../scorecards/scoring-core.service';

@Module({
  imports: [ScorecardsModule],
  providers: [JudgePortalService, JudgePortalResolver, ScoringCoreService],
  controllers: [JudgePortalController, JudgeLinksController],
  exports: [JudgePortalService],
})
export class JudgePortalModule {}
