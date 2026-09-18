BEGIN;

ALTER TABLE "ArbitraryEmail" ADD COLUMN "attachmentManifest" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ArbitraryEmail" ADD CONSTRAINT "ArbitraryEmail_attachmentManifest_array"
  CHECK (jsonb_typeof("attachmentManifest") = 'array');

COMMIT;
