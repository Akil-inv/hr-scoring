-- CreateTable
CREATE TABLE IF NOT EXISTS "judge_messages" (
    "id" UUID NOT NULL,
    "judge_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "sent_by_name" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_at" TIMESTAMP(3),

    CONSTRAINT "judge_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "judge_messages_judge_id_dismissed_at_idx" ON "judge_messages"("judge_id", "dismissed_at");

-- AddForeignKey
ALTER TABLE "judge_messages" ADD CONSTRAINT "judge_messages_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
