-- Scores in steps finer than whole numbers (e.g. 3.75 on a 1-5 rating).
-- Existing whole-number scores convert exactly.

ALTER TABLE "criterion_scores" ALTER COLUMN "score" TYPE DOUBLE PRECISION;
ALTER TABLE "scorecards" ALTER COLUMN "total_score" TYPE DOUBLE PRECISION;
ALTER TABLE "scoring_criteria" ALTER COLUMN "score_increment" TYPE DECIMAL(4,2);
