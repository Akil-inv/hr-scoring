-- AlterTable
ALTER TABLE "scorecards" ADD COLUMN IF NOT EXISTS "flagged_for_review" BOOLEAN NOT NULL DEFAULT false;
