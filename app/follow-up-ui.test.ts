import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("every supported outreach surface renders the shared follow-up control", () => {
  for (const file of [
    "app/dashboard/dashboard-client.tsx",
    "app/artists/[id]/page.tsx",
    "app/festivals/[showId]/page.tsx",
    "app/dashboard/contact/[contactId]/page.tsx",
    "app/outreach/page.tsx",
  ]) {
    const contents = source(file);
    assert.match(contents, /FollowUpButton/, file);
    assert.match(contents, /sendFollowUpAction/, file);
    assert.match(contents, /cancelScheduledAction/, file);
  }
});

test("follow-up controls preserve each page's validated return URL and banners", () => {
  const dashboard = source("app/dashboard/page.tsx");
  const artist = source("app/artists/[id]/page.tsx");
  const festival = source("app/festivals/[showId]/page.tsx");
  const contact = source("app/dashboard/contact/[contactId]/page.tsx");
  const outreach = source("app/outreach/page.tsx");

  assert.match(dashboard, /followup_sent/);
  assert.match(dashboard, /followup_scheduled/);
  assert.match(artist, /currentReturnTo = withWorkflowReturnTo/);
  assert.match(contact, /currentReturnTo = contactPageHref/);
  assert.match(outreach, /returnTo = outreachHref\(status, search, pagination\.page\)/);
  assert.match(festival, /returnTo = festivalReturnPath/);

  for (const contents of [artist, festival, contact, outreach]) {
    assert.match(contents, /Follow-up sent\./);
    assert.match(contents, /Follow-up scheduled for Monday morning\./);
  }
});

test("histories distinguish original and follow-up messages", () => {
  const dashboard = source("app/dashboard/dashboard-client.tsx");
  const festival = source("app/festivals/[showId]/page.tsx");
  const contact = source("app/dashboard/contact/[contactId]/page.tsx");
  const outreach = source("app/outreach/page.tsx");

  assert.match(dashboard, /Original ·/);
  assert.match(festival, /original: \$\{displayStatus\}/);
  assert.match(contact, /o\.kind === "follow_up" \? "Follow-up" : "Original"/);
  assert.match(outreach, /o\.kind === "follow_up" \? "Follow-up" : "Original"/);
  assert.match(
    dashboard,
    /show\.outreach\.find\(\s*\(row\) =>\s*row\.kind === "original" &&\s*row\.contactId === contact\.id/,
  );
});

test("follow-up customization stays global-template only", () => {
  const button = source("components/follow-up-button.tsx");
  const customize = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  assert.doesNotMatch(button, /Customize|subject|html/);
  assert.doesNotMatch(customize, /sendFollowUp|scheduleFollowUp/);
});
