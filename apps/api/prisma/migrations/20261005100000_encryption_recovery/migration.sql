-- Break-glass recovery: a fingerprint to check a recovery key against, and
-- when the recovery kit was last printed.
ALTER TABLE "data_keys" ADD COLUMN "check_value" TEXT;
ALTER TABLE "data_keys" ADD COLUMN "recovery_exported_at" TIMESTAMP(3);
