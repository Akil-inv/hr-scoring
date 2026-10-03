-- Session 2 schema: RBAC, user name/phone, judge phone, session-swap index drop.
--
-- Written to be idempotent so it applies cleanly to BOTH:
--   * a clean database (local `prisma migrate reset`)
--   * EC2, where every object below already exists from manual SQL
--
-- Postgres has no IF NOT EXISTS for CREATE TYPE or ADD CONSTRAINT, so those
-- are wrapped in DO blocks that swallow duplicate_object.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "EventRole" AS ENUM ('ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

-- DropIndex
-- Removed so judging sessions can be swapped atomically via raw SQL.
DROP INDEX IF EXISTS "judging_sessions_team_id_time_slot_id_key";

-- AlterTable
ALTER TABLE "judges" ADD COLUMN IF NOT EXISTS "phone" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_users" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "role" "EventRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "event_users_user_id_event_id_key" ON "event_users"("user_id", "event_id");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_users" ADD CONSTRAINT "event_users_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_users" ADD CONSTRAINT "event_users_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
