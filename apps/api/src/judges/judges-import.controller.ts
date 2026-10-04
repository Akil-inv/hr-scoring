import { Controller, Post, UploadedFile, UseInterceptors, Body, UseGuards, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parseSpreadsheet } from '../common/spreadsheet';
import { JudgesService } from './judges.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EventAccessService, EventCheckedInHandler } from '../auth/event-access';

@Controller('api/import')
@EventCheckedInHandler()
export class JudgesImportController {
  constructor(private judgesService: JudgesService, private access: EventAccessService) {}

  @Post('judges')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async importJudges(
    @UploadedFile() file: Express.Multer.File,
    @Body('eventId') eventId: string,
    @Req() req: any,
  ) {
    await this.access.assert(req.user, typeof eventId === 'string' ? eventId : '', ['ADMIN', 'COORDINATOR']);
    const rows = parseSpreadsheet(file);
    const userId = req.user?.sub || req.user?.id;
    return this.judgesService.importFromCsv(eventId, rows, userId);
  }
}
