-- DropForeignKey
ALTER TABLE "judge_availability" DROP CONSTRAINT "judge_availability_judge_id_fkey";

-- DropForeignKey
ALTER TABLE "judge_expertise" DROP CONSTRAINT "judge_expertise_judge_id_fkey";

-- AddForeignKey
ALTER TABLE "judge_availability" ADD CONSTRAINT "judge_availability_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_expertise" ADD CONSTRAINT "judge_expertise_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
