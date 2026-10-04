import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReviewService } from './review.service';
import { buildResultsWorkbook, resultsFileName, resultsOrder } from './review-export';

const ADMINS = ['ADMIN'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reviewing candidates and their results (interview events).
 *
 *   GET  /api/review/:eventId?date=YYYY-MM-DD           candidates with judges' scores and comments
 *   POST /api/review/:eventId/:sessionId/decision        { decision, feedback, submit }
 *   GET  /api/review/:eventId/results?date=YYYY-MM-DD    candidates in results order
 *   GET  /api/review/:eventId/export?date=YYYY-MM-DD     .xlsx for that day, or all days without a date
 *   GET  /api/review/:eventId/:sessionId/report          the candidate's stored PDF report (decided only)
 *   GET  /api/review/:eventId/reports?date=YYYY-MM-DD    that day's reports as a .zip
 *   POST /api/review/:eventId/:sessionId/report-preview  { decision, feedback } → draft PDF, not stored
 */
@Controller('api/review')
export class ReviewController {
  constructor(private service: ReviewService) {}

  private date(d?: string): string | undefined {
    if (!d) return undefined;
    return DATE.test(d) ? d : undefined;
  }

  @Get(':eventId')
  async review(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    return this.service.load(eventId, this.date(date));
  }

  @Post(':eventId/:sessionId/decision')
  async decide(
    @Param('eventId') eventId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { decision?: string | null; feedback?: string | null; submit?: boolean },
    @Req() req: any,
  ) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    return this.service.decide(eventId, sessionId, body ?? {}, req.user.sub);
  }

  @Get(':eventId/results')
  async results(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    const data = await this.service.load(eventId, this.date(date));
    return { ...data, records: resultsOrder(data.records) };
  }

  @Get(':eventId/reports')
  async reports(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any, @Res() res: Response) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    const day = this.date(date);
    if (!day) throw new BadRequestException('Choose a day (date=YYYY-MM-DD).');
    const out = await this.service.dayReports(eventId, day);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.send(out.zip);
  }

  @Get(':eventId/:sessionId/report')
  async report(
    @Param('eventId') eventId: string, @Param('sessionId') sessionId: string,
    @Query('view') view: string | undefined, @Req() req: any, @Res() res: Response,
  ) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    const out = await this.service.report(eventId, sessionId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${view ? 'inline' : 'attachment'}; filename="${out.fileName}"`);
    res.send(out.pdf);
  }

  /** HR's draft as a PDF preview: never stored, marked as a draft. */
  @Post(':eventId/:sessionId/report-preview')
  async preview(
    @Param('eventId') eventId: string, @Param('sessionId') sessionId: string,
    @Body() body: { decision?: string | null; feedback?: string | null },
    @Req() req: any, @Res() res: Response,
  ) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    const out = await this.service.previewReport(eventId, sessionId, body ?? {}, req.user.sub);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.fileName}"`);
    res.send(out.pdf);
  }

  @Get(':eventId/export')
  async export(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any, @Res() res: Response) {
    await this.service.assertAccess(req.user, eventId, ADMINS);
    const day = this.date(date);
    const data = await this.service.load(eventId);
    const buffer = buildResultsWorkbook(data, day);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${resultsFileName(data.event.name, day)}"`);
    res.send(buffer);
  }
}
