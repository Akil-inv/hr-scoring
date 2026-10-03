import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { CreateScoringTemplateInput, UpdateScoringTemplateInput, AddCriterionInput, UpdateCriterionInput, ReorderCriterionInput } from './scoring-templates.types';
import { UOB_RUBRIC } from './uob-rubric';

@Injectable()
export class ScoringTemplatesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private enrichTemplate(t: any) {
    const all = t.criteria || [];

    // Only top-level criteria count toward the template total. A row's score
    // is already represented by its category, so summing everything would
    // double-count.
    const criteriaTotal = all
      .filter((c: any) => !c.parentId)
      .reduce((sum: number, c: any) => sum + c.maxScore, 0);

    const childSums = new Map<string, number>();
    for (const c of all) {
      if (!c.parentId) continue;
      childSums.set(c.parentId, (childSums.get(c.parentId) || 0) + c.maxScore);
    }

    return {
      ...t,
      criteriaTotal,
      criteria: all.map((c: any) => ({
        ...c,
        weight: Number(c.weight),
        scoreIncrement: Number(c.scoreIncrement),
        childrenTotal: childSums.get(c.id) || 0,
      })),
    };
  }

  /**
   * A row is measured against its category; a category against the template.
   * Measuring a row against the template total would let five rows of 10 sit
   * inside a category of 40 without complaint.
   */
  private async assertFits(
    templateId: string,
    parentId: string | null | undefined,
    maxScore: number,
    excludingCriterionId?: string,
  ) {
    const template = await this.prisma.scoringTemplate.findUnique({
      where: { id: templateId },
      include: { criteria: true },
    });
    if (!template) throw new NotFoundException('Scoring template not found');

    if (parentId) {
      const parent = template.criteria.find(c => c.id === parentId);
      if (!parent) throw new NotFoundException('Category not found');
      if ((parent as any).parentId) {
        throw new BadRequestException(
          'Criteria are two levels deep. Add rows under a category, not under another row.',
        );
      }

      const siblings = template.criteria
        .filter(c => (c as any).parentId === parentId && c.id !== excludingCriterionId)
        .reduce((sum, c) => sum + c.maxScore, 0);

      if (siblings + maxScore > parent.maxScore) {
        throw new BadRequestException(
          `"${parent.name}" allows ${parent.maxScore} points. Its rows would total ` +
          `${siblings + maxScore}. Reduce this row or raise the category.`,
        );
      }
      return;
    }

    const otherCategories = template.criteria
      .filter(c => !(c as any).parentId && c.id !== excludingCriterionId)
      .reduce((sum, c) => sum + c.maxScore, 0);

    if (otherCategories + maxScore > template.maxTotal) {
      throw new BadRequestException(
        `Categories would total ${otherCategories + maxScore}, over the ${template.maxTotal} available.`,
      );
    }
  }

  /**
   * Create every category and row from the standard rubric in one go.
   *
   * Twelve rows across five categories is a lot to type into a wizard, and
   * getting the totals to balance by hand is fiddly. Everything created here
   * is ordinary data — rename it, reweight it, delete it.
   */
  /**
   * Refuse structural changes once any judge has submitted.
   *
   * A submitted score was measured against a definition. Change the definition
   * afterwards and the score means something different, with nothing recording
   * that it happened — the worst kind of data problem, because it is invisible.
   *
   * Deliberately triggered by submission rather than by the schedule existing.
   * A rubric and a schedule are independent; a coordinator fixing a typo the day
   * after generating the schedule is doing nothing wrong, and a lock that fires
   * then only teaches people to work around it.
   */
  private async assertNotScoring(templateId: string, what: string) {
    const template = await this.prisma.scoringTemplate.findUnique({
      where: { id: templateId },
      select: { eventId: true },
    });
    if (!template) return;

    const submitted = await this.prisma.scorecard.count({
      where: {
        eventId: template.eventId,
        status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] },
      },
    });

    if (submitted > 0) {
      throw new BadRequestException(
        `${what} cannot be changed — ${submitted} scorecard(s) have already been ` +
        'submitted against this rubric. Changing it now would silently alter what ' +
        'those scores mean. Names and descriptions can still be corrected.',
      );
    }
  }

  /**
   * Give existing scorecards a row for a newly added criterion.
   *
   * Between the schedule being built and the first submission, scorecards exist
   * with a fixed set of rows. Adding a criterion without this leaves them one
   * row short, and a judge would score eleven of twelve without being told.
   */
  private async backfillCriterion(templateId: string, criterionId: string) {
    const template = await this.prisma.scoringTemplate.findUnique({
      where: { id: templateId },
      select: { eventId: true },
    });
    if (!template) return;

    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId: template.eventId },
      select: { id: true },
    });

    for (const sc of scorecards) {
      await this.prisma.criterionScore.upsert({
        where: { scorecardId_criterionId: { scorecardId: sc.id, criterionId } },
        create: { scorecardId: sc.id, criterionId },
        update: {},
      });
    }

    return scorecards.length;
  }

  /** Whether the rubric is closed to structural change, and why. */
  async lockState(eventId: string) {
    const submittedCount = await this.prisma.scorecard.count({
      where: {
        eventId,
        status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] },
      },
    });
    return { locked: submittedCount > 0, submittedCount };
  }

  async loadStandardRubric(eventId: string, userId: string) {
    const existing = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: true },
    });

    // Replacing the rubric wholesale is the most destructive edit of all.
    if (existing) await this.assertNotScoring(existing.id, 'The rubric');

    if (existing && existing.criteria.length > 0) {
      throw new BadRequestException(
        'This event already has scoring criteria. Clear them before loading the standard rubric.',
      );
    }

    const template = existing ?? await this.prisma.scoringTemplate.create({
      data: { eventId, name: UOB_RUBRIC.name, description: UOB_RUBRIC.description },
    });

    let order = 0;
    let categoriesCreated = 0;
    let rowsCreated = 0;

    for (const cat of UOB_RUBRIC.categories) {
      const category = await this.prisma.scoringCriterion.create({
        data: {
          templateId: template.id,
          name: cat.name,
          description: cat.description,
          maxScore: cat.maxScore,
          weight: 1.0,
          displayOrder: order++,
        },
      });
      categoriesCreated++;

      for (const row of cat.rows) {
        await this.prisma.scoringCriterion.create({
          data: {
            templateId: template.id,
            parentId: category.id,
            name: row.name,
            maxScore: row.maxScore,
            weight: 1.0,
            displayOrder: order++,
            guidanceText: row.guidanceText,
            requiresComment: row.requiresComment ?? false,
          },
        });
        rowsCreated++;
      }
    }

    await this.audit.log({
      userId, eventId,
      action: AuditAction.CREATE, entityType: 'ScoringTemplate',
      entityId: template.id,
      newValues: { source: 'standard rubric', categoriesCreated, rowsCreated },
    });

    return { templateId: template.id, categoriesCreated, rowsCreated };
  }

  /**
   * Marks a rubric finished, so judges can score against it.
   *
   * Templates are created DRAFT and nothing used to move them on. Scoring and
   * ranking both refuse a draft — correctly, since a rubric mid-edit is not
   * something a score should be measured against — but with no control to
   * clear it a coordinator reached a state they could not leave: a rubric that
   * balanced perfectly, a green tick on the page, and judges told the template
   * was still a draft.
   *
   * The only condition is arithmetic. Where the criteria came from — the
   * standard rubric or typed in by hand — is not this method's business.
   */
  async activate(templateId: string, userId: string) {
    const template = await this.prisma.scoringTemplate.findUnique({
      where: { id: templateId },
      include: { criteria: true },
    });
    if (!template) throw new NotFoundException('Scoring template not found');

    if (template.status === 'ACTIVE') return this.findOne(templateId);
    if (template.status === 'LOCKED') {
      throw new BadRequestException(
        'This rubric is locked. Scores have already been submitted against it.',
      );
    }

    const categories = template.criteria.filter((c) => !(c as any).parentId);
    if (categories.length === 0) {
      throw new BadRequestException(
        'Add at least one category before marking the rubric done.',
      );
    }

    const total = categories.reduce((sum, c) => sum + c.maxScore, 0);
    if (total !== template.maxTotal) {
      throw new BadRequestException(
        `Categories total ${total}, not ${template.maxTotal}. A rubric that ` +
          'does not add up cannot be scored against.',
      );
    }

    // Every category's rows must fill it exactly. A category of 40 holding
    // rows worth 30 means ten points nobody can award.
    for (const cat of categories) {
      const rows = template.criteria.filter((c) => (c as any).parentId === cat.id);
      if (rows.length === 0) {
        throw new BadRequestException(
          `"${cat.name}" has no rows. Every category needs something to score.`,
        );
      }
      const used = rows.reduce((sum, r) => sum + r.maxScore, 0);
      if (used !== cat.maxScore) {
        throw new BadRequestException(
          `"${cat.name}" allows ${cat.maxScore} points but its rows total ${used}.`,
        );
      }
    }

    const updated = await this.prisma.scoringTemplate.update({
      where: { id: templateId },
      data: { status: 'ACTIVE' },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });

    await this.audit.log({
      userId,
      eventId: template.eventId,
      action: AuditAction.UPDATE,
      entityType: 'ScoringTemplate',
      entityId: templateId,
      oldValues: { status: template.status },
      newValues: {
        status: 'ACTIVE',
        maxTotal: template.maxTotal,
        categories: categories.length,
        rows: template.criteria.length - categories.length,
      },
    });

    return this.enrichTemplate(updated);
  }

  async create(input: CreateScoringTemplateInput, userId: string) {
    const template = await this.prisma.scoringTemplate.create({
      data: input,
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'ScoringTemplate',
      entityId: template.id, newValues: { name: template.name },
    });

    return this.enrichTemplate(template);
  }

  async update(id: string, input: UpdateScoringTemplateInput, userId: string) {
    const existing = await this.prisma.scoringTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Scoring template not found');

    const updated = await this.prisma.scoringTemplate.update({
      where: { id }, data: input,
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'ScoringTemplate',
      entityId: id, oldValues: existing, newValues: updated,
    });

    return this.enrichTemplate(updated);
  }

  async findOne(id: string) {
    const t = await this.prisma.scoringTemplate.findUnique({
      where: { id },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Scoring template not found');
    return this.enrichTemplate(t);
  }

  async findByEvent(eventId: string) {
    const templates = await this.prisma.scoringTemplate.findMany({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return templates.map(t => this.enrichTemplate(t));
  }

  async addCriterion(input: AddCriterionInput, userId: string) {
    await this.assertNotScoring(input.templateId, 'Criteria');
    const template = await this.prisma.scoringTemplate.findUnique({
      where: { id: input.templateId },
      include: { criteria: true },
    });
    if (!template) throw new NotFoundException('Scoring template not found');

    await this.assertFits(input.templateId, input.parentId, input.maxScore);

    const maxOrder = template.criteria.reduce((max, c) => Math.max(max, c.displayOrder), -1);

    const criterion = await this.prisma.scoringCriterion.create({
      data: {
        templateId: input.templateId,
        parentId: input.parentId || null,
        name: input.name,
        description: input.description,
        maxScore: input.maxScore,
        weight: input.weight,
        displayOrder: maxOrder + 1,
        guidanceText: input.guidanceText,
        scoringAnchors: input.scoringAnchors || undefined,
        requiresComment: input.requiresComment,
        scoreIncrement: input.scoreIncrement,
      },
    });

    await this.audit.log({
      userId, eventId: template.eventId,
      action: AuditAction.CREATE, entityType: 'ScoringCriterion',
      entityId: criterion.id, newValues: { name: criterion.name, maxScore: criterion.maxScore },
    });

    return {
      ...criterion,
      weight: Number(criterion.weight),
      scoreIncrement: Number(criterion.scoreIncrement),
    };
  }

  async updateCriterion(id: string, input: UpdateCriterionInput, userId: string) {
    const existing = await this.prisma.scoringCriterion.findUnique({
      where: { id },
      include: { template: { include: { criteria: true } } },
    });
    if (!existing) throw new NotFoundException('Criterion not found');

    // Wording can always be corrected — a typo does not change the arithmetic.
    // Anything that changes what a score means cannot.
    const structural =
      input.maxScore !== undefined ||
      input.weight !== undefined ||
      input.parentId !== undefined ||
      input.scoreIncrement !== undefined ||
      input.requiresComment !== undefined ||
      input.scoringAnchors !== undefined;

    if (structural) {
      await this.assertNotScoring(existing.templateId, 'Scoring structure');
    }

    if (input.maxScore !== undefined) {
      await this.assertFits(
        existing.templateId,
        (existing as any).parentId,
        input.maxScore,
        id,
      );
    }

    const updated = await this.prisma.scoringCriterion.update({
      where: { id }, data: input,
    });

    return {
      ...updated,
      weight: Number(updated.weight),
      scoreIncrement: Number(updated.scoreIncrement),
    };
  }

  async removeCriterion(id: string, userId: string) {
    const target = await this.prisma.scoringCriterion.findUnique({
      where: { id }, select: { templateId: true },
    });
    if (target) await this.assertNotScoring(target.templateId, 'Criteria');
    const existing = await this.prisma.scoringCriterion.findUnique({
      where: { id },
      include: { template: true },
    });
    if (!existing) throw new NotFoundException('Criterion not found');

    // Score rows reference the criterion and do not cascade, so the delete would
    // otherwise fail on a foreign key with nothing a coordinator could act on.
    //
    // Only rows on unsubmitted scorecards are removed. The criteria lock already
    // refuses this once anything is submitted, and this is the second guard: a
    // criterion that submitted scores were measured against is part of the
    // record of how they were arrived at.
    const scored = await this.prisma.criterionScore.count({
      where: {
        criterionId: id,
        scorecard: { status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] } },
      },
    });

    if (scored > 0) {
      throw new BadRequestException(
        `This criterion has been scored on ${scored} submitted scorecard(s). ` +
        'Removing it would change what those scores measured.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.criterionScore.deleteMany({ where: { criterionId: id } });
      await tx.scoringCriterion.delete({ where: { id } });
    });

    await this.audit.log({
      userId, eventId: existing.template.eventId,
      action: AuditAction.DELETE, entityType: 'ScoringCriterion',
      entityId: id, oldValues: { name: existing.name, maxScore: existing.maxScore },
    });

    return true;
  }

  async reorderCriteria(inputs: ReorderCriterionInput[]) {
    for (const input of inputs) {
      await this.prisma.scoringCriterion.update({
        where: { id: input.id },
        data: { displayOrder: input.displayOrder },
      });
    }
    return true;
  }
}
