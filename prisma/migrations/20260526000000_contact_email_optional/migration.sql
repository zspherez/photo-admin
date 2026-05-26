-- Contacts can now be phone-only: at least one of email/phone is required
-- at the form layer, but the DB allows either to be null. The
-- @@unique([artistId, email]) constraint still applies for non-null
-- emails (Postgres treats NULL != NULL, so multiple null-email rows per
-- artist are permitted).
ALTER TABLE "Contact" ALTER COLUMN "email" DROP NOT NULL;
