-- CreateEnum
CREATE TYPE "SessionStage" AS ENUM ('SCHEDULED', 'TEAM_CHECKED_IN', 'JUDGES_PRESENT', 'READY', 'IN_PROGRESS', 'QA', 'SCORING', 'COMPLETED', 'DELAYED', 'AT_RISK', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ScorecardStatus" AS ENUM ('NOT_STARTED', 'DRAFT', 'SUBMITTED', 'REOPENED', 'RESUBMITTED', 'LOCKED');

-- CreateTable
CREATE TABLE "judging_sessions" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "time_slot_id" UUID NOT NULL,
    "stage" "SessionStage" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_start" TIMESTAMPTZ,
    "scheduled_end" TIMESTAMPTZ,
    "actual_start" TIMESTAMPTZ,
    "actual_end" TIMESTAMPTZ,
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "delay_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "judging_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_judges" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "judge_id" UUID NOT NULL,
    "attended" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_judges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "judge_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" "ScorecardStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "total_score" INTEGER,
    "overall_strengths" TEXT,
    "areas_for_improvement" TEXT,
    "recommendation" TEXT,
    "conflict_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "reopen_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "criterion_scores" (
    "id" UUID NOT NULL,
    "scorecard_id" UUID NOT NULL,
    "criterion_id" UUID NOT NULL,
    "score" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "criterion_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "judging_sessions_team_id_time_slot_id_key" ON "judging_sessions"("team_id", "time_slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "judging_sessions_room_id_time_slot_id_key" ON "judging_sessions"("room_id", "time_slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_judges_session_id_judge_id_key" ON "session_judges"("session_id", "judge_id");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_session_id_judge_id_key" ON "scorecards"("session_id", "judge_id");

-- CreateIndex
CREATE UNIQUE INDEX "criterion_scores_scorecard_id_criterion_id_key" ON "criterion_scores"("scorecard_id", "criterion_id");

-- AddForeignKey
ALTER TABLE "judging_sessions" ADD CONSTRAINT "judging_sessions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judging_sessions" ADD CONSTRAINT "judging_sessions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judging_sessions" ADD CONSTRAINT "judging_sessions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judging_sessions" ADD CONSTRAINT "judging_sessions_time_slot_id_fkey" FOREIGN KEY ("time_slot_id") REFERENCES "time_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_judges" ADD CONSTRAINT "session_judges_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "judging_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_judges" ADD CONSTRAINT "session_judges_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "judging_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_scores" ADD CONSTRAINT "criterion_scores_scorecard_id_fkey" FOREIGN KEY ("scorecard_id") REFERENCES "scorecards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_scores" ADD CONSTRAINT "criterion_scores_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "scoring_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
