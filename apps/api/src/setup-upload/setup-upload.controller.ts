import { Body, Controller, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SetupUploadService } from './setup-upload.service';
import { EventAccessService, EventCheckedInHandler } from '../auth/event-access';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Setting up an event from the Excel workbook.
 *
 *   POST /api/setup-upload/preview   check the file, save nothing
 *   POST /api/setup-upload/commit    build the event
 *
 * Both take the file as multipart field "file". Send "eventId" as well to
 * replace that event's setup instead of creating a new event.
 */
@Controller('api/setup-upload')
@EventCheckedInHandler()
export class SetupUploadController {
  constructor(private service: SetupUploadService, private access: EventAccessService) {}

  /** A new event: a platform admin. An existing one: an admin of that event. */
  private async check(req: any, eventId: string | undefined, write = false) {
    if (eventId) await this.access.assert(req.user, eventId, ['ADMIN'], [], { write });
    else SetupUploadService.assertMaySetUp(req.user);
  }

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async preview(@UploadedFile() file: Express.Multer.File, @Body('eventId') eventId: string | undefined, @Req() req: any) {
    await this.check(req, eventId || undefined);
    return this.service.preview(SetupUploadService.assertFile(file), eventId || undefined);
  }

  @Post('commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async commit(@UploadedFile() file: Express.Multer.File, @Body('eventId') eventId: string | undefined, @Req() req: any) {
    await this.check(req, eventId || undefined, true);
    return this.service.commit(SetupUploadService.assertFile(file), req.user.sub, eventId || undefined);
  }
}
