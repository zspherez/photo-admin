BEGIN;

ALTER TABLE "Contact"
  ADD COLUMN "directOutreachNote" TEXT;

COMMENT ON COLUMN "Contact"."directOutreachNote" IS
  'Exact trimmed Sheet cell text or manual instructions for a non-email direct relationship';

COMMIT;
