-- Interview events: slots carry their block and position, each slot has its
-- own judge panel built from availability, and a day's panels can be locked.

-- AlterEnum
ALTER TYPE "SlotType" ADD VALUE 'CALIBRATION';

-- AlterTable
ALTER TABLE "time_slots" ADD COLUMN     "block" TEXT,
ADD COLUMN     "sequence" INTEGER;

-- AlterTable
ALTER TABLE "judging_days" ADD COLUMN     "panels_locked_at" TIMESTAMP(3),
ADD COLUMN     "panels_locked_by" UUID;

-- CreateTable
CREATE TABLE "slot_judges" (
    "id" UUID NOT NULL,
    "time_slot_id" UUID NOT NULL,
    "judge_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slot_judges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slot_judges_judge_id_idx" ON "slot_judges"("judge_id");

-- CreateIndex
CREATE UNIQUE INDEX "slot_judges_time_slot_id_judge_id_key" ON "slot_judges"("time_slot_id", "judge_id");

-- AddForeignKey
ALTER TABLE "judging_days" ADD CONSTRAINT "judging_days_panels_locked_by_fkey" FOREIGN KEY ("panels_locked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_judges" ADD CONSTRAINT "slot_judges_time_slot_id_fkey" FOREIGN KEY ("time_slot_id") REFERENCES "time_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_judges" ADD CONSTRAINT "slot_judges_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
