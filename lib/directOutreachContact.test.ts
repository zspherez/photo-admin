import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findMatchingDirectOutreachContact,
  normalizeDirectOutreachContactNote,
} from "./directOutreachContact";

test("direct outreach note keys normalize Unicode case and whitespace", () => {
  assert.equal(
    normalizeDirectOutreachContactNote("  @JóZiZzy   on Instagram "),
    "@józizzy on instagram",
  );
});

test("direct outreach matching reuses active or quarantined note contacts", async () => {
  const result = await findMatchingDirectOutreachContact(
    {
      $queryRaw: async () => [
        {
          id: "existing",
          state: "quarantined",
        },
      ],
    } as never,
    {
      artistId: "artist-1",
      directOutreachNote: "@jozizzy on instagram",
    },
  );
  assert.deepEqual(result, { id: "existing", state: "quarantined" });
});

test("migration quarantines duplicates and enforces one normalized active note", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260804044500_dedupe_direct_outreach_contacts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /row_number\(\) OVER/);
  assert.match(
    migration,
    /CREATE FUNCTION "normalize_direct_outreach_contact_note"/,
  );
  assert.match(migration, /lower\(normalize\(value, NFKC\)\)/);
  assert.match(migration, /SELECT btrim\([\s\S]*regexp_replace/);
  assert.match(migration, /SET "state" = 'quarantined'/);
  assert.match(migration, /duplicate_rank > 1/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Contact_active_direct_outreach_note_key"/,
  );
  assert.match(
    migration,
    /"normalize_direct_outreach_contact_note"\("directOutreachNote"\)/,
  );
  assert.match(migration, /WHERE "state" = 'active'/);
  assert.doesNotMatch(migration, /\bDELETE FROM "Contact"/);
});

test("forward repair moves malformed legacy emails into direct outreach history", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260804050500_repair_invalid_contact_emails/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /DROP INDEX "Contact_active_direct_outreach_note_key"/);
  assert.match(
    migration,
    /SET[\s\S]*"directOutreachNote" = COALESCE\([\s\S]*invalid_contacts\.email_value/,
  );
  assert.match(migration, /"email" = NULL/);
  assert.match(migration, /Legacy invalid email value:/);
  assert.match(migration, /\^\[\[:space:\]\]\+/);
  assert.match(migration, /\[\[:space:\]\]\+\$/);
  assert.match(migration, /email_value !~/);
  assert.match(migration, /ranked_valid_emails/);
  assert.match(migration, /Legacy duplicate email value:/);
  assert.match(migration, /ranked_valid_emails\.duplicate_rank > 1/);
  assert.match(migration, /SET "email" = canonical_emails\.canonical_email/);
  assert.match(migration, /duplicate_rank > 1/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Contact_active_direct_outreach_note_key"/,
  );
  assert.doesNotMatch(migration, /\bDELETE FROM "Contact"/);
});
