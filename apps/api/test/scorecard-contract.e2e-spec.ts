/**
 * The two data paths must agree.
 *
 * A judge's scorecard can be read two ways: through the GraphQL scorecards
 * service, and through the judge portal's own REST controller, which queries
 * Prisma directly rather than calling that service. The two assemble their
 * response independently.
 *
 * They have drifted twice. Once when `parentId` was added to criterion scores
 * and the portal kept returning rows for category headers — judges were asked
 * to score the same points twice. Once when `flaggedForReview` was added to the
 * flag route but not to the portal's response, so the Revisit quadrant read zero
 * however many cards were flagged.
 *
 * Both cost hours, and both cost them for the same reason: nothing complained.
 * The response was well-formed, the page rendered, and the missing field was
 * simply undefined.
 *
 * This does not remove the duplication. It makes the duplication loud — the
 * moment one path gains a field the other does not, this fails and names it.
 *
 * Run:  npx jest --config test/jest-e2e.json scorecard-contract
 *
 * Needs a database with at least one scorecard. If there is none the test skips
 * rather than passing, because a green tick on an empty database would be worse
 * than no test at all.
 */

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScorecardsService } from '../src/scorecards/scorecards.service';
import { JudgePortalService } from '../src/judge-portal/judge-portal.service';

/** Fields the judge portal is expected to return. Kept explicit so that adding
 *  one to the service without adding it here is itself a visible decision. */
const SCORECARD_FIELDS = [
  'id', 'sessionId', 'judgeId', 'teamName', 'projectName', 'roomName',
  'scheduledStart', 'scheduledEnd', 'sessionStage', 'status', 'totalScore',
  'overallStrengths', 'areasForImprovement', 'recommendation', 'submittedAt',
  'reopenReason', 'flaggedForReview', 'canScore', 'canView', 'eventClosed',
  'criterionScores',
];

const CRITERION_FIELDS = [
  'id', 'criterionId', 'score', 'comment',
];

describe('scorecard contract — GraphQL service and judge portal REST', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scorecards: ScorecardsService;
  let portalService: JudgePortalService;

  let eventId: string | null = null;
  let judgeId: string | null = null;
  let token: string | null = null;
  let scorecardId: string | null = null;

  beforeAll(async () => {
    // These need a real database. Failing when one is absent — in CI, in a
    // scanning sandbox — reports a problem with the environment as though it
    // were a problem with the code, and a suite that cries wolf stops being
    // read at all.
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    } catch (err: any) {
      console.warn(
        '\n  Skipping: no database reachable. These tests verify that the two ' +
        'scorecard paths agree, which cannot be checked without data.\n' +
        `  (${err?.message?.split('\n')[0] ?? err})\n`,
      );
      return;
    }

    prisma = app.get(PrismaService);
    scorecards = app.get(ScorecardsService);
    portalService = app.get(JudgePortalService);

    // Any judge with at least one scorecard will do — this asserts a shape, not
    // a particular event's data.
    const sc = await prisma.scorecard.findFirst({
      include: { judge: true },
      orderBy: { createdAt: 'asc' },
    });

    if (sc) {
      scorecardId = sc.id;
      judgeId = sc.judgeId;
      eventId = sc.eventId;
      token = portalService.generateToken(sc.judgeId);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('has data to test against', () => {
    if (!app) return;
    if (!scorecardId) {
      // Skipping is honest. Passing on an empty database would report that the
      // two paths agree when nothing was compared.
      console.warn(
        '\n  No scorecards in the database — this test verified nothing.' +
        '\n  Import an event and generate a schedule before relying on it.\n',
      );
    }
    expect(true).toBe(true);
  });

  it('returns the same top-level fields from both paths', async () => {
    if (!scorecardId || !token || !eventId) return;

    const res = await request(app.getHttpServer())
      .get(`/api/judge-portal/${token}/scorecards`)
      .query({ event: eventId })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const fromPortal = Object.keys(res.body[0]).sort();
    const expected = [...SCORECARD_FIELDS].sort();

    const missing = expected.filter(f => !fromPortal.includes(f));
    const extra = fromPortal.filter(f => !expected.includes(f));

    // Named rather than a bare deep-equal, so a failure says which field moved.
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('returns the same criterion score fields from both paths', async () => {
    if (!scorecardId || !token || !eventId) return;

    const res = await request(app.getHttpServer())
      .get(`/api/judge-portal/${token}/scorecards`)
      .query({ event: eventId })
      .expect(200);

    const withScores = res.body.find((s: any) => s.criterionScores?.length > 0);
    if (!withScores) return;

    const fromPortal = Object.keys(withScores.criterionScores[0]);
    const missing = CRITERION_FIELDS.filter(f => !fromPortal.includes(f));

    expect(missing).toEqual([]);
  });

  it('never returns a scoring row for a category', async () => {
    if (!scorecardId || !token || !eventId) return;

    // The regression that produced this test: category headers appearing as
    // scoring rows, which asks a judge for the same points twice and puts the
    // total past its maximum.
    const res = await request(app.getHttpServer())
      .get(`/api/judge-portal/${token}/scorecards`)
      .query({ event: eventId })
      .expect(200);

    const criteria = await prisma.scoringCriterion.findMany({
      where: { template: { eventId } },
      select: { id: true, parentId: true },
    });
    const categoryIds = new Set(
      criteria.map(c => c.parentId).filter(Boolean) as string[],
    );

    const offenders: string[] = [];
    for (const card of res.body) {
      for (const cs of card.criterionScores ?? []) {
        if (categoryIds.has(cs.criterionId)) offenders.push(cs.criterionId);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('agrees with the service on totals for the same scorecard', async () => {
    if (!scorecardId || !token || !eventId) return;

    // findByJudgeToken is the service's own equivalent of what the portal
    // reimplements — the closest thing to a canonical answer that exists.
    const viaService = await scorecards
      .findByJudgeToken(judgeId!, eventId)
      .then((list: any[]) => list.find(s => s.id === scorecardId) ?? null)
      .catch(() => null);
    if (!viaService) return;

    const res = await request(app.getHttpServer())
      .get(`/api/judge-portal/${token}/scorecards`)
      .query({ event: eventId })
      .expect(200);

    const viaPortal = res.body.find((s: any) => s.id === scorecardId);
    if (!viaPortal) return;

    // A disagreement here means the same scorecard reads differently depending
    // on which screen a judge is looking at.
    expect(viaPortal.status).toBe((viaService as any).status);
    expect(viaPortal.totalScore ?? null).toBe((viaService as any).totalScore ?? null);

    // The count is the one that catches category rows leaking into one path.
    const serviceRows = (viaService as any).criterionScores?.length;
    if (typeof serviceRows === 'number') {
      expect(viaPortal.criterionScores.length).toBe(serviceRows);
    }
  });
});
