BEGIN;

ALTER TABLE "EmailTemplate"
DROP CONSTRAINT IF EXISTS "EmailTemplate_canonical_purpose_default_check";

ALTER TABLE "EmailTemplate"
ADD CONSTRAINT "EmailTemplate_canonical_purpose_default_check"
CHECK (
  "purpose" IS NULL
  OR (
    "purpose" = 'original'
    AND "isDefault" = true
  )
  OR (
    "purpose" IN ('festival', 'festival_multi_artist', 'follow_up')
    AND "isDefault" = false
  )
);

COMMIT;
