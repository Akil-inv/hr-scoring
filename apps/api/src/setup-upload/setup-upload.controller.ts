import { Body, Controller, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SetupUploadService } from './setup-upload.service';

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
export class SetupUploadController {
  constructor(private service: SetupUploadService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async preview(@UploadedFile() file: Express.Multer.File, @Body('eventId') eventId: string | undefined, @Req() req: any) {
    SetupUploadService.assertMaySetUp(req.user);
    return this.service.preview(SetupUploadService.assertFile(file), eventId || undefined);
  }

  @Post('commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async commit(@UploadedFile() file: Express.Multer.File, @Body('eventId') eventId: string | undefined, @Req() req: any) {
    SetupUploadService.assertMaySetUp(req.user);
    return this.service.commit(SetupUploadService.assertFile(file), req.user.sub, eventId || undefined);
  }
}
