import { BadRequestException, Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { EventAccessService, EventCheckedInHandler } from '../auth/event-access';
import { PrismaService } from '../prisma/prisma.service';
import { JudgePortalService } from '../judge-portal/judge-portal.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

/**
 * Sending a judge their portal link by email or SMS.
 *
 * The event and judge come from the request (eventId, judgeId) and are
 * checked: the sender must be an admin or coordinator of the event, and the
 * message goes only to that judge's own email and phone as stored, under the
 * event's own name. Nothing in the request can redirect it elsewhere.
 */
@Controller('api/notify')
@UseGuards(JwtAuthGuard)
@EventCheckedInHandler()
export class NotificationController {
  constructor(private access: EventAccessService, private prisma: PrismaService, private portal: JudgePortalService) {}

  /** The judge as stored, in an event the sender may act on. */
  private async recipient(req: any, eventId: unknown, judgeId: unknown) {
    if (typeof eventId !== 'string' || typeof judgeId !== 'string') throw new BadRequestException('Say which event and judge (eventId, judgeId).');
    await this.access.assert(req.user, eventId, ['ADMIN', 'COORDINATOR'], [{ kind: 'judge', id: judgeId }], { write: true });
    const judge = await this.prisma.judge.findFirst({ where: { id: judgeId, eventId }, select: { name: true, email: true, phone: true, event: { select: { name: true } } } });
    if (!judge) throw new BadRequestException('That judge is not on this event.');
    // The link is made here, for this judge, on the site the request came from:
    // a link in the request could point anywhere.
    // APP_URL (the address people open the app at) when it is set, so a
    // request can't name another site; otherwise the site the request came from.
    const configured = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
    const fromRequest = typeof req.headers?.origin === 'string' && /^https?:\/\/[^\s/]+$/.test(req.headers.origin) ? req.headers.origin : '';
    const origin = /^https?:\/\/[^\s]+$/.test(configured) ? configured : fromRequest;
    if (!origin) throw new BadRequestException('Send this from the app.');
    const link = `${origin}/judge/${this.portal.generateToken(judgeId)}?event=${eventId}`;
    return { judgeName: judge.name, judgeEmail: judge.email, judgePhone: judge.phone ?? '', eventName: judge.event.name, portalLink: link };
  }

  @Post('send')
  async sendOne(@Body() body: any, @Req() req: any) {
    const to = await this.recipient(req, body?.eventId, body?.judgeId);
    const msg = { ...body, ...to };
    const results: any = { judgeEmail: to.judgeEmail, email: null, sms: null };
    if (body.channel === 'ses' || body.channel === 'both') {
      results.email = await this.sendEmail(msg);
    }
    if (body.channel === 'sns' || body.channel === 'both') {
      results.sms = to.judgePhone ? await this.sendSms(msg) : { success: false, error: 'No phone number' };
    }
    return results;
  }

  @Post('send-batch')
  async sendBatch(@Body() body: any, @Req() req: any) {
    if (!Array.isArray(body?.judges)) throw new BadRequestException('judges must be a list');
    if (body.judges.length > 500) throw new BadRequestException('Up to 500 judges at a time.');
    const recipients = [];
    for (const judge of body.judges) recipients.push(await this.recipient(req, body?.eventId, judge?.judgeId));
    const results: any[] = [];
    for (const to of recipients) {
      const msg = { ...body, ...to };
      const entry: any = { judgeName: to.judgeName, email: null, sms: null };
      if (body.channel === 'ses' || body.channel === 'both') entry.email = await this.sendEmail(msg);
      if (body.channel === 'sns' || body.channel === 'both') entry.sms = to.judgePhone ? await this.sendSms(msg) : { success: false, error: 'No phone number' };
      results.push(entry);
      await new Promise(r => setTimeout(r, 200));
    }
    return { total: recipients.length, emailSent: results.filter(r => r.email?.success).length, smsSent: results.filter(r => r.sms?.success).length, results };
  }

  private async sendEmail(body: any): Promise<{ success: boolean; error?: string }> {
    try {
      const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
      const h = { eventName: esc(body.eventName), judgeName: esc(body.judgeName), portalLink: esc(body.portalLink) };
      const ses = new SESClient({ region: body.sesRegion || 'ap-southeast-1' });
      const html = '<html><body style="font-family:sans-serif;background:#f8fafc;padding:40px"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1)"><div style="text-align:center;margin-bottom:24px"><div style="width:48px;height:48px;background:#7c3aed;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:white;font-size:24px">&#9889;</div><h1 style="font-size:20px;color:#1e293b;margin:16px 0 4px">' + h.eventName + '</h1><p style="color:#64748b;font-size:14px">Judging Portal Access</p></div><div style="font-size:15px;color:#334155;line-height:1.6"><p>Dear ' + h.judgeName + ',</p><p>You have been invited to judge <strong>' + h.eventName + '</strong>.</p><p>Your personal judging portal:</p><div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;text-align:center"><a href="' + h.portalLink + '" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:500;font-size:15px">Open Your Judging Portal</a></div><p>This link is unique to you. On event day, use it to view your schedule and score teams.</p><p>Thank you,<br><strong>' + h.eventName + ' Team</strong></p></div></div></body></html>';
      const text = 'Dear ' + body.judgeName + ',\n\nYou have been invited to judge ' + body.eventName + '.\n\nYour judging portal: ' + body.portalLink + '\n\nPlease review your schedule before the event.\n\nThank you,\n' + body.eventName + ' Team';
      await ses.send(new SendEmailCommand({
        Source: body.sesFromEmail || process.env.SES_FROM_EMAIL || 'noreply@example.com',
        Destination: { ToAddresses: [body.judgeEmail] },
        Message: {
          Subject: { Data: body.eventName + ' - Your Judging Portal', Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
        },
      }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message?.substring(0, 200) || 'SES error' };
    }
  }

  private async sendSms(body: any): Promise<{ success: boolean; error?: string }> {
    try {
      if (!body.judgePhone) return { success: false, error: 'No phone number' };
      const sns = new SNSClient({ region: body.snsRegion || 'ap-southeast-1' });
      const message = body.eventName + ' - Dear ' + body.judgeName + ', your judging portal is ready: ' + body.portalLink;
      await sns.send(new PublishCommand({
        PhoneNumber: body.judgePhone,
        Message: message,
        MessageAttributes: {
          
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
        },
      }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message?.substring(0, 200) || 'SNS error' };
    }
  }
}
