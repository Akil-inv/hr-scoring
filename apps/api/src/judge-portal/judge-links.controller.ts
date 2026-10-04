import { Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JudgePortalService } from './judge-portal.service';

/**
 * Judge links for interview events: one per judge per day.
 *
 *   GET  /api/judge-links/:eventId                    each day's links (made where missing)
 *   POST /api/judge-links/:eventId/:linkId/reissue    cancel a link and issue a new one
 */
@Controller('api/judge-links')
export class JudgeLinksController {
  constructor(private service: JudgePortalService, private prisma: PrismaService) {}

  private async assertAccess(user: { sub?: string; role?: string } | undefined, eventId: string) {
    if (!user?.sub) throw new ForbiddenException('Sign in first.');
    if (user.role === 'SUPER_ADMIN') return;
    if (!['ADMIN', 'COORDINATOR'].includes(user.role ?? '')) throw new ForbiddenException('Your role cannot do this.');
    const assignments = await this.prisma.eventUser.count({ where: { userId: user.sub } });
    if (assignments === 0) return;
    const assigned = await this.prisma.eventUser.findUnique({ where: { userId_eventId: { userId: user.sub, eventId } } });
    if (!assigned) throw new ForbiddenException('You are not assigned to this event. Ask a super admin to add you.');
  }

  @Get(':eventId')
  async list(@Param('eventId') eventId: string, @Req() req: any) {
    await this.assertAccess(req.user, eventId);
    return this.service.dayLinks(eventId, req.user.sub);
  }

  @Post(':eventId/:linkId/reissue')
  async reissue(@Param('eventId') eventId: string, @Param('linkId') linkId: string, @Req() req: any) {
    await this.assertAccess(req.user, eventId);
    return this.service.reissue(eventId, linkId, req.user.sub);
  }
}
