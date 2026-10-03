import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

@Controller('api/notify')
@UseGuards(JwtAuthGuard)
export class NotificationController {

  @Post('send')
  async sendOne(@Body() body: any) {
    const results: any = { judgeEmail: body.judgeEmail, email: null, sms: null };
    if (body.channel === 'ses' || body.channel === 'both') {
      results.email = await this.sendEmail(body);
    }
    if (body.channel === 'sns' || body.channel === 'both') {
      results.sms = body.judgePhone ? await this.sendSms(body) : { success: false, error: 'No phone number' };
    }
    return results;
  }

  @Post('send-batch')
  async sendBatch(@Body() body: any) {
    const results: any[] = [];
    for (const judge of body.judges) {
      const entry: any = { judgeId: judge.judgeId, judgeName: judge.judgeName, email: null, sms: null };
      if (body.channel === 'ses' || body.channel === 'both') {
        entry.email = await this.sendEmail({ ...body, judgeName: judge.judgeName, judgeEmail: judge.judgeEmail, portalLink: judge.portalLink });
      }
      if (body.channel === 'sns' || body.channel === 'both') {
        entry.sms = judge.judgePhone ? await this.sendSms({ ...body, judgeName: judge.judgeName, judgePhone: judge.judgePhone, portalLink: judge.portalLink }) : { success: false, error: 'No phone number' };
      }
      results.push(entry);
      await new Promise(r => setTimeout(r, 200));
    }
    return { total: body.judges.length, emailSent: results.filter(r => r.email?.success).length, smsSent: results.filter(r => r.sms?.success).length, results };
  }

  private async sendEmail(body: any): Promise<{ success: boolean; error?: string }> {
    try {
      const ses = new SESClient({ region: body.sesRegion || 'ap-southeast-1' });
      const html = '<html><body style="font-family:sans-serif;background:#f8fafc;padding:40px"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1)"><div style="text-align:center;margin-bottom:24px"><div style="width:48px;height:48px;background:#7c3aed;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:white;font-size:24px">&#9889;</div><h1 style="font-size:20px;color:#1e293b;margin:16px 0 4px">' + body.eventName + '</h1><p style="color:#64748b;font-size:14px">Judging Portal Access</p></div><div style="font-size:15px;color:#334155;line-height:1.6"><p>Dear ' + body.judgeName + ',</p><p>You have been invited to judge <strong>' + body.eventName + '</strong>.</p><p>Your personal judging portal:</p><div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;text-align:center"><a href="' + body.portalLink + '" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:500;font-size:15px">Open Your Judging Portal</a></div><p>This link is unique to you. On event day, use it to view your schedule and score teams.</p><p>Thank you,<br><strong>' + body.eventName + ' Team</strong></p></div></div></body></html>';
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
