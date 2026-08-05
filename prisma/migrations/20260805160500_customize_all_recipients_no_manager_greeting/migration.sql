BEGIN;

UPDATE "EmailTemplate"
SET
  "subject" = regexp_replace(
    "subject",
    '\{\{[[:space:]]*manager_name[[:space:]]*\}\}',
    'there',
    'gi'
  ),
  "htmlBody" = regexp_replace(
    "htmlBody",
    '\{\{[[:space:]]*manager_name[[:space:]]*\}\}',
    'there',
    'gi'
  )
WHERE "subject" ~* '\{\{[[:space:]]*manager_name[[:space:]]*\}\}'
   OR "htmlBody" ~* '\{\{[[:space:]]*manager_name[[:space:]]*\}\}';

COMMIT;
