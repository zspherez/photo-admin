BEGIN;

CREATE TYPE "EmailTemplatePurpose" AS ENUM (
  'original',
  'festival',
  'follow_up'
);

ALTER TABLE "EmailTemplate"
  ADD COLUMN "purpose" "EmailTemplatePurpose";

-- Preserve the existing user-edited normal and follow-up rows. Names are used
-- only for this one-time legacy backfill; runtime selection uses purpose.
UPDATE "EmailTemplate"
SET "purpose" = 'follow_up'
WHERE "name" = 'follow_up'
  AND "purpose" IS NULL;

UPDATE "EmailTemplate"
SET "purpose" = 'festival',
    "isDefault" = false
WHERE "name" = 'festival_outreach'
  AND "purpose" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "EmailTemplate"
    WHERE "purpose" = 'festival'
  );

UPDATE "EmailTemplate"
SET "purpose" = 'original'
WHERE "id" = (
  SELECT "id"
  FROM "EmailTemplate"
  WHERE "isDefault" = true
    AND "purpose" IS NULL
  ORDER BY "createdAt", "id"
  LIMIT 1
);

UPDATE "EmailTemplate"
SET "purpose" = 'original',
    "isDefault" = true
WHERE "name" = 'default'
  AND "purpose" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "EmailTemplate"
    WHERE "purpose" = 'original'
  );

INSERT INTO "EmailTemplate" (
  "id",
  "name",
  "purpose",
  "subject",
  "htmlBody",
  "isDefault",
  "createdAt",
  "updatedAt"
)
SELECT
  'normal-outreach-template',
  'default',
  'original',
  '{{artist}} {{sender_city}} Photo/Video',
  '<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in {{sender_city}} in a few weeks. I am a multimedia creative specialist local to {{sender_city}} and would love to work together to capture this show!</p>
    <p>Here''s a brief summary of my deliverables, and I''m happy to work with you to meet your needs!</p>
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM "EmailTemplate"
  WHERE "purpose" = 'original'
);

INSERT INTO "EmailTemplate" (
  "id",
  "name",
  "purpose",
  "subject",
  "htmlBody",
  "isDefault",
  "createdAt",
  "updatedAt"
)
SELECT
  'follow-up-outreach-template',
  'follow_up',
  'follow_up',
  original."subject",
  original."htmlBody",
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "EmailTemplate" AS original
WHERE original."purpose" = 'original'
  AND NOT EXISTS (
    SELECT 1
    FROM "EmailTemplate"
    WHERE "purpose" = 'follow_up'
  );

INSERT INTO "EmailTemplate" (
  "id",
  "name",
  "purpose",
  "subject",
  "htmlBody",
  "isDefault",
  "createdAt",
  "updatedAt"
)
SELECT
  'festival-outreach-template',
  'festival_outreach',
  'festival',
  'Photo coverage request: {{artist}} at {{festival_name}}',
  '<html>
  <body>
    <p>Hi {{manager_name}},</p>
    <p>I''m reaching out to request photo credentials and permission to photograph {{artist}}''s set at {{festival_name}} on {{date}} in {{location}}.</p>
    <p>I specialize in live music photography and would love to provide polished coverage of the set. You can view recent concert and festival work at <a href="{{portfolio_url}}">{{portfolio_url}}</a>.</p>
    <p>If photo access is coordinated by the festival press team, I''d appreciate being pointed to the right contact or credential instructions.</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM "EmailTemplate"
  WHERE "purpose" = 'festival'
);

CREATE UNIQUE INDEX "EmailTemplate_purpose_key"
  ON "EmailTemplate"("purpose");

ALTER TABLE "EmailTemplate"
  ADD CONSTRAINT "EmailTemplate_canonical_purpose_default_check"
  CHECK (
    "purpose" IS NULL
    OR (
      "purpose" = 'original'
      AND "isDefault" = true
    )
    OR (
      "purpose" IN ('festival', 'follow_up')
      AND "isDefault" = false
    )
  );

CREATE FUNCTION "prevent_email_template_purpose_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."purpose" IS NOT NULL
    AND NEW."purpose" IS DISTINCT FROM OLD."purpose"
  THEN
    RAISE EXCEPTION 'EmailTemplate purpose is immutable once assigned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmailTemplate_purpose_immutable"
BEFORE UPDATE ON "EmailTemplate"
FOR EACH ROW
EXECUTE FUNCTION "prevent_email_template_purpose_mutation"();

COMMIT;
