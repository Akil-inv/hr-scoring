import { Controller, Post, UploadedFile, UseInterceptors, Body, UseGuards, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parseSpreadsheet } from '../common/spreadsheet';
import { JudgesService } from './judges.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Judge availability import.
 *
 * A separate upload from the judges list, because availability is collected
 * later and changes more often — a judge confirmed in July may drop a morning
 * in August, and re-importing the whole judges file to record that would
 * overwrite tier, contact details and session limits alongside it.
 *
 * The file is the matrix. One row per judge per day they can attend:
 *
 *     email,                    date,        session
 *     priya.menon@uob.com,      2026-08-28,  AM
 *     priya.menon@uob.com,      2026-08-31,  BOTH
 *     wei.lin@uob.com,          2026-09-01,  PM
 *
 * A judge who does not appear for a given day is not available that day. That
 * is the point of requiring the file: an absent row means absent, not
 * "unknown, assume free". Scheduling someone who is not there is worse than
 * refusing to schedule someone who is.
 */
@Controller('api/import')
export class AvailabilityImportController {
  constructor(private judgesService: JudgesService) {}

  @Post('availability')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async importAvailability(
    @UploadedFile() file: Express.Multer.File,
    @Body('eventId') eventId: string,
    @Req() req: any,
  ) {
    const rows = parseSpreadsheet(file);
    const userId = req.user?.sub || req.user?.id;
    return this.judgesService.importAvailability(eventId, rows, userId);
  }
}
