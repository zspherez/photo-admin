BEGIN;

CREATE TABLE "EdmtrainVenue" (
  "id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT,
  "location" TEXT,
  "city" TEXT,
  "state" TEXT,
  "countryCode" TEXT,
  "countryName" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "nycStatus" TEXT NOT NULL,
  "nycStatusReason" TEXT NOT NULL,
  "geographySource" TEXT NOT NULL,
  "classificationVersion" INTEGER NOT NULL,
  "sourceFingerprint" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EdmtrainVenue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EdmtrainVenue_nycStatus_check"
    CHECK ("nycStatus" IN ('inside_nyc', 'outside_nyc', 'unknown'))
);

CREATE INDEX "EdmtrainVenue_nycStatus_lastSeenAt_idx"
  ON "EdmtrainVenue"("nycStatus", "lastSeenAt");

ALTER TABLE "Show" ADD COLUMN "edmtrainVenueId" INTEGER;
CREATE INDEX "Show_edmtrainVenueId_idx" ON "Show"("edmtrainVenueId");
ALTER TABLE "Show"
  ADD CONSTRAINT "Show_edmtrainVenueId_fkey"
  FOREIGN KEY ("edmtrainVenueId") REFERENCES "EdmtrainVenue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the cache from provider-managed shows without casting legacy raw
-- text to JSON. Rows that cannot prove NYC membership remain unknown.
WITH "extractedVenue" AS (
  SELECT
    substring(
      "raw" FROM '"venue"[[:space:]]*:[[:space:]]*\{[^}]*"id"[[:space:]]*:[[:space:]]*([0-9]+)'
    )::INTEGER AS "venueId",
    "venueName",
    substring(
      "raw" FROM '"address"[[:space:]]*:[[:space:]]*"([^"]*)"'
    ) AS "address",
    substring(
      "raw" FROM '"location"[[:space:]]*:[[:space:]]*"([^"]*)"'
    ) AS "location",
    substring(
      "raw" FROM '"latitude"[[:space:]]*:[[:space:]]*(-?[0-9]+[.]?[0-9]*)'
    )::DOUBLE PRECISION AS "latitude",
    substring(
      "raw" FROM '"longitude"[[:space:]]*:[[:space:]]*(-?[0-9]+[.]?[0-9]*)'
    )::DOUBLE PRECISION AS "longitude",
    "city",
    "state",
    "countryCode",
    "countryName",
    "sourceLastSeenAt",
    "updatedAt"
  FROM "Show"
  WHERE
    "source" = 'edmtrain'
    AND "raw" IS NOT NULL
    AND substring(
      "raw" FROM '"venue"[[:space:]]*:[[:space:]]*\{[^}]*"id"[[:space:]]*:[[:space:]]*([0-9]+)'
    ) IS NOT NULL
),
"rawVenue" AS (
  SELECT DISTINCT ON ("venueId") *
  FROM "extractedVenue"
  ORDER BY "venueId", "updatedAt" DESC
)
INSERT INTO "EdmtrainVenue" (
  "id", "name", "address", "location", "city", "state",
  "countryCode", "countryName",
  "latitude", "longitude",
  "nycStatus", "nycStatusReason", "geographySource",
  "classificationVersion", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  "venueId",
  "venueName",
  NULLIF("address", ''),
  NULLIF("location", ''),
  NULLIF("city", ''),
  NULLIF("state", ''),
  "countryCode",
  "countryName",
  "latitude",
  "longitude",
  CASE
    WHEN
      "countryCode" = 'US'
      AND upper(COALESCE("state", '')) IN ('NY', 'NEW YORK')
      AND lower(COALESCE("city", '')) IN (
        'astoria', 'bronx', 'brooklyn', 'flushing', 'long island city',
        'manhattan', 'new york', 'new york city', 'queens',
        'staten island', 'the bronx'
      )
      THEN 'inside_nyc'
    WHEN "countryCode" IS NOT NULL AND "countryCode" <> 'US'
      THEN 'outside_nyc'
    WHEN NULLIF("state", '') IS NOT NULL
      AND upper("state") NOT IN ('NY', 'NEW YORK')
      THEN 'outside_nyc'
    WHEN
      "countryCode" = 'US'
      AND upper(COALESCE("state", '')) IN ('NY', 'NEW YORK')
      AND NULLIF("city", '') IS NOT NULL
      THEN 'outside_nyc'
    ELSE 'unknown'
  END,
  CASE
    WHEN
      "countryCode" = 'US'
      AND upper(COALESCE("state", '')) IN ('NY', 'NEW YORK')
      AND lower(COALESCE("city", '')) IN (
        'astoria', 'bronx', 'brooklyn', 'flushing', 'long island city',
        'manhattan', 'new york', 'new york city', 'queens',
        'staten island', 'the bronx'
      )
      THEN 'backfill_nyc_locality'
    WHEN "countryCode" IS NOT NULL AND "countryCode" <> 'US'
      THEN 'backfill_country_outside_us'
    WHEN NULLIF("state", '') IS NOT NULL
      AND upper("state") NOT IN ('NY', 'NEW YORK')
      THEN 'backfill_state_outside_new_york'
    WHEN
      "countryCode" = 'US'
      AND upper(COALESCE("state", '')) IN ('NY', 'NEW YORK')
      AND NULLIF("city", '') IS NOT NULL
      THEN 'backfill_non_nyc_locality'
    ELSE 'backfill_insufficient_geography'
  END,
  'edmtrain_backfill',
  1,
  COALESCE("sourceLastSeenAt", "updatedAt"),
  "updatedAt",
  "updatedAt"
FROM "rawVenue";

UPDATE "Show" AS "show"
SET "edmtrainVenueId" = substring(
  "show"."raw" FROM '"venue"[[:space:]]*:[[:space:]]*\{[^}]*"id"[[:space:]]*:[[:space:]]*([0-9]+)'
)::INTEGER
WHERE
  "show"."source" = 'edmtrain'
  AND "show"."raw" IS NOT NULL
  AND substring(
    "show"."raw" FROM '"venue"[[:space:]]*:[[:space:]]*\{[^}]*"id"[[:space:]]*:[[:space:]]*([0-9]+)'
  ) IS NOT NULL;

ALTER TABLE "Show" DROP CONSTRAINT "Show_syncStatus_check";
ALTER TABLE "Show"
  ADD CONSTRAINT "Show_syncStatus_check"
  CHECK (
    "syncStatus" IN (
      'active', 'cancelled', 'blocked', 'missing',
      'outside_nyc', 'geography_unknown'
    )
  );

UPDATE "Show" AS "show"
SET "syncStatus" = CASE
  WHEN "venue"."nycStatus" = 'inside_nyc' THEN 'active'
  WHEN "venue"."nycStatus" = 'outside_nyc' THEN 'outside_nyc'
  ELSE 'geography_unknown'
END
FROM "EdmtrainVenue" AS "venue"
WHERE
  "show"."edmtrainVenueId" = "venue"."id"
  AND "show"."source" = 'edmtrain'
  AND "show"."isFestival" = false
  AND "show"."syncStatus" = 'active';

UPDATE "Show"
SET "syncStatus" = 'geography_unknown'
WHERE
  "source" = 'edmtrain'
  AND "isFestival" = false
  AND "syncStatus" = 'active'
  AND "edmtrainVenueId" IS NULL;

COMMIT;
