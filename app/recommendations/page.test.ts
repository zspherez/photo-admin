import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

test("recommendations UI carries every required tab, queue, and date band", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  for (const label of [
    "Suggested slate",
    "Trajectory",
    "Exploration",
    "Portfolio",
    "Broader momentum",
    "Ready to contact",
    "Needs contact",
    "Direct outreach",
    "Interested",
    "Sent / scheduled",
    "Opened",
    "Clicked",
    "Dismissed",
    "5–10 days",
    "10–45 days",
    "45–90 days",
  ]) {
    assert.match(client, new RegExp(label.replace("/", "\\/")));
  }
});

test("recommendations are read-only and expose no mutation or send controls", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  const combined = `${page}\n${client}`;
  assert.doesNotMatch(
    combined,
    /sendNowAction|setInterestedAction|dismissShowAction|restoreShowAction|markSentAction|unmarkSentAction|sendFollowUpAction|cancelScheduledAction|SendButton|FollowUpButton/,
  );
  assert.doesNotMatch(combined, /<form|action=\{/);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "app/recommendations/actions.ts")),
    false,
  );
});

test("header always states provisional status and never presents a forecast field", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.match(page, /PROVISIONAL_TRAJECTORY_DISCLAIMER/);
  assert.match(page, /Model status:/);
  assert.match(client, /descriptive, not probability/);
  assert.doesNotMatch(`${page}\n${client}`, /breakout chance|likelihood|probability:/i);
});

test("cards show canonical workflow evidence, analog context, details, and same-night roles", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  for (const marker of [
    "Billing",
    "First billed",
    "Why it is here",
    "Nearest historical analogs",
    "Historical pool base rate \\(descriptive\\)",
    "Access not recorded",
    "Primary option",
    "Backup option",
    "Same-night alternatives",
    "<details",
  ]) {
    assert.match(client, new RegExp(marker));
  }
});

test("recommendation batches have accessible infinite loading and duplicate guards", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.doesNotMatch(client, /from "@\/lib\/trajectoryRecommendations"/);
  assert.match(client, /new IntersectionObserver/);
  assert.match(client, /rootMargin: "600px 0px"/);
  assert.match(client, /"Load more"/);
  assert.match(client, /aria-live="polite"/);
  assert.match(client, /mergeUniqueByKey/);
  assert.match(client, /identityKey/);
});

test("navigation and loading state expose the recommendations route", () => {
  assert.match(source("components/nav.tsx"), /\/recommendations/);
  assert.match(
    source("app/recommendations/loading.tsx"),
    /Loading trajectory recommendations/,
  );
});
