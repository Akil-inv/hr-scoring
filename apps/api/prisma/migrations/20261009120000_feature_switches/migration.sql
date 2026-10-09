-- Switches for features some users don't want, without removing them.
-- Defaults keep today's behaviour: file passwords and two-factor on,
-- scores in the steps the rubric allows.

CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "file_protection" BOOLEAN NOT NULL DEFAULT true,
    "two_factor" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_settings_single_row" CHECK ("id" = 1)
);
INSERT INTO "platform_settings" ("id") VALUES (1);

ALTER TABLE "events" ADD COLUMN "whole_number_scores" BOOLEAN NOT NULL DEFAULT false;
