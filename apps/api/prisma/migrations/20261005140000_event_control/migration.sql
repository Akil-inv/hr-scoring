-- Event Control: retention, marking done, who added whom.
ALTER TABLE "events"
  ADD COLUMN "retention_months" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "retention_extra_months" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "done_at" TIMESTAMP(3),
  ADD COLUMN "done_by" UUID;

ALTER TABLE "event_users" ADD COLUMN "added_by" UUID;

-- Retention counts from the close date: events closed before it was kept get
-- their last update as the close date.
UPDATE "events" SET "closed_at" = "updated_at"
WHERE "status" IN ('COMPLETED', 'ARCHIVED') AND "closed_at" IS NULL;

-- What someone may do on an event is now decided by their role on it, where
-- until now their platform role decided and the role on an assignment was
-- never used. So existing assignments take the person's platform role: each
-- keeps exactly the rights they have today.
UPDATE "event_users" eu SET "role" = (u."role"::text)::"EventRole"
FROM "users" u
WHERE eu."user_id" = u."id"
  AND u."role"::text IN ('ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR')
  AND eu."role"::text <> u."role"::text;

-- Events are now private to the people on them. Until now, anyone with no
-- assignment at all could reach every event; put each of them on every
-- current event, in the role they hold today, so nobody loses access on
-- deploy. People already assigned to some events keep exactly those.
INSERT INTO "event_users" ("id", "user_id", "event_id", "role", "created_at")
SELECT gen_random_uuid(), u."id", e."id", (u."role"::text)::"EventRole", CURRENT_TIMESTAMP
FROM "users" u
CROSS JOIN "events" e
WHERE u."role"::text IN ('ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR')
  AND u."email" NOT LIKE '%@deleted.invalid'
  AND e."deleted_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "event_users" x WHERE x."user_id" = u."id")
ON CONFLICT ("user_id", "event_id") DO NOTHING;
