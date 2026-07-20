import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("email template settings no longer expose rate configuration", () => {
  const generalSettings = source("lib/generalSettings.ts");
  const settingsIndex = source("app/settings/page.tsx");
  const templateSettings = source("app/settings/template/page.tsx");

  assert.doesNotMatch(generalSettings, /key: "default_rate"/);
  assert.doesNotMatch(settingsIndex, /default_rate|default rate/i);
  assert.doesNotMatch(templateSettings, /customPrice|["']rate["']/);
  assert.match(templateSettings, /SUPPORTED_TEMPLATE_VARS/);
  assert.match(templateSettings, /normalizeDefaultTemplateContent/);
});

test("live, scheduled, follow-up, and preview rendering omit custom prices", () => {
  const sendOutreach = source("lib/sendOutreach.ts");
  const customize = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const templateSettings = source("app/settings/template/page.tsx");

  assert.doesNotMatch(sendOutreach, /customPrice/);
  assert.match(sendOutreach, /normalizeLegacyRateTemplateVariable/);
  assert.match(
    sendOutreach,
    /scheduleOutreach[\s\S]*prepareOriginalOutreach/,
  );
  assert.match(
    sendOutreach,
    /scheduleFollowUp[\s\S]*prepareFollowUpOutreach/,
  );
  assert.doesNotMatch(customize, /customPrice/);
  assert.doesNotMatch(templateSettings, /customPrice/);
});

test("outreach selection surfaces no longer display custom prices", () => {
  const dashboard = source("app/dashboard/dashboard-client.tsx");
  const festival = source("app/festivals/[showId]/page.tsx");

  assert.doesNotMatch(dashboard, /contact\.customPrice/);
  assert.doesNotMatch(festival, /customPrice/);
});
