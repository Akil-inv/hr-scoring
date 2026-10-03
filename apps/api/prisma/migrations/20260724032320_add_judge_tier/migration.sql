-- CreateEnum
CREATE TYPE "JudgeTier" AS ENUM ('L1', 'L2', 'L3');

-- AlterTable
ALTER TABLE "judges" ADD COLUMN     "judge_tier" "JudgeTier" NOT NULL DEFAULT 'L1';
