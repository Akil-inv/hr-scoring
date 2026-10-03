-- AlterTable
ALTER TABLE "judges" ADD COLUMN IF NOT EXISTS "is_standby" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "has_video_conferencing" BOOLEAN NOT NULL DEFAULT false;
