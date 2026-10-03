-- Rating rubrics (e.g. LAP: five dimensions scored 1-5), the judges' Yes/No
-- support question, and the PDF report stored when HR submits a decision.

ALTER TABLE "scoring_templates" ADD COLUMN "scale" TEXT NOT NULL DEFAULT 'POINTS';
ALTER TABLE "scoring_templates" ADD COLUMN "support_question" TEXT;

ALTER TABLE "scoring_criteria" ADD COLUMN "min_score" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "scorecards" ADD COLUMN "support" BOOLEAN;

CREATE TABLE "decision_reports" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "pdf" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "decision_reports_decision_id_revision_key" ON "decision_reports"("decision_id", "revision");
CREATE INDEX "decision_reports_event_id_idx" ON "decision_reports"("event_id");

ALTER TABLE "decision_reports" ADD CONSTRAINT "decision_reports_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "team_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
