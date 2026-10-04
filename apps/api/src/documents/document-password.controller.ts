import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentPasswordService } from './document-password.service';

/**
 *   GET /api/document-password   { set, setAt } for the signed-in user (never the password)
 *   PUT /api/document-password   { signInPassword, password }: set or change it
 */
@Controller('api/document-password')
@UseGuards(JwtAuthGuard)
export class DocumentPasswordController {
  constructor(private documents: DocumentPasswordService) {}

  @Get()
  status(@Req() req: any) {
    return this.documents.status(req.user.sub);
  }

  @Put()
  set(@Req() req: any, @Body() body: { signInPassword?: string; password?: string }) {
    return this.documents.set(req.user.sub, body?.signInPassword ?? '', body?.password ?? '');
  }
}
