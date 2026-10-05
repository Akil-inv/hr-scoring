import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReviewService } from './review.service';
import { DocumentPasswordService } from '../documents/document-password.service';
import { buildResultsWorkbook, resultsFileName, resultsOrder } from './review-export';
import { EventAccessService, EventCheckedInHandler, Ref } from '../auth/event-access';

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
 *   POST /api/review/:eventId/:sessionId/reopen          { reason, judgeIds } reopen scoring / the decision
 *   POST /api/review/:eventId/days/:date/close           close a day
 *   POST /api/review/:eventId/close                      close the event (final)
 *
 * Every file here (report PDF, preview, the day's zip of PDFs, the .xlsx) is
 * locked with the downloader's document password (src/documents), and the
 * download is recorded in the audit log.
 */
@Controller('api/review')
@EventCheckedInHandler()
export class ReviewController {
  constructor(private service: ReviewService, private documents: DocumentPasswordService, private access: EventAccessService) {}

  /** Admins of the event only; a session named in the path must be in that event. */
  private check(req: any, eventId: string, sessionId?: string, extra: Ref[] = []) {
    const refs: Ref[] = sessionId ? [{ kind: 'session', id: sessionId }, ...extra] : extra;
    // POSTs change the event (decisions, reopening, closing): not once it is done.
    return this.access.assert(req.user, eventId, ADMINS, refs, { write: req.method !== 'GET' });
  }

  private date(d?: string): string | undefined {
    if (!d) return undefined;
    return DATE.test(d) ? d : undefined;
  }

  @Get(':eventId')
  async review(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any) {
    await this.check(req, eventId);
    return this.service.load(eventId, this.date(date));
  }

  @Post(':eventId/:sessionId/decision')
  async decide(
    @Param('eventId') eventId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { decision?: string | null; feedback?: string | null; submit?: boolean },
    @Req() req: any,
  ) {
    await this.check(req, eventId, sessionId);
    return this.service.decide(eventId, sessionId, body ?? {}, req.user.sub);
  }

  @Get(':eventId/results')
  async results(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any) {
    await this.check(req, eventId);
    const data = await this.service.load(eventId, this.date(date));
    return { ...data, records: resultsOrder(data.records) };
  }

  @Get(':eventId/reports')
  async reports(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any, @Res() res: Response) {
    await this.check(req, eventId);
    const day = this.date(date);
    if (!day) throw new BadRequestException('Choose a day (date=YYYY-MM-DD).');
    const out = await this.service.dayReports(eventId, day,
      (files) => this.documents.pdfs(req.user.sub, files, 'day-reports', eventId, { date: day }));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.send(out.zip);
  }

  @Get(':eventId/:sessionId/report')
  async report(
    @Param('eventId') eventId: string, @Param('sessionId') sessionId: string,
    @Query('view') view: string | undefined, @Query('revision') revision: string | undefined,
    @Req() req: any, @Res() res: Response,
  ) {
    await this.check(req, eventId, sessionId);
    const rev = revision && /^\d+$/.test(revision) ? Number(revision) : undefined;
    const out = await this.service.report(eventId, sessionId, rev);
    const { file: pdf, prefix } = await this.documents.pdf(req.user.sub, out.pdf, 'report', out.candidate, eventId, { sessionId, revision: rev ?? 'current' });
    res.setHeader('X-Password-Prefix', prefix);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${view ? 'inline' : 'attachment'}; filename="${out.fileName}"`);
    res.send(pdf);
  }

  @Post(':eventId/:sessionId/reopen')
  async reopen(
    @Param('eventId') eventId: string, @Param('sessionId') sessionId: string,
    @Body() body: { reason?: string | null; judgeIds?: string[] | null }, @Req() req: any,
  ) {
    await this.check(req, eventId, sessionId, (Array.isArray(body?.judgeIds) ? body!.judgeIds : []).map((id) => ({ kind: 'judge' as const, id: String(id) })));
    return this.service.reopen(eventId, sessionId, body ?? {}, req.user.sub);
  }

  @Post(':eventId/days/:date/close')
  async closeDay(@Param('eventId') eventId: string, @Param('date') date: string, @Req() req: any) {
    await this.check(req, eventId);
    const day = this.date(date);
    if (!day) throw new BadRequestException('Choose a day (YYYY-MM-DD).');
    return this.service.closeDay(eventId, day, req.user.sub);
  }

  @Post(':eventId/close')
  async closeEvent(@Param('eventId') eventId: string, @Req() req: any) {
    await this.check(req, eventId);
    return this.service.closeEvent(eventId, req.user.sub);
  }

  /** HR's draft as a PDF preview: never stored, marked as a draft. */
  @Post(':eventId/:sessionId/report-preview')
  async preview(
    @Param('eventId') eventId: string, @Param('sessionId') sessionId: string,
    @Body() body: { decision?: string | null; feedback?: string | null },
    @Req() req: any, @Res() res: Response,
  ) {
    await this.check(req, eventId, sessionId);
    const out = await this.service.previewReport(eventId, sessionId, body ?? {}, req.user.sub);
    const { file: pdf, prefix } = await this.documents.pdf(req.user.sub, out.pdf, 'report-preview', out.candidate, eventId, { sessionId });
    res.setHeader('X-Password-Prefix', prefix);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.fileName}"`);
    res.send(pdf);
  }

  @Get(':eventId/export')
  async export(@Param('eventId') eventId: string, @Query('date') date: string | undefined, @Req() req: any, @Res() res: Response) {
    await this.check(req, eventId);
    const day = this.date(date);
    const data = await this.service.load(eventId);
    const { file: buffer, prefix } = await this.documents.xlsx(req.user.sub, buildResultsWorkbook(data, day), 'results-export', data.event.name, eventId, { date: day ?? 'all' });
    res.setHeader('X-Password-Prefix', prefix);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${resultsFileName(data.event.name, day)}"`);
    res.send(buffer);
  }
}
