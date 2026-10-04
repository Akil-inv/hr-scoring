-- Each user's document password: opens the report PDFs and Excel exports
-- they download. Stored encrypted by the app (enc:v1), like other sensitive fields.
ALTER TABLE "users" ADD COLUMN "document_password" TEXT;
ALTER TABLE "users" ADD COLUMN "document_password_set_at" TIMESTAMP(3);
