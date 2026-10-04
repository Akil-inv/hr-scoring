import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { EventAccessService, EventCheckedInHandler } from '../auth/event-access';
import { JudgePortalService } from './judge-portal.service';

/**
 * Judge links for interview events: one per judge per day.
 *
 *   GET  /api/judge-links/:eventId                    each day's links (made where missing)
 *   POST /api/judge-links/:eventId/:linkId/reissue    cancel a link and issue a new one
 */
const OPERATORS = ['ADMIN', 'COORDINATOR'];

@Controller('api/judge-links')
@EventCheckedInHandler()
export class JudgeLinksController {
  constructor(private service: JudgePortalService, private access: EventAccessService) {}

  @Get(':eventId')
  async list(@Param('eventId') eventId: string, @Req() req: any) {
    await this.access.assert(req.user, eventId, OPERATORS);
    return this.service.dayLinks(eventId, req.user.sub);
  }

  @Post(':eventId/:linkId/reissue')
  async reissue(@Param('eventId') eventId: string, @Param('linkId') linkId: string, @Req() req: any) {
    await this.access.assert(req.user, eventId, OPERATORS, [{ kind: 'judgeLink', id: linkId }]);
    return this.service.reissue(eventId, linkId, req.user.sub);
  }
}
