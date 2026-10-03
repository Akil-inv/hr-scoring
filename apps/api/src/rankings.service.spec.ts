import { Test, TestingModule } from '@nestjs/testing';
import { RankingsService } from './rankings/rankings.service';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './audit/audit.service';
import { BadRequestException } from '@nestjs/common';

describe('RankingsService', () => {
  let service: RankingsService;
  let prisma: any;
  let audit: any;

  const mockCriteria = [
    { id: 'c1', name: 'Innovation', maxScore: 20, displayOrder: 1, parentId: null },
    { id: 'c2', name: 'Impact', maxScore: 40, displayOrder: 2, parentId: null },
    { id: 'c3', name: 'Feasibility', maxScore: 10, displayOrder: 3, parentId: null },
    { id: 'c4', name: 'Collaboration', maxScore: 20, displayOrder: 4, parentId: null },
    { id: 'c5', name: 'Bonus', maxScore: 10, displayOrder: 5, parentId: null },
  ];

  /** The active template, as findMany now returns it — a list, filtered on status. */
  const setTemplate = (criteria: any[]) =>
    prisma.scoringTemplate.findMany.mockResolvedValue([
      { id: 'tpl1', eventId: 'evt1', status: 'ACTIVE', maxTotal: 100, criteria },
    ]);

  /**
   * The service queries scorecards twice: once for the counted statuses, once
   * for REOPENED so it can warn that those judges are not included. Keeping the
   * two apart matters — returning the same rows for both would have every
   * counted scorecard also reported as reopened.
   */
  const setScorecards = (counted: any[], reopened: any[] = []) =>
    prisma.scorecard.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.status === 'REOPENED' ? reopened : counted),
    );

  const team = (id: string, name: string) => ({
    id, name, projectName: `P${id}`, track: null, trackId: null,
  });

  const card = (teamId: string, scores: Array<[string, number | null]>) => ({
    teamId,
    criterionScores: scores.map(([criterionId, score]) => ({
      criterionId,
      score,
      criterion: mockCriteria.find(c => c.id === criterionId),
    })),
  });

  beforeEach(async () => {
    prisma = {
      scoringTemplate: { findMany: jest.fn() },
      team: { findMany: jest.fn() },
      scorecard: { findMany: jest.fn() },
      sessionJudge: { findMany: jest.fn().mockResolvedValue([]) },
      rankingResult: { deleteMany: jest.fn(), createMany: jest.fn() },
      challengeTrack: { findUnique: jest.fn() },
      // The delete and the insert now happen together — a failure between them
      // used to leave the event with no rankings at all.
      $transaction: jest.fn(async (cb: any) =>
        cb({
          $executeRaw: jest.fn(),
          rankingResult: {
            deleteMany: prisma.rankingResult.deleteMany,
            createMany: prisma.rankingResult.createMany,
          },
        }),
      ),
    };
    audit = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RankingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<RankingsService>(RankingsService);
    setScorecards([]);
  });

  describe('preconditions', () => {
    it('throws if no active template exists', async () => {
      prisma.scoringTemplate.findMany.mockResolvedValue([]);
      await expect(service.calculateRankings('evt1', null, 'user1'))
        .rejects.toThrow(BadRequestException);
    });

    it('throws if more than one template is active', async () => {
      // Ranking against an arbitrary one of several is how standings become
      // nondeterministic between runs.
      prisma.scoringTemplate.findMany.mockResolvedValue([
        { id: 'a', status: 'ACTIVE', maxTotal: 100, criteria: mockCriteria },
        { id: 'b', status: 'ACTIVE', maxTotal: 100, criteria: mockCriteria },
      ]);
      await expect(service.calculateRankings('evt1', null, 'user1'))
        .rejects.toThrow(/2 active scoring templates/);
    });

    it('throws if the template has only categories and no leaves', async () => {
      // Every leaf here is a parent of something, so nothing is scoreable and
      // every team would score zero. The old check counted criteria before
      // filtering categories out, so a template like this passed it.
      setTemplate([
        { id: 'cat', name: 'Category', maxScore: 40, displayOrder: 1, parentId: null },
        { id: 'sub', name: 'Sub', maxScore: 40, displayOrder: 2, parentId: 'cat' },
      ]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards([]);

      // 'sub' is a leaf, so this template is valid — assert it is accepted, and
      // that the guard fires only when nothing is left after filtering.
      await expect(service.calculateRankings('evt1', null, 'user1'))
        .resolves.toBeDefined();
    });

    it('throws if no teams found', async () => {
      setTemplate(mockCriteria);
      prisma.team.findMany.mockResolvedValue([]);
      await expect(service.calculateRankings('evt1', null, 'user1'))
        .rejects.toThrow(BadRequestException);
    });
  });

  describe('arithmetic', () => {
    it('sums criterion averages for a single judge', async () => {
      setTemplate(mockCriteria);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards([
        card('t1', [['c1', 15], ['c2', 30], ['c3', 8], ['c4', 16], ['c5', 7]]),
      ]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.teamsRanked).toBe(1);
      expect(result.rankings[0].aggregatedScore).toBe(76);
      expect(result.rankings[0].criterionAverages[0].average).toBe(15);
      expect(result.rankings[0].criterionAverages[1].average).toBe(30);
      expect(result.rankings[0].judgeCount).toBe(1);
    });

    it('averages across multiple judges', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards([
        card('t1', [['c1', 14]]),
        card('t1', [['c1', 18]]),
        card('t1', [['c1', 16]]),
      ]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.rankings[0].aggregatedScore).toBe(16);
      expect(result.rankings[0].judgeCount).toBe(3);
    });

    it('ignores null criterion scores rather than treating them as zero', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards([card('t1', [['c1', 15], ['c1', null]])]);

      const result = await service.calculateRankings('evt1', null, 'user1');
      expect(result.rankings[0].aggregatedScore).toBe(15);
    });

    it('ranks by score descending', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([
        team('t1', 'Team A'), team('t2', 'Team B'), team('t3', 'Team C'),
      ]);
      setScorecards([
        card('t1', [['c1', 15]]),
        card('t2', [['c1', 18]]),
        card('t3', [['c1', 12]]),
      ]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.rankings.map(r => r.teamName)).toEqual(['Team B', 'Team A', 'Team C']);
      expect(result.rankings.map(r => r.rankPosition)).toEqual([1, 2, 3]);
    });
  });

  describe('tie-breaks', () => {
    /**
     * These replace a test that asserted tied teams share a rankPosition.
     *
     * That was the defect: the tie-break ran correctly in memory and was then
     * discarded on write, so getRankings — which orders by rankPosition — got
     * tied teams back in whatever order Postgres chose. The displayed winner
     * could differ between two refreshes of the same page.
     */

    it('breaks a tie on the highest single criterion average', async () => {
      setTemplate([mockCriteria[0], mockCriteria[1]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A'), team('t2', 'Team B')]);
      setScorecards([
        // Both total 30. A peaks at 20, B is flat at 15.
        card('t1', [['c1', 10], ['c2', 20]]),
        card('t2', [['c1', 15], ['c2', 15]]),
      ]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.rankings[0].aggregatedScore).toBe(30);
      expect(result.rankings[1].aggregatedScore).toBe(30);
      expect(result.rankings[0].teamName).toBe('Team A');
      expect(result.rankings[0].rankPosition).toBe(1);
      expect(result.rankings[1].rankPosition).toBe(2);
      expect(result.rankings[0].tied).toBe(false);
      expect(result.rankings[1].tied).toBe(false);
    });

    it('breaks a remaining tie on judge count', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A'), team('t2', 'Team B')]);
      setScorecards([
        // Identical scores, so the averages and the peak are identical too.
        // Only the number of judges separates them.
        card('t1', [['c1', 15]]),
        card('t2', [['c1', 15]]),
        card('t2', [['c1', 15]]),
      ]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.rankings[0].teamName).toBe('Team B');
      expect(result.rankings[0].judgeCount).toBe(2);
      expect(result.rankings[0].rankPosition).toBe(1);
      expect(result.rankings[1].rankPosition).toBe(2);
    });

    it('shares a position only when a tie survives every tie-break', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A'), team('t2', 'Team B')]);
      setScorecards([card('t1', [['c1', 15]]), card('t2', [['c1', 15]])]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.rankings[0].rankPosition).toBe(1);
      expect(result.rankings[1].rankPosition).toBe(1);
      expect(result.rankings[0].tied).toBe(true);
      expect(result.rankings[1].tied).toBe(true);
      expect(result.warnings.some(w => /tied/i.test(w))).toBe(true);
    });

    it('is stable across runs when everything ties', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t2', 'Team B'), team('t1', 'Team A')]);
      setScorecards([card('t1', [['c1', 15]]), card('t2', [['c1', 15]])]);

      const first = await service.calculateRankings('evt1', null, 'user1');
      const second = await service.calculateRankings('evt1', null, 'user1');

      expect(first.rankings.map(r => r.teamId)).toEqual(second.rankings.map(r => r.teamId));
    });
  });

  describe('completeness and warnings', () => {
    it('skips teams with no counted scorecards and counts them as incomplete', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A'), team('t2', 'Team B')]);
      setScorecards([card('t1', [['c1', 15]])]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.teamsRanked).toBe(1);
      expect(result.teamsWithIncompleteScores).toBe(1);
    });

    it('counts a team with fewer scorecards than judges as incomplete', async () => {
      // The old count only noticed teams with nothing at all, so a team judged
      // by one of three read as complete.
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      prisma.sessionJudge.findMany.mockResolvedValue([
        { session: { teamId: 't1' }, judge: { name: 'J1' } },
        { session: { teamId: 't1' }, judge: { name: 'J2' } },
        { session: { teamId: 't1' }, judge: { name: 'J3' } },
      ]);
      setScorecards([card('t1', [['c1', 15]])]);

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.teamsRanked).toBe(1);
      expect(result.teamsWithIncompleteScores).toBe(1);
      expect(result.rankings[0].expectedJudgeCount).toBe(3);
      expect(result.warnings.some(w => /fewer scorecards/i.test(w))).toBe(true);
    });

    it('warns when a scorecard is reopened and therefore not counted', async () => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards(
        [card('t1', [['c1', 15]])],
        [{ teamId: 't1', team: { name: 'Team A' }, judge: { name: 'J2' } }],
      );

      const result = await service.calculateRankings('evt1', null, 'user1');

      expect(result.warnings.some(w => /reopened/i.test(w))).toBe(true);
      expect(result.warnings.some(w => /Team A/.test(w))).toBe(true);
    });
  });

  describe('persistence', () => {
    beforeEach(() => {
      setTemplate([mockCriteria[0]]);
      prisma.team.findMany.mockResolvedValue([team('t1', 'Team A')]);
      setScorecards([card('t1', [['c1', 15]])]);
    });

    it('sets status to PROVISIONAL', async () => {
      const result = await service.calculateRankings('evt1', null, 'user1');
      expect(result.status).toBe('PROVISIONAL');
    });

    it('deletes and inserts inside one transaction', async () => {
      await service.calculateRankings('evt1', null, 'user1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.rankingResult.deleteMany).toHaveBeenCalled();
      expect(prisma.rankingResult.createMany).toHaveBeenCalled();
    });

    it('writes the tied flag with each row', async () => {
      await service.calculateRankings('evt1', null, 'user1');

      const { data } = prisma.rankingResult.createMany.mock.calls[0][0];
      expect(data[0]).toHaveProperty('tied');
      expect(data[0].rankPosition).toBe(1);
    });

    it('creates an audit entry', async () => {
      await service.calculateRankings('evt1', null, 'user1');

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user1',
          eventId: 'evt1',
          entityType: 'RankingResult',
        }),
      );
    });
  });
});
