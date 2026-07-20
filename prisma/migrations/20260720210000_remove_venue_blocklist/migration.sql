BEGIN;

-- Match the application's Eastern calendar-date festival semantics.
SET LOCAL TIME ZONE 'America/New_York';

DELETE FROM "Setting"
WHERE "key" = 'venue_blocklist';

-- Complete snapshots will continue to refresh fetched events. Reconcile legacy
-- EDMTrain rows immediately so events outside the current fetch horizons do
-- not remain blocked solely because of a venue-name substring.
WITH "legacyBlocked" AS (
  SELECT
    show."id",
    show."isFestival",
    show."date",
    COALESCE(
      venue."nycStatus",
      show."festivalNycStatus",
      'unknown'
    ) AS "nycStatus"
  FROM "Show" AS show
  LEFT JOIN "EdmtrainVenue" AS venue
    ON venue."id" = show."edmtrainVenueId"
  WHERE show."source" = 'edmtrain'
    AND show."syncStatus" = 'blocked'
)
UPDATE "Show" AS show
SET "syncStatus" = CASE
  WHEN legacy."isFestival" = true THEN
    CASE
      WHEN legacy."date" < CURRENT_DATE
        THEN 'festival_past'
      WHEN legacy."nycStatus" = 'inside_nyc'
        THEN 'active'
      WHEN legacy."date" >= CURRENT_DATE + INTERVAL '7 days'
        THEN 'active'
      WHEN legacy."nycStatus" = 'outside_nyc'
        THEN 'lead_time_outside_nyc'
      ELSE 'lead_time_geography_unknown'
    END
  WHEN legacy."nycStatus" = 'inside_nyc'
    THEN 'active'
  WHEN legacy."nycStatus" = 'outside_nyc'
    THEN 'outside_nyc'
  ELSE 'geography_unknown'
END
FROM "legacyBlocked" AS legacy
WHERE show."id" = legacy."id";

COMMIT;
