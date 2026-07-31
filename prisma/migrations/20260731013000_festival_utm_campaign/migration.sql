BEGIN;

ALTER TABLE "Show"
ADD COLUMN "festivalUtmCampaign" TEXT;

ALTER TABLE "Show"
ADD CONSTRAINT "Show_festival_utm_campaign_check"
CHECK (
  "festivalUtmCampaign" IS NULL
  OR char_length("festivalUtmCampaign") BETWEEN 1 AND 200
);

COMMIT;
