-- Field encryption: encrypted copies of scores and the support answer, and
-- the table holding the KMS-encrypted data key.
ALTER TABLE "criterion_scores" ADD COLUMN "score_enc" TEXT;
ALTER TABLE "scorecards" ADD COLUMN "total_score_enc" TEXT;
ALTER TABLE "scorecards" ADD COLUMN "support_enc" TEXT;

CREATE TABLE "data_keys" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "kms_key_id" TEXT NOT NULL,
    "encrypted_key" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "data_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "data_keys_version_key" ON "data_keys"("version");
