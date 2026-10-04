import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * GET /api/admin/encryption: what protects the data at rest, for super
 * admins. Read-only; key changes are made on the server (encryption.sh).
 */
@Controller('api/admin/encryption')
export class EncryptionController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async status(@Req() req: any) {
    if (req.user?.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only a super admin can see this.');
    return this.prisma.encryptionStatus();
  }
}
