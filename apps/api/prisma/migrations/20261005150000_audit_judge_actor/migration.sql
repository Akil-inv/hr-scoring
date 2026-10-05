-- Judges act through their links and have no user account, so their actions
-- (scores, breaks) could not be written to the audit log: user_id is a
-- required link to users, and a judge's id is not a user. Record the judge in
-- their own column instead.
ALTER TABLE "audit_logs" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "audit_logs" ADD COLUMN "judge_id" UUID;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_judge_id_fkey"
  FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "audit_logs_judge_id_idx" ON "audit_logs"("judge_id");
