import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScoringTemplatesService } from './scoring-templates.service';

/**
 * assertFits — the guard that keeps a category's rows inside its own budget.
 *
 * Live code for this event: Business Impact is a category of 40 with four rows
 * under it. Nothing covered it, and the failure mode if it stops working is the
 * quiet one — a rubric that adds up to more than 100, with every individual
 * score looking perfectly reasonable.
 *
 * Rule ids refer to docs/JUDGING-SPEC.md.
 */

const TEMPLATE_ID = 'tpl-1';
const CATEGORY_ID = 'cat-1';

function criterion(over: Partial<any> = {}): any {
  return {
    id: 'c-x',
    templateId: TEMPLATE_ID,
    parentId: null,
    name: 'Criterion',
    maxScore: 10,
    weight: 1,
    scoreIncrement: 1,
    displayOrder: 0,
    ...over,
  };
}

/**
 * @param criteria what the template contains
 * @param submitted how many scorecards have been submitted (0 keeps the
 *        structural lock open so assertFits is what is being tested)
 */
function build(criteria: any[], submitted = 0) {
  const prisma: any = {
    scoringTemplate: {
      findUnique: jest.fn().mockResolvedValue({
        id: TEMPLATE_ID,
        eventId: 'evt-1',
        maxTotal: 100,
        criteria,
      }),
    },
    scoringCriterion: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve(criterion({ id: 'new-1', ...data })),
      ),
      findUnique: jest.fn(),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve(criterion({ id: 'c-2', ...data })),
      ),
    },
    scorecard: { count: jest.fn().mockResolvedValue(submitted) },
    criterionScore: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn() },
  };
  const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new ScoringTemplatesService(prisma, audit),
    prisma,
    audit,
  };
}

function addInput(over: Partial<any> = {}): any {
  return {
    templateId: TEMPLATE_ID,
    parentId: CATEGORY_ID,
    name: 'A row',
    maxScore: 10,
    weight: 1,
    scoreIncrement: 1,
    ...over,
  };
}

