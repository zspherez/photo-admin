ALTER TABLE "Show" ADD COLUMN "countryCode" TEXT;
ALTER TABLE "Show" ADD COLUMN "countryName" TEXT;

-- The historical manual festival form collected a US state and had no country
-- field, so those existing rows retain the same explicit US default as the new
-- form.
UPDATE "Show"
SET
  "countryCode" = 'US',
  "countryName" = 'United States'
WHERE
  "isFestival" = true
  AND "source" = 'manual';

-- Preserve provider geography without casting legacy raw text to JSON. Named
-- countries that cannot be mapped conservatively keep a display value and an
-- explicitly unknown code until the next EDMTrain sync.
WITH "providerCountry" AS (
  SELECT
    "id",
    substring(
      "raw"
      FROM '"country"[[:space:]]*:[[:space:]]*"([^"]+)"'
    ) AS "value"
  FROM "Show"
  WHERE "source" = 'edmtrain' AND "raw" IS NOT NULL
)
UPDATE "Show" AS "show"
SET
  "countryName" = "providerCountry"."value",
  "countryCode" = CASE
    WHEN upper("providerCountry"."value") IN ('US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA') THEN 'US'
    WHEN upper("providerCountry"."value") IN ('CA', 'CANADA') THEN 'CA'
    WHEN upper("providerCountry"."value") IN ('MX', 'MEXICO') THEN 'MX'
    WHEN upper("providerCountry"."value") IN ('GB', 'UK', 'UNITED KINGDOM', 'GREAT BRITAIN') THEN 'GB'
    ELSE NULL
  END
FROM "providerCountry"
WHERE
  "show"."id" = "providerCountry"."id"
  AND "providerCountry"."value" IS NOT NULL;

CREATE INDEX "Show_isFestival_countryCode_dismissedAt_date_idx"
ON "Show"("isFestival", "countryCode", "dismissedAt", "date");
