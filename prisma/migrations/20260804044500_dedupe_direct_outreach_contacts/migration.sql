BEGIN;

CREATE FUNCTION "normalize_direct_outreach_contact_note"(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      lower(normalize(value, NFKC)),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
$$;

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
