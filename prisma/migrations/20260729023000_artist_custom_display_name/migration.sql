BEGIN;

ALTER TABLE "Artist"
ADD COLUMN "customName" TEXT;

ALTER TABLE "Artist"
ADD CONSTRAINT "Artist_customName_check"
CHECK (
  "customName" IS NULL
  OR (
    btrim("customName") <> ''
    AND "customName" = btrim("customName")
    AND char_length("customName") <= 200
  )
);

COMMIT;
