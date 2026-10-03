import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { TeamsService } from './teams.service';
import { TeamsResolver } from './teams.resolver';
import { TeamsImportController } from './teams-import.controller';

@Module({
  imports: [MulterModule.register({ storage: require('multer').memoryStorage() })],
  providers: [TeamsService, TeamsResolver],
  controllers: [TeamsImportController],
  exports: [TeamsService],
})
export class TeamsModule {}
