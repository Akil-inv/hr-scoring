import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScorecardStatus } from '@prisma/client';

const COMPLETED_STATUSES: ScorecardStatus[] = [
  ScorecardStatus.SUBMITTED,
  ScorecardStatus.RESUBMITTED,
  ScorecardStatus.LOCKED,
];

@Controller('api/export')
@UseGuards(JwtAuthGuard)
export class ExportController {
  constructor(private prisma: PrismaService) {}

  // ─── 1. SCHEDULE EXPORT ───
  @Get('schedule')
  async exportSchedule(@Query('eventId') eventId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const sessions = await this.prisma.judgingSession.findMany({
      where: { eventId, stage: { notIn: ['CANCELLED'] } },
      include: {
        team: { include: { track: true } },
        room: true,
        timeSlot: true,
        judges: { include: { judge: true } },
      },
      orderBy: [{ scheduledStart: 'asc' }, { room: { name: 'asc' } }],
    });

    const header = ['Date', 'Start Time', 'End Time', 'Room', 'Team', 'Project', 'Track', 'Organisation', 'Judge 1', 'Judge 1 Type', 'Judge 1 Tier', 'Judge 2', 'Judge 2 Type', 'Judge 2 Tier', 'Judge 3', 'Judge 3 Type', 'Judge 3 Tier', 'Judge 4', 'Judge 4 Type', 'Judge 4 Tier', 'Judge 5', 'Judge 5 Type', 'Judge 5 Tier', 'Status'];
    const rows = sessions.map(s => {
      const date = s.timeSlot?.startTime ? new Date(s.timeSlot.startTime).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' }) : '';
      const start = s.timeSlot?.startTime ? new Date(s.timeSlot.startTime).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) : '';
      const end = s.timeSlot?.endTime ? new Date(s.timeSlot.endTime).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) : '';
      const judgeFields: string[] = [];
      for (let i = 0; i < 5; i++) {
        const j = s.judges[i]?.judge;
        judgeFields.push(j ? this.csvCell(j.name) : '');
        judgeFields.push(j?.judgeType || '');
        judgeFields.push(j?.judgeTier || '');
      }
      return [date, start, end, this.csvCell(s.room?.name || ''), this.csvCell(s.team.name), this.csvCell(s.team.projectName), this.csvCell(s.team.track?.name || ''), this.csvCell(s.team.organisation || ''), ...judgeFields, s.stage].join(',');
    });

    this.sendCsv(res, event.name, 'schedule', header, rows);
  }

  // ─── 2. RAW SCORES ───
  @Get('scores-raw')
  async exportScoresRaw(@Query('eventId') eventId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId, status: { in: COMPLETED_STATUSES } },
      include: {
        team: { include: { track: true } },
        judge: true,
        session: { include: { room: true, timeSlot: true } },
        criterionScores: { include: { criterion: true }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
      orderBy: [{ team: { name: 'asc' } }, { judge: { name: 'asc' } }],
    });

    const header = ['Team', 'Project', 'Track', 'Organisation', 'Judge', 'Judge Email', 'Judge Type', 'Judge Tier', 'Judge Organisation', 'Criterion', 'Criterion Max', 'Score', 'Score %', 'Comment', 'Scorecard Status', 'Room', 'Session Date', 'Session Time', 'Submitted At'];
    const rows: string[] = [];

    for (const sc of scorecards) {
      const date = sc.session?.timeSlot?.startTime ? new Date(sc.session.timeSlot.startTime).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' }) : '';
      const time = sc.session?.timeSlot?.startTime ? new Date(sc.session.timeSlot.startTime).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) : '';
      const submitted = sc.submittedAt ? new Date(sc.submittedAt).toISOString() : '';

      for (const cs of sc.criterionScores) {
        const pct = cs.criterion?.maxScore && cs.score !== null ? ((cs.score / cs.criterion.maxScore) * 100).toFixed(1) : '';
        rows.push([
          this.csvCell(sc.team.name), this.csvCell(sc.team.projectName), this.csvCell(sc.team.track?.name || ''), this.csvCell(sc.team.organisation || ''),
          this.csvCell(sc.judge.name), this.csvCell(sc.judge.email), sc.judge.judgeType, sc.judge.judgeTier, this.csvCell(sc.judge.organisation || ''),
          this.csvCell(cs.criterion?.name || ''), cs.criterion?.maxScore?.toString() || '', cs.score !== null ? cs.score.toString() : '', pct,
          this.csvCell(cs.comment),
          sc.status, this.csvCell(sc.session?.room?.name || ''), date, time, submitted,
        ].join(','));
      }
    }

    this.sendCsv(res, event.name, 'scores_raw', header, rows);
  }

  // ─── 3. SCORE SUMMARY ───
  @Get('scores')
  async exportScores(@Query('eventId') eventId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    const criteria = template?.criteria || [];

    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId, status: { in: COMPLETED_STATUSES } },
      include: {
        team: { include: { track: true } },
        judge: true,
        criterionScores: { include: { criterion: true } },
      },
      orderBy: [{ team: { name: 'asc' } }, { judge: { name: 'asc' } }],
    });

    const critHeaders = criteria.flatMap(c => [`${c.name} (/${c.maxScore})`, `${c.name} Comment`]);
    const maxTotal = criteria.reduce((s, c) => s + c.maxScore, 0);
    const header = ['Team', 'Project', 'Track', 'Organisation', 'Judge', 'Judge Type', 'Judge Tier', 'Judge Organisation', ...critHeaders, 'Total Score', 'Total %', 'Strengths', 'Areas for Improvement', 'Recommendation', 'Status', 'Submitted At'];

    const rows = scorecards.map(sc => {
      const critFields = criteria.flatMap(c => {
        const cs = sc.criterionScores.find(s => s.criterionId === c.id);
        return [
          cs?.score !== null && cs?.score !== undefined ? cs.score.toString() : '',
          this.csvCell(cs?.comment),
        ];
      });
      const total = sc.criterionScores.reduce((sum: number, cs: any) => sum + (cs.score || 0), 0);
      const pct = maxTotal > 0 ? ((total / maxTotal) * 100).toFixed(1) : '';
      return [
        this.csvCell(sc.team.name), this.csvCell(sc.team.projectName), this.csvCell(sc.team.track?.name || ''), this.csvCell(sc.team.organisation || ''),
        this.csvCell(sc.judge.name), sc.judge.judgeType, sc.judge.judgeTier, this.csvCell(sc.judge.organisation || ''),
        ...critFields, total.toString(), pct,
        this.csvCell(sc.overallStrengths),
        this.csvCell(sc.areasForImprovement),
        this.csvCell(sc.recommendation),
        sc.status, sc.submittedAt ? new Date(sc.submittedAt).toISOString() : '',
      ].join(',');
    });

    this.sendCsv(res, event.name, 'scores_summary', header, rows);
  }

  // ─── 4. TEAM AGGREGATES ───
  @Get('team-aggregates')
  async exportTeamAggregates(@Query('eventId') eventId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    const criteria = template?.criteria || [];

    const teams = await this.prisma.team.findMany({
      where: { eventId, deletedAt: null },
      include: { track: true },
      orderBy: { name: 'asc' },
    });

    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId, status: { in: COMPLETED_STATUSES } },
      include: { criterionScores: true },
    });

    const critHeaders = criteria.flatMap(c => [`${c.name} Avg`, `${c.name} Min`, `${c.name} Max`, `${c.name} StdDev`]);
    const header = ['Team', 'Project', 'Track', 'Organisation', 'Judges Scored', 'Judges Expected', ...critHeaders, 'Total Avg', 'Total Min', 'Total Max', 'Total StdDev', 'Completion %'];

    const rows = teams.map(team => {
      const cards = scorecards.filter(sc => sc.teamId === team.id);
      const judgeCount = cards.length;

      const critFields = criteria.flatMap(c => {
        const scores = cards.flatMap(sc => sc.criterionScores).filter(cs => cs.criterionId === c.id && cs.score !== null).map(cs => cs.score!);
        if (scores.length === 0) return ['', '', '', ''];
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;
        return [avg.toFixed(2), min.toString(), max.toString(), Math.sqrt(variance).toFixed(2)];
      });

      const totals = cards.map(sc => sc.criterionScores.reduce((s: number, cs: any) => s + (cs.score || 0), 0));
      let totalAvg = '', totalMin = '', totalMax = '', totalStdDev = '';
      if (totals.length > 0) {
        const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
        totalAvg = avg.toFixed(2);
        totalMin = Math.min(...totals).toString();
        totalMax = Math.max(...totals).toString();
        const variance = totals.reduce((s, v) => s + (v - avg) ** 2, 0) / totals.length;
        totalStdDev = Math.sqrt(variance).toFixed(2);
      }

      const expectedJudges = event.minJudgesPerTeam || 3;
      const completion = expectedJudges > 0 ? ((judgeCount / expectedJudges) * 100).toFixed(0) : '';

      return [
        this.csvCell(team.name), this.csvCell(team.projectName), this.csvCell(team.track?.name || ''), this.csvCell(team.organisation || ''),
        judgeCount.toString(), expectedJudges.toString(), ...critFields,
        totalAvg, totalMin, totalMax, totalStdDev, completion,
      ].join(',');
    });

    this.sendCsv(res, event.name, 'team_aggregates', header, rows);
  }

  // ─── 5. JUDGE ANALYTICS ───
  @Get('judge-analytics')
  async exportJudgeAnalytics(@Query('eventId') eventId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    const criteria = template?.criteria || [];

    const judges = await this.prisma.judge.findMany({
      where: { eventId, deletedAt: null },
      orderBy: { name: 'asc' },
    });

    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId, status: { in: COMPLETED_STATUSES } },
      include: { criterionScores: true, team: true },
    });

    const critHeaders = criteria.flatMap(c => [`${c.name} Avg Given`, `${c.name} StdDev`]);
    const header = ['Judge', 'Email', 'Type', 'Tier', 'Organisation', 'Teams Scored', 'Max Sessions', 'Avg Total Given', 'StdDev Total', 'Lowest Score To', 'Highest Score To', ...critHeaders, 'Scoring Range', 'Harshness Index %'];

    const allTotals = scorecards.map(sc => sc.criterionScores.reduce((s: number, cs: any) => s + (cs.score || 0), 0));
    const globalAvg = allTotals.length > 0 ? allTotals.reduce((a, b) => a + b, 0) / allTotals.length : 0;

    const rows = judges.map(judge => {
      const cards = scorecards.filter(sc => sc.judgeId === judge.id);
      if (cards.length === 0) {
        return [this.csvCell(judge.name), this.csvCell(judge.email), judge.judgeType, judge.judgeTier, this.csvCell(judge.organisation || ''), '0', judge.maxSessions.toString(), '', '', '', '', ...criteria.flatMap(() => ['', '']), '', ''].join(',');
      }

      const totals = cards.map(sc => ({ team: sc.team.name, total: sc.criterionScores.reduce((s: number, cs: any) => s + (cs.score || 0), 0) }));
      const totalValues = totals.map(t => t.total);
      const avg = totalValues.reduce((a, b) => a + b, 0) / totalValues.length;
      const variance = totalValues.reduce((s, v) => s + (v - avg) ** 2, 0) / totalValues.length;
      const stdDev = Math.sqrt(variance);
      const lowest = totals.reduce((a, b) => (a.total < b.total ? a : b), totals[0]);
      const highest = totals.reduce((a, b) => (a.total > b.total ? a : b), totals[0]);
      const range = Math.max(...totalValues) - Math.min(...totalValues);
      const harshness = globalAvg > 0 ? ((avg - globalAvg) / globalAvg * 100).toFixed(1) : '';

      const critFields = criteria.flatMap(c => {
        const scores = cards.flatMap(sc => sc.criterionScores).filter((cs: any) => cs.criterionId === c.id && cs.score !== null).map((cs: any) => cs.score!);
        if (scores.length === 0) return ['', ''];
        const critAvg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
        const critVar = scores.reduce((s: number, v: number) => s + (v - critAvg) ** 2, 0) / scores.length;
        return [critAvg.toFixed(2), Math.sqrt(critVar).toFixed(2)];
      });

      return [
        this.csvCell(judge.name), this.csvCell(judge.email), judge.judgeType, judge.judgeTier, this.csvCell(judge.organisation || ''),
        cards.length.toString(), judge.maxSessions.toString(), avg.toFixed(2), stdDev.toFixed(2),
        `"${lowest.team} (${lowest.total})"`, `"${highest.team} (${highest.total})"`,
        ...critFields, range.toString(), harshness,
      ].join(',');
    });

    this.sendCsv(res, event.name, 'judge_analytics', header, rows);
  }

  // ─── 6. INDICATIVE RANKINGS ───
  @Get('rankings')
  async exportRankings(@Query('eventId') eventId: string, @Query('trackId') trackId: string, @Res() res: Response) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    const criteria = template?.criteria || [];

    const where: any = { eventId };
    if (trackId) where.trackId = trackId;
    else where.trackId = null;

    const rankings = await this.prisma.rankingResult.findMany({
      where,
      orderBy: { rankPosition: 'asc' },
      include: { team: { include: { track: true } } },
    });

    const teamIds = rankings.map(r => r.teamId);
    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId, teamId: { in: teamIds }, status: { in: COMPLETED_STATUSES } },
      include: { criterionScores: true, judge: true },
    });

    const critHeaders = criteria.map(c => `${c.name} Avg (/${c.maxScore})`);
    const maxTotal = criteria.reduce((s, c) => s + c.maxScore, 0);
    const header = ['Rank', 'Team', 'Project', 'Track', 'Organisation', 'Judge Names', ...critHeaders, 'Total Score', 'Max Possible', 'Score %', 'Judges Scored', 'Status', 'Note'];

    const rows = rankings.map(r => {
      const cards = scorecards.filter(sc => sc.teamId === r.teamId);
      const judgeNames = [...new Set(cards.map(sc => sc.judge.name))].join('; ');
      const critAvgs = criteria.map(c => {
        const scores = cards.flatMap(sc => sc.criterionScores).filter((cs: any) => cs.criterionId === c.id && cs.score !== null).map((cs: any) => cs.score! as number);
        return scores.length > 0 ? (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1) : '';
      });
      const pct = maxTotal > 0 ? ((Number(r.aggregatedScore) / maxTotal) * 100).toFixed(1) : '';

      return [
        r.rankPosition.toString(), this.csvCell(r.team.name), this.csvCell(r.team.projectName), this.csvCell(r.team.track?.name || ''), this.csvCell(r.team.organisation || ''),
        this.csvCell(judgeNames),
        ...critAvgs, Number(r.aggregatedScore).toFixed(1), maxTotal.toString(), pct, r.judgeCount.toString(), r.status,
        '"Indicative - final calibration done offline"',
      ].join(',');
    });

    const scope = trackId ? 'track' : 'overall';
    this.sendCsv(res, event.name, `rankings_${scope}`, header, rows);
  }

  // ─── Helper ───

  /**
   * One CSV cell.
   *
   * Three things had to be handled and only one was:
   *
   *  - Embedded quotes. Only the comment field doubled them, so a team or judge
   *    name containing a quote broke the row structure and shifted every column
   *    after it.
   *  - Newlines, for the same reason.
   *  - A leading =, +, - or @. Excel treats those cells as formulas, and this
   *    export is opened in Excel by definition. A comment of "-2 for scope
   *    creep" is a plausible thing for a judge to write and an unpleasant thing
   *    for a spreadsheet to evaluate. Prefixing a tab neutralises it while
   *    leaving the text readable.
   */
  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '""';
    let v = String(value).replace(/\r?\n/g, ' ');
    if (/^[=+\-@\t\r]/.test(v)) v = `\t${v}`;
    return '"' + v.replace(/"/g, '""') + '"';
  }

  private sendCsv(res: Response, eventName: string, type: string, header: string[], rows: string[]) {
    const csv = [header.join(','), ...rows].join('\n');
    const safeName = eventName.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_${safeName}_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  }
}
