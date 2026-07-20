BEGIN;

ALTER TABLE "ArbitraryEmail"
  ADD COLUMN "text" TEXT;

ALTER TABLE "ArbitraryEmail"
  ADD CONSTRAINT "ArbitraryEmail_text_check"
  CHECK ("text" IS NULL OR btrim("text") <> '');

COMMIT;
