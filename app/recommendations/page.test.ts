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

test("recommendations reuse explicit authenticated workflow controls without auto outreach", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  const actions = source("app/dashboard/actions.ts");
  const send = source("lib/sendOutreach.ts");
  const combined = `${page}\n${client}`;
  for (const control of [
    "sendNowAction",
    "setInterestedAction",
    "dismissShowAction",
    "restoreShowAction",
    "markSentAction",
    "unmarkSentAction",
    "sendFollowUpAction",
    "cancelScheduledAction",
    "SendButton",
    "FollowUpButton",
    "Customize",
    "Add contact",
    "Research contact",
  ]) {
    assert.match(combined, new RegExp(control));
  }
  for (const field of [
    "recommendationId",
    "runId",
    "showId",
    "artistId",
    "trajectoryActionId",
  ]) {
    assert.match(client, new RegExp(`name(?::|=)["{ ]*"?${field}`));
  }
  assert.match(actions, /requireServerActionAuth/);
  assert.match(actions, /requireActionableTrajectoryRecommendation/);
  assert.match(send, /trajectoryContext\?\.recommendationId \?\? null/);
  assert.doesNotMatch(client, /void sendNowAction\(|sendNowAction\(\)/);
});

test("header always states provisional status and never presents a forecast field", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.match(page, /PROVISIONAL_TRAJECTORY_DISCLAIMER/);
  assert.match(page, /Model status:/);
  assert.doesNotMatch(`${page}\n${client}`, /breakout chance|likelihood|probability:/i);
});

test("cards stay focused on ranked shows, workflow state, and same-night roles", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  for (const marker of [
    "Billing",
    "First billed",
    "Primary option",
    "Backup option",
    "Same-night alternatives",
  ]) {
    assert.match(client, new RegExp(marker));
  }
  for (const removed of [
    "Decision & show outcome",
    "Attendance, access & photo outcome",
    "Why it is here",
    "Nearest historical analogs",
    "Coverage state",
    "Momentum band",
    "Completed bookings",
    "Career age",
    "Access not recorded",
  ]) {
    assert.doesNotMatch(client, new RegExp(removed.replace("&", "&amp;")));
  }
  assert.doesNotMatch(page, /Post-show outcomes|\/recommendations\/outcomes/);
});

test("recommendation batches have accessible infinite loading and duplicate guards", () => {
  const page = source("app/recommendations/page.tsx");
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.match(
    page,
    /key=\{`\$\{result\.run\.id\}:\$\{buildRecommendationHref\(query\)\}`\}/,
  );
  assert.doesNotMatch(client, /from "@\/lib\/trajectoryRecommendations"/);
  assert.match(client, /new IntersectionObserver/);
  assert.match(client, /rootMargin: "600px 0px"/);
  assert.match(client, /"Load more"/);
  assert.match(client, /aria-live="polite"/);
  assert.match(client, /mergeUniqueByKey/);
  assert.match(client, /identityKey/);
});

test("artist workflow links preserve the active recommendation filters", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.match(
    client,
    /returnTo=\{buildRecommendationHref\([\s\S]*dashboardReturnTo/,
  );
  assert.doesNotMatch(
    client,
    /workflow: "all"[\s\S]*dateBand: "all"/,
  );
});

test("navigation and loading state expose the recommendations route", () => {
  assert.match(source("components/nav.tsx"), /\/recommendations/);
  assert.match(
    source("app/recommendations/loading.tsx"),
    /Loading trajectory recommendations/,
  );
});
