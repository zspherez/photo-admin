BEGIN;

INSERT INTO "Setting" ("key", "value", "updatedAt")
SELECT
  'google_contact_export_spreadsheet_id',
  legacy."value",
  CURRENT_TIMESTAMP
FROM "Setting" AS legacy
WHERE legacy."key" = 'sheets_spreadsheet_id'
  AND legacy."value" ~ '^[A-Za-z0-9_-]{1,200}$'
ON CONFLICT ("key") DO NOTHING;

COMMIT;
