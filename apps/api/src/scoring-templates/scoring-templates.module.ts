import { Module } from '@nestjs/common';
import { ScoringTemplatesService } from './scoring-templates.service';
import { ScoringTemplatesResolver } from './scoring-templates.resolver';

@Module({
  providers: [ScoringTemplatesService, ScoringTemplatesResolver],
  exports: [ScoringTemplatesService],
})
export class ScoringTemplatesModule {}
