-- Day-based judging for events set up by Excel upload: judging days that can
-- be closed, stored judge links that can be revoked, per-team decisions, and
-- removal of absent judges from a panel. Additive only: every existing event
-- keeps setup_mode WIZARD and behaves exactly as before.

-- CreateEnum
CREATE TYPE "EventSetupMode" AS ENUM ('WIZARD', 'UPLOAD');

-- CreateEnum
CREATE TYPE "JudgingDayStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JudgeLinkScope" AS ENUM ('DAY', 'SESSION');

-- CreateEnum
CREATE TYPE "TeamDecisionValue" AS ENUM ('SELECTED', 'WAITLIST', 'NOT_SELECTED');

-- CreateEnum
CREATE TYPE "TeamDecisionStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "setup_mode" "EventSetupMode" NOT NULL DEFAULT 'WIZARD';

-- AlterTable
ALTER TABLE "session_judges" ADD COLUMN     "removed_at" TIMESTAMP(3),
ADD COLUMN     "removed_reason" TEXT;

-- CreateTable
CREATE TABLE "judging_days" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "JudgingDayStatus" NOT NULL DEFAULT 'OPEN',
    "closed_by" UUID,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "judging_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judge_links" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "judge_id" UUID NOT NULL,
    "scope" "JudgeLinkScope" NOT NULL,
    "day_id" UUID,
    "session_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "judge_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_decisions" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "decision" "TeamDecisionValue",
    "feedback" TEXT,
    "status" "TeamDecisionStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "judging_days_event_id_date_key" ON "judging_days"("event_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "judge_links_token_key" ON "judge_links"("token");

-- CreateIndex
CREATE INDEX "judge_links_judge_id_idx" ON "judge_links"("judge_id");

-- CreateIndex
CREATE INDEX "judge_links_day_id_idx" ON "judge_links"("day_id");

-- CreateIndex
CREATE INDEX "judge_links_session_id_idx" ON "judge_links"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_decisions_team_id_key" ON "team_decisions"("team_id");

-- CreateIndex
CREATE INDEX "team_decisions_event_id_idx" ON "team_decisions"("event_id");

-- CreateIndex
CREATE INDEX "team_decisions_session_id_idx" ON "team_decisions"("session_id");

-- AddForeignKey
ALTER TABLE "judging_days" ADD CONSTRAINT "judging_days_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judging_days" ADD CONSTRAINT "judging_days_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_links" ADD CONSTRAINT "judge_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_links" ADD CONSTRAINT "judge_links_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_links" ADD CONSTRAINT "judge_links_day_id_fkey" FOREIGN KEY ("day_id") REFERENCES "judging_days"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_links" ADD CONSTRAINT "judge_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "judging_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_links" ADD CONSTRAINT "judge_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_decisions" ADD CONSTRAINT "team_decisions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_decisions" ADD CONSTRAINT "team_decisions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_decisions" ADD CONSTRAINT "team_decisions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "judging_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_decisions" ADD CONSTRAINT "team_decisions_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
