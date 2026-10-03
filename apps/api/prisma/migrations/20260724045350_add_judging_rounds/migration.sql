-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('PENDING', 'SCHEDULING', 'SCHEDULED', 'IN_PROGRESS', 'SCORING', 'CALCULATING', 'COMPLETED');

-- AlterTable
ALTER TABLE "judging_sessions" ADD COLUMN     "round_id" UUID;

-- CreateTable
CREATE TABLE "judging_rounds" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "round_number" INTEGER NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'PENDING',
    "allowed_tiers" TEXT[],
    "team_count" INTEGER,
    "advance_count" INTEGER,
    "scoring_template_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "judging_rounds_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "judging_sessions" ADD CONSTRAINT "judging_sessions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "judging_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judging_rounds" ADD CONSTRAINT "judging_rounds_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
