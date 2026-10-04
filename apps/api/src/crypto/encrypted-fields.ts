/**
 * Which columns are stored encrypted, and how.
 *
 *   text    random IV: free text, contacts, comments. Cannot be searched.
 *   det     deterministic: the same value always gives the same stored value,
 *           so exact-match lookups and unique keys keep working (a candidate's
 *           name within an event).
 *   detLower deterministic on the trimmed, lower-cased value (emails, which
 *           are matched without regard to case).
 *   bytes   binary (the PDF reports).
 *   json    the whole JSON value, stored as {"__enc": "..."}.
 *
 * Numbers and yes/no answers (scores, the support question) cannot be held
 * encrypted in a number column, so each has a text "shadow" column. On write
 * the value goes to the shadow, encrypted, and the number column is left
 * empty; on read it is put back. Callers keep using `score`, `totalScore`
 * and `support` as before.
 *
 * Table and column names are listed for the backfill, which works in SQL.
 */
export type Kind = 'text' | 'det' | 'detLower' | 'bytes' | 'json';

export type ModelSpec = {
  table: string;
  fields: Record<string, { column: string; kind: Kind }>;
  shadows?: Record<string, { column: string; shadow: string; shadowColumn: string; type: 'number' | 'boolean' }>;
};

const t = (column: string): { column: string; kind: Kind } => ({ column, kind: 'text' });

export const ENCRYPTED: Record<string, ModelSpec> = {
  User: {
    table: 'users',
    fields: { documentPassword: t('document_password') },
  },
  Team: {
    table: 'teams',
    fields: {
      name: { column: 'name', kind: 'det' },
      projectName: t('project_name'),
      useCaseTitle: t('use_case_title'),
      problemStatement: t('problem_statement'),
      solutionSummary: t('solution_summary'),
      teamLeadName: t('team_lead_name'),
      teamLeadEmail: t('team_lead_email'),
      eligibilityNotes: t('eligibility_notes'),
    },
  },
  TeamMember: {
    table: 'team_members',
    fields: { name: t('name'), email: t('email') },
  },
  Judge: {
    table: 'judges',
    fields: {
      name: t('name'),
      email: { column: 'email', kind: 'detLower' },
      phone: t('phone'),
      organisation: t('organisation'),
      designation: t('designation'),
    },
  },
  JudgeMessage: { table: 'judge_messages', fields: { body: t('body') } },
  ConflictDeclaration: { table: 'conflict_declarations', fields: { reason: t('reason') } },
  JudgingSession: { table: 'judging_sessions', fields: { notes: t('notes') } },
  Scorecard: {
    table: 'scorecards',
    fields: {
      overallStrengths: t('overall_strengths'),
      areasForImprovement: t('areas_for_improvement'),
      recommendation: t('recommendation'),
      reopenReason: t('reopen_reason'),
    },
    shadows: {
      totalScore: { column: 'total_score', shadow: 'totalScoreEnc', shadowColumn: 'total_score_enc', type: 'number' },
      support: { column: 'support', shadow: 'supportEnc', shadowColumn: 'support_enc', type: 'boolean' },
    },
  },
  CriterionScore: {
    table: 'criterion_scores',
    fields: { comment: t('comment') },
    shadows: { score: { column: 'score', shadow: 'scoreEnc', shadowColumn: 'score_enc', type: 'number' } },
  },
  TeamDecision: {
    table: 'team_decisions',
    fields: { feedback: t('feedback'), reopenReason: t('reopen_reason') },
  },
  DecisionReport: {
    table: 'decision_reports',
    fields: { pdf: { column: 'pdf', kind: 'bytes' }, fileName: t('file_name'), supersededReason: t('superseded_reason') },
  },
  AuditLog: {
    table: 'audit_logs',
    fields: {
      oldValues: { column: 'old_values', kind: 'json' },
      newValues: { column: 'new_values', kind: 'json' },
      reason: t('reason'),
    },
  },
};

/** Shadow column name → the field it stands for, for reading results back. */
export const SHADOW_OF: Record<string, { field: string; type: 'number' | 'boolean' }> = {};
for (const spec of Object.values(ENCRYPTED)) {
  for (const [field, s] of Object.entries(spec.shadows ?? {})) SHADOW_OF[s.shadow] = { field, type: s.type };
}
