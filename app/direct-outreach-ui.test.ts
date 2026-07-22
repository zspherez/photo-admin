import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  contactDisplayValue,
  isDirectOutreachOnly,
} from "../lib/contactDisplay";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("direct outreach text is preserved for display with a clear classification", () => {
  const contact = {
    email: null,
    phone: null,
    directOutreachNote: "  Reach out through a personal introduction  ",
  };
  assert.equal(
    contactDisplayValue(contact),
    "Reach out through a personal introduction",
  );
  assert.equal(isDirectOutreachOnly(contact), true);
});

test("every contact detail surface carries direct outreach context", () => {
  for (const file of [
    "app/dashboard/dashboard-client.tsx",
    "components/artist-modal.tsx",
    "app/artists/[id]/page.tsx",
    "app/festivals/[showId]/page.tsx",
    "app/settings/contacts/page.tsx",
    "app/dashboard/contact/[contactId]/page.tsx",
    "app/dashboard/add-contact/[artistId]/page.tsx",
    "app/outreach/page.tsx",
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  ]) {
    const contents = source(file);
    assert.match(
      contents,
      /directOutreachNote|contactDisplayValue/,
      `${file} must carry the direct outreach value`,
    );
    assert.match(
      contents,
      /[Dd]irect outreach/,
      `${file} must identify direct outreach clearly`,
    );
  }
});

test("direct-only contacts expose manual marking without email actions", () => {
  const dashboard = source("app/dashboard/dashboard-client.tsx");
  const festival = source("app/festivals/[showId]/page.tsx");
  const contact = source("app/dashboard/contact/[contactId]/page.tsx");
  const actions = source("app/dashboard/actions.ts");
  const markSent = actions.slice(
    actions.indexOf("export async function markSentAction"),
    actions.indexOf("export async function unmarkSentAction"),
  );

  assert.match(dashboard, /Boolean\(emailContact \|\| phoneContact\)/);
  assert.match(dashboard, /emailContact && followUpEligibility/);
  assert.match(dashboard, /artist\.canMarkManually && \(/);
  assert.match(festival, /r\.contact && r\.followUpEligibility/);
  assert.match(
    festival,
    /name="contactId"[\s\S]*value=\{r\.displayContact\.id\}/,
  );
  assert.match(contact, /contact\.email && eligibility/);
  assert.match(markSent, /select: \{ artistId: true \}/);
  assert.doesNotMatch(markSent, /select: \{ email: true \}/);
});

test("agent-created direct outreach provenance appears on research and contact surfaces", () => {
  const component = source("components/direct-outreach-provenance.tsx");
  assert.match(component, /Agent-created direct outreach/);
  assert.match(component, /Trusted instruction v/);
  assert.match(component, /directOutreachEvidenceUrls\.map/);

  for (const file of [
    "app/research/page.tsx",
    "app/artists/[id]/page.tsx",
    "app/contacts/page.tsx",
    "app/dashboard/contact/[contactId]/page.tsx",
  ]) {
    assert.match(
      source(file),
      /DirectOutreachProvenance/,
      `${file} must display trusted-rule provenance`,
    );
  }

  const editor = source("app/dashboard/contact/[contactId]/page.tsx");
  assert.match(editor, /clearsAgentProvenance/);
  assert.match(editor, /CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE/);
});