describe('ScoringTemplatesService — category budget', () => {
  const category = criterion({
    id: CATEGORY_ID,
    name: 'Business Impact',
    maxScore: 40,
    parentId: null,
  });

  it('accepts a row that fits inside its category', async () => {
    const { service, prisma } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 15 }),
      criterion({ id: 'r2', parentId: CATEGORY_ID, maxScore: 10 }),
    ]);

    await expect(
      service.addCriterion(addInput({ maxScore: 15 }), 'user-1'),
    ).resolves.toBeDefined();
    expect(prisma.scoringCriterion.create).toHaveBeenCalled();
  });

  it('accepts a row that fills the category exactly', async () => {
    const { service } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 30 }),
    ]);

    await expect(
      service.addCriterion(addInput({ maxScore: 10 }), 'user-1'),
    ).resolves.toBeDefined();
  });

  it('refuses a row that would overflow its category', async () => {
    const { service, prisma } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 30 }),
    ]);

    await expect(
      service.addCriterion(addInput({ maxScore: 11 }), 'user-1'),
    ).rejects.toThrow(BadRequestException);

    // Nothing is written when the budget check fails.
    expect(prisma.scoringCriterion.create).not.toHaveBeenCalled();
  });

  it('names the category and both totals in the error', async () => {
    const { service } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 30 }),
    ]);

    await expect(
      service.addCriterion(addInput({ maxScore: 15 }), 'user-1'),
    ).rejects.toThrow(/Business Impact.*40.*45/s);
  });

  it('measures a row against its category, not the template total', async () => {
    // 45 fits inside a 100-point template but not inside a 40-point category.
    // Measuring against the template would let this through.
    const { service } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 20 }),
    ]);

    await expect(
      service.addCriterion(addInput({ maxScore: 25 }), 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a third level of nesting', async () => {
    const { service } = build([
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 20 }),
    ]);

    await expect(
      service.addCriterion(
        addInput({ parentId: 'r1', maxScore: 5 }),
        'user-1',
      ),
    ).rejects.toThrow(/two levels deep/);
  });

  it('refuses a row under a category that does not exist', async () => {
    const { service } = build([category]);

    await expect(
      service.addCriterion(addInput({ parentId: 'nope' }), 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ScoringTemplatesService — template budget', () => {
  it('accepts categories that fit the template total', async () => {
    const { service } = build([
      criterion({ id: 'cat-a', maxScore: 40 }),
      criterion({ id: 'cat-b', maxScore: 30 }),
    ]);

    await expect(
      service.addCriterion(
        addInput({ parentId: null, maxScore: 30 }),
        'user-1',
      ),
    ).resolves.toBeDefined();
  });

  it('refuses categories that would exceed the template total', async () => {
    const { service } = build([
      criterion({ id: 'cat-a', maxScore: 40 }),
      criterion({ id: 'cat-b', maxScore: 40 }),
    ]);

    await expect(
      service.addCriterion(
        addInput({ parentId: null, maxScore: 30 }),
        'user-1',
      ),
    ).rejects.toThrow(/110.*100/s);
  });
});

describe('ScoringTemplatesService — updating a row', () => {
  const category = criterion({ id: CATEGORY_ID, name: 'Business Impact', maxScore: 40 });

  function buildForUpdate(criteria: any[], target: any, submitted = 0) {
    const ctx = build(criteria, submitted);
    ctx.prisma.scoringCriterion.findUnique = jest.fn().mockResolvedValue({
      ...target,
      template: { id: TEMPLATE_ID, criteria },
    });
    return ctx;
  }

  it('excludes the row being updated from its own sibling total', async () => {
    // Category 40, siblings 20 and 10. Raising the 10 to 20 gives 40 exactly.
    // Counting the row twice would read 50 and reject a legal change.
    const rows = [
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 20 }),
      criterion({ id: 'r2', parentId: CATEGORY_ID, maxScore: 10 }),
    ];
    const { service } = buildForUpdate(
      rows,
      criterion({ id: 'r2', parentId: CATEGORY_ID, maxScore: 10 }),
    );

    await expect(
      service.updateCriterion('r2', { maxScore: 20 } as any, 'user-1'),
    ).resolves.toBeDefined();
  });

  it('still refuses an update that overflows the category', async () => {
    const rows = [
      category,
      criterion({ id: 'r1', parentId: CATEGORY_ID, maxScore: 20 }),
      criterion({ id: 'r2', parentId: CATEGORY_ID, maxScore: 10 }),
    ];
    const { service, prisma } = buildForUpdate(
      rows,
      criterion({ id: 'r2', parentId: CATEGORY_ID, maxScore: 10 }),
    );

    await expect(
      service.updateCriterion('r2', { maxScore: 25 } as any, 'user-1'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.scoringCriterion.update).not.toHaveBeenCalled();
  });
});

describe('ScoringTemplatesService — structural lock', () => {
  it('refuses a new criterion once any scorecard has been submitted', async () => {
    // A submitted score was measured against a definition. Changing the
    // definition afterwards changes what that score means, with nothing
    // recording that it happened.
    const { service, prisma } = build(
      [criterion({ id: CATEGORY_ID, maxScore: 40 })],
      3,
    );

    await expect(
      service.addCriterion(addInput({ maxScore: 5 }), 'user-1'),
    ).rejects.toThrow(/scorecard\(s\) have already been submitted/);
    expect(prisma.scoringCriterion.create).not.toHaveBeenCalled();
  });

  it('allows a name change after submission', async () => {
    const rows = [criterion({ id: 'r1', parentId: null, maxScore: 40 })];
    const ctx = build(rows, 3);
    ctx.prisma.scoringCriterion.findUnique = jest.fn().mockResolvedValue({
      ...rows[0],
      template: { id: TEMPLATE_ID, criteria: rows },
    });

    // Wording is not arithmetic — a typo correction must stay possible.
    await expect(
      ctx.service.updateCriterion('r1', { name: 'Renamed' } as any, 'user-1'),
    ).resolves.toBeDefined();
  });
});
