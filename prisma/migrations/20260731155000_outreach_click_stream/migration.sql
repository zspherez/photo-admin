BEGIN;

ALTER TABLE "ResendWebhookEvent"
  ADD COLUMN "clickedLink" TEXT,
  ADD COLUMN "clickUtmCampaign" TEXT,
  ADD COLUMN "clickUtmContent" TEXT;

ALTER TABLE "ResendWebhookEvent"
ADD CONSTRAINT "ResendWebhookEvent_click_metadata_check"
CHECK (
  (
    "clickedLink" IS NULL
    AND "clickUtmCampaign" IS NULL
    AND "clickUtmContent" IS NULL
  )
  OR (
    "type" = 'email.clicked'
    AND "clickedLink" IS NOT NULL
    AND char_length("clickedLink") BETWEEN 1 AND 4096
    AND (
      "clickUtmCampaign" IS NULL
      OR char_length("clickUtmCampaign") BETWEEN 1 AND 200
    )
    AND (
      "clickUtmContent" IS NULL
      OR char_length("clickUtmContent") BETWEEN 1 AND 200
    )
  )
);

CREATE INDEX "ResendWebhookEvent_type_providerCreatedAt_idx"
ON "ResendWebhookEvent"("type", "providerCreatedAt");

COMMIT;
