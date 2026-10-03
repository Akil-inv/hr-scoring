-- CreateTable
CREATE TABLE IF NOT EXISTS "room_unavailability" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "session" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "room_unavailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_unavailability_event_id_date_idx" ON "room_unavailability"("event_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "room_unavailability_room_id_date_session_key" ON "room_unavailability"("room_id", "date", "session");

-- AddForeignKey
ALTER TABLE "room_unavailability" ADD CONSTRAINT "room_unavailability_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
