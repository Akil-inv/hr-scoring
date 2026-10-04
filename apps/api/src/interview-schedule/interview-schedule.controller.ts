import { Body, Controller, Get, Param, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SetupUploadService } from '../setup-upload/setup-upload.service';
import { InterviewScheduleService } from './interview-schedule.service';
import { EventAccessService, EventCheckedInHandler } from '../auth/event-access';

const MAX_BYTES = 5 * 1024 * 1024;
const ADMINS = ['ADMIN'];
const OPERATORS = ['ADMIN', 'COORDINATOR'];

/**
 * The interview schedule of an uploaded event.
 *
 *   GET  /api/interview-schedule/:eventId                       days, slots, panels, candidates
 *   POST /api/interview-schedule/:eventId/candidates/preview    check a candidates file, save nothing
 *   POST /api/interview-schedule/:eventId/candidates/commit     place / move the candidates in it
 *   POST /api/interview-schedule/:eventId/move                  { sessionId, toSlotId }  (swaps if taken)
 *   POST /api/interview-schedule/:eventId/lock                  { date, locked }
 */
@Controller('api/interview-schedule')
@EventCheckedInHandler()
export class InterviewScheduleController {
  constructor(private service: InterviewScheduleService, private access: EventAccessService) {}

  @Get(':eventId')
  async schedule(@Param('eventId') eventId: string, @Req() req: any) {
    await this.access.assert(req.user, eventId, ['ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR']);
    return this.service.schedule(eventId);
  }

  @Post(':eventId/candidates/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async previewCandidates(@Param('eventId') eventId: string, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    await this.access.assert(req.user, eventId, ADMINS);
    return this.service.previewCandidates(eventId, SetupUploadService.assertFile(file));
  }

  @Post(':eventId/candidates/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async commitCandidates(@Param('eventId') eventId: string, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    await this.access.assert(req.user, eventId, ADMINS);
    return this.service.commitCandidates(eventId, SetupUploadService.assertFile(file), req.user.sub);
  }

  @Post(':eventId/move')
  async move(@Param('eventId') eventId: string, @Body() body: { sessionId?: string; toSlotId?: string }, @Req() req: any) {
    await this.access.assert(req.user, eventId, OPERATORS, [
      ...(body?.sessionId ? [{ kind: 'session' as const, id: String(body.sessionId) }] : []),
      ...(body?.toSlotId ? [{ kind: 'timeSlot' as const, id: String(body.toSlotId) }] : []),
    ]);
    return this.service.move(eventId, String(body?.sessionId ?? ''), String(body?.toSlotId ?? ''), req.user.sub);
  }

  @Post(':eventId/lock')
  async lock(@Param('eventId') eventId: string, @Body() body: { date?: string; locked?: boolean }, @Req() req: any) {
    await this.access.assert(req.user, eventId, ADMINS);
    return this.service.setLock(eventId, String(body?.date ?? ''), body?.locked !== false, req.user.sub);
  }
}
