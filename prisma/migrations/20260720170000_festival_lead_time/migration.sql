BEGIN;

ALTER TABLE "Show"
  DROP CONSTRAINT "Show_syncStatus_check";

ALTER TABLE "Show"
  ADD CONSTRAINT "Show_syncStatus_check"
  CHECK (
    "syncStatus" IN (
      'active',
      'cancelled',
      'blocked',
      'missing',
      'outside_nyc',
      'geography_unknown',
      'festival_past',
      'lead_time_outside_nyc',
      'lead_time_geography_unknown'
    )
  );

ALTER TABLE "Show"
  ADD COLUMN "festivalNycStatus" TEXT;

ALTER TABLE "Show"
  ADD CONSTRAINT "Show_festivalNycStatus_check"
  CHECK (
    "festivalNycStatus" IS NULL
    OR "festivalNycStatus" IN ('inside_nyc', 'outside_nyc', 'unknown')
  );

UPDATE "Show" AS show
SET "festivalNycStatus" = venue."nycStatus"
FROM "EdmtrainVenue" AS venue
WHERE show."isFestival" = true
  AND show."edmtrainVenueId" = venue."id";

UPDATE "Show"
SET "festivalNycStatus" = CASE
  WHEN "countryCode" IS NOT NULL
    AND upper(trim("countryCode")) <> 'US'
    THEN 'outside_nyc'
  WHEN trim(COALESCE("state", '')) <> ''
    AND trim(
      regexp_replace(
        lower(trim("state")),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) NOT IN ('ny', 'new york')
    THEN 'outside_nyc'
  WHEN upper(trim(COALESCE("countryCode", ''))) = 'US'
    AND trim(
      regexp_replace(
        lower(trim(COALESCE("state", ''))),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) IN ('ny', 'new york')
    AND trim(
      regexp_replace(
        lower(trim("city")),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) IN (
      'astoria',
      'bronx',
      'brooklyn',
      'flushing',
      'long island city',
      'manhattan',
      'new york',
      'new york city',
      'queens',
      'staten island',
      'the bronx'
    )
    THEN 'inside_nyc'
  WHEN upper(trim(COALESCE("countryCode", ''))) = 'US'
    AND trim(
      regexp_replace(
        lower(trim(COALESCE("state", ''))),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) IN ('ny', 'new york')
    AND trim("city") <> ''
    THEN 'outside_nyc'
  ELSE 'unknown'
END
WHERE "isFestival" = true
  AND "festivalNycStatus" IS NULL;

CREATE INDEX "Show_isFestival_festivalNycStatus_date_idx"
  ON "Show"("isFestival", "festivalNycStatus", "date");

COMMIT;
