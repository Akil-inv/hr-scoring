-- Closing days and the event, reopening a decided record, and the
-- "Did not attend" outcome.

ALTER TYPE "TeamDecisionValue" ADD VALUE IF NOT EXISTS 'DID_NOT_ATTEND';

ALTER TABLE "team_decisions" ADD COLUMN "reopened_at" TIMESTAMP(3);
ALTER TABLE "team_decisions" ADD COLUMN "reopened_by" UUID;
ALTER TABLE "team_decisions" ADD COLUMN "reopen_reason" TEXT;

ALTER TABLE "decision_reports" ADD COLUMN "superseded_at" TIMESTAMP(3);
ALTER TABLE "decision_reports" ADD COLUMN "superseded_reason" TEXT;

ALTER TABLE "events" ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "events" ADD COLUMN "closed_by" UUID;
