-- AlterTable
ALTER TABLE "session_judges" ADD COLUMN     "break_at" TIMESTAMP(3),
ADD COLUMN     "on_break" BOOLEAN NOT NULL DEFAULT false;
