BEGIN;

ALTER TABLE "ContactResearchJob"
  ADD COLUMN "userNotes" TEXT;

ALTER TABLE "ContactResearchJob"
  ADD CONSTRAINT "ContactResearchJob_userNotes_length_check"
  CHECK ("userNotes" IS NULL OR char_length("userNotes") <= 4000);

COMMIT;
