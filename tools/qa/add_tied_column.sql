-- RANK-4: a shared rank position must be a stated outcome, not an artefact.
-- Run before deploying the new rankings service.
ALTER TABLE ranking_results
  ADD COLUMN IF NOT EXISTS tied BOOLEAN NOT NULL DEFAULT false;
