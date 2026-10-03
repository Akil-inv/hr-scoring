-- CreateEnum
CREATE TYPE "RankingStatus" AS ENUM ('CALCULATING', 'PROVISIONAL', 'APPROVED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "ranking_results" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "track_id" UUID,
    "team_id" UUID NOT NULL,
    "rank_position" INTEGER NOT NULL,
    "aggregated_score" DECIMAL(6,2) NOT NULL,
    "judge_count" INTEGER NOT NULL,
    "aggregation_method" TEXT NOT NULL DEFAULT 'criterion_average_sum',
    "status" "RankingStatus" NOT NULL DEFAULT 'CALCULATING',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "judgingSessionId" UUID,

    CONSTRAINT "ranking_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ranking_results_event_id_track_id_team_id_key" ON "ranking_results"("event_id", "track_id", "team_id");

-- AddForeignKey
ALTER TABLE "ranking_results" ADD CONSTRAINT "ranking_results_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_results" ADD CONSTRAINT "ranking_results_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "challenge_tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_results" ADD CONSTRAINT "ranking_results_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_results" ADD CONSTRAINT "ranking_results_judgingSessionId_fkey" FOREIGN KEY ("judgingSessionId") REFERENCES "judging_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
