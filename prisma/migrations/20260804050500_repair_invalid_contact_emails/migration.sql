BEGIN;

DROP INDEX "Contact_active_direct_outreach_note_key";

WITH contact_email_values AS (
  SELECT
    contact."id",
    NULLIF(
      regexp_replace(
        regexp_replace(
          contact."email",
          '^[[:space:]]+',
          '',
          'g'
        ),
        '[[:space:]]+$',
        '',
        'g'
      ),
      ''
    ) AS email_value
  FROM "Contact" AS contact
  WHERE contact."email" IS NOT NULL
),
invalid_contacts AS (
  SELECT "id", email_value
  FROM contact_email_values
  WHERE email_value IS NULL
    OR email_value !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
)
UPDATE "Contact" AS contact
SET
  "directOutreachNote" = COALESCE(
    NULLIF(btrim(contact."directOutreachNote"), ''),
    invalid_contacts.email_value
  ),
  "notes" = CASE
    WHEN NULLIF(btrim(contact."directOutreachNote"), '') IS NOT NULL
      AND invalid_contacts.email_value IS NOT NULL
    THEN concat_ws(
      E'\n',
      NULLIF(btrim(contact."notes"), ''),
      'Legacy invalid email value: ' || invalid_contacts.email_value
    )
    ELSE contact."notes"
  END,
  "email" = NULL
FROM invalid_contacts
WHERE invalid_contacts."id" = contact."id";

WITH contact_email_values AS (
  SELECT
    contact."id",
    contact."artistId",
    contact."email",
    contact."state",
    contact."source",
    contact."updatedAt",
    NULLIF(
      regexp_replace(
        regexp_replace(
          contact."email",
          '^[[:space:]]+',
          '',
          'g'
        ),
        '[[:space:]]+$',
        '',
        'g'
      ),
      ''
    ) AS email_value
  FROM "Contact" AS contact
  WHERE contact."email" IS NOT NULL
),
ranked_valid_emails AS (
  SELECT
    contact_email_values.*,
    lower(email_value) AS canonical_email,
    row_number() OVER (
      PARTITION BY "artistId", lower(email_value)
      ORDER BY
        ("state" = 'active') DESC,
        ("email" = lower(email_value)) DESC,
        ("source" = 'manual') DESC,
        "updatedAt" DESC,
        "id"
    ) AS duplicate_rank
  FROM contact_email_values
  WHERE email_value ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
)
UPDATE "Contact" AS contact
SET
  "email" = NULL,
  "state" = 'quarantined',
  "notes" = concat_ws(
    E'\n',
    NULLIF(btrim(contact."notes"), ''),
    'Legacy duplicate email value: ' || ranked_valid_emails.email_value
  )
FROM ranked_valid_emails
WHERE ranked_valid_emails."id" = contact."id"
  AND ranked_valid_emails.duplicate_rank > 1;

WITH canonical_emails AS (
  SELECT
    contact."id",
    lower(
      regexp_replace(
        regexp_replace(
          contact."email",
          '^[[:space:]]+',
          '',
          'g'
        ),
        '[[:space:]]+$',
        '',
        'g'
      )
    ) AS canonical_email
  FROM "Contact" AS contact
  WHERE contact."email" IS NOT NULL
)
UPDATE "Contact" AS contact
SET "email" = canonical_emails.canonical_email
FROM canonical_emails
WHERE canonical_emails."id" = contact."id"
  AND contact."email" IS DISTINCT FROM canonical_emails.canonical_email;

WITH ranked AS (
  SELECT
    contact."id",
    row_number() OVER (
      PARTITION BY
        contact."artistId",
        "normalize_direct_outreach_contact_note"(
          contact."directOutreachNote"
        )
      ORDER BY
        (contact."directOutreachIdentity" IS NOT NULL) DESC,
        (contact."source" = 'manual') DESC,
        contact."updatedAt" DESC,
        contact."id"
    ) AS duplicate_rank
  FROM "Contact" AS contact
  WHERE contact."state" = 'active'
    AND contact."email" IS NULL
    AND contact."directOutreachNote" IS NOT NULL
    AND char_length(btrim(contact."directOutreachNote")) > 0
)
UPDATE "Contact" AS contact
SET "state" = 'quarantined'
FROM ranked
WHERE ranked."id" = contact."id"
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "Contact_active_direct_outreach_note_key"
ON "Contact" (
  "artistId",
  "normalize_direct_outreach_contact_note"("directOutreachNote")
)
WHERE "state" = 'active'
  AND "email" IS NULL
  AND "directOutreachNote" IS NOT NULL
  AND char_length(btrim("directOutreachNote")) > 0;

COMMIT;
