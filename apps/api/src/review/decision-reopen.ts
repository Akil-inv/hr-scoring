import { Prisma } from '@prisma/client';

/**
 * Reopen HR's submitted decision on a team for revision: back to a draft at
 * the next revision, the reason recorded, and the current report kept but
 * marked superseded. The judges' scores are not touched. Does nothing when
 * the team has no submitted decision.
 */
export async function supersedeDecision(
  tx: Prisma.TransactionClient, teamId: string, reason: string, userId: string,
): Promise<boolean> {
  const d = await tx.teamDecision.findUnique({ where: { teamId } });
  if (!d || d.status !== 'SUBMITTED') return false;
  const now = new Date();
  await tx.decisionReport.updateMany({
    where: { decisionId: d.id, supersededAt: null },
    data: { supersededAt: now, supersededReason: reason },
  });
  await tx.teamDecision.update({
    where: { id: d.id },
    data: {
      status: 'DRAFT',
      revision: d.revision + 1,
      decidedAt: null,
      decidedById: null,
      reopenedAt: now,
      reopenedById: userId,
      reopenReason: reason,
    },
  });
  return true;
}
