import { Module } from '@nestjs/common';
import { TracksService } from './tracks.service';
import { TracksResolver } from './tracks.resolver';

@Module({
  providers: [TracksService, TracksResolver],
  exports: [TracksService],
})
export class TracksModule {}
