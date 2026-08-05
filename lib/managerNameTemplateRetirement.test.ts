import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMMON_TEMPLATE_VARS,
  DEFAULT_TEMPLATE_HTML,
  FESTIVAL_MULTI_ARTIST_TEMPLATE_HTML,
  FESTIVAL_TEMPLATE_HTML,
  FOLLOW_UP_TEMPLATE_HTML,
} from "./template";

test("active template defaults use neutral greetings without manager interpolation", () => {
  assert.equal(COMMON_TEMPLATE_VARS.includes("manager_name" as never), false);
  for (const template of [
    DEFAULT_TEMPLATE_HTML,
    FOLLOW_UP_TEMPLATE_HTML,
    FESTIVAL_TEMPLATE_HTML,
    FESTIVAL_MULTI_ARTIST_TEMPLATE_HTML,
  ]) {
    assert.doesNotMatch(template, /\{\{\s*manager_name\s*\}\}/i);
    assert.match(template, /\b(?:Hey|Hi) there\b/);
  }
});

test("migration replaces manager name interpolation in saved templates", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260805160500_customize_all_recipients_no_manager_greeting/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /UPDATE "EmailTemplate"/);
  assert.match(migration, /manager_name/);
  assert.match(migration, /\[\[:space:\]\]\*/);
  assert.match(migration, /'there'/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});
