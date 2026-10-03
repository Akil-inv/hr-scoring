-- AlterTable
ALTER TABLE "scoring_criteria" ADD COLUMN IF NOT EXISTS "parent_id" UUID;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "scoring_criteria" ADD CONSTRAINT "scoring_criteria_parent_id_fkey"
        FOREIGN KEY ("parent_id") REFERENCES "scoring_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
