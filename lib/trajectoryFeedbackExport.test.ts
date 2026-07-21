import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  assertProducerCompatibleEvent,
  buildTrajectoryEngagementExportEvent,
  serializeTrajectoryFeedbackJsonl,
  type TrajectoryEngagementExportRow,
} from "./trajectoryFeedbackExport";

function row(
  overrides: Partial<TrajectoryEngagementExportRow> = {},
): TrajectoryEngagementExportRow {
  return {
    id: "outreach-1",
    status: "sent",
    sentAt: new Date("2026-07-21T12:00:00.000Z"),
    deliveredAt: new Date("2026-07-21T12:01:00.000Z"),
    firstOpenedAt: new Date("2026-07-21T12:02:00.000Z"),
    lastOpenedAt: new Date("2026-07-21T12:03:00.000Z"),
    openCount: 3,
    firstClickedAt: new Date("2026-07-21T12:04:00.000Z"),
    lastClickedAt: new Date("2026-07-21T12:05:00.000Z"),
    clickCount: 2,
    bouncedAt: null,
    complainedAt: null,
    trajectoryRecommendation: {
      id: "recommendation-1",
      arm: "trajectory",
      run: {
        id: "photo-admin-run-1",
        producerRunId: "producer-run-1",
      },
      show: {
        edmtrainId: 12345,
      },
      runArtist: {
        edmtrainArtistId: 67890,
      },
    },
    ...overrides,
  };
}

test("export is deterministic, PII-free, and carries exact attribution", () => {
  const rows = [
    row({ id: "outreach-b" }),
    row({ id: "outreach-a", openCount: 7, clickCount: 4 }),
  ];
  const first = serializeTrajectoryFeedbackJsonl(rows);
  const second = serializeTrajectoryFeedbackJsonl([...rows].reverse());
  assert.equal(first, second);
  const events = first
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    events.map((event) => event.outreach_id),
    ["outreach-a", "outreach-b"],
  );
  assert.equal(events[0].run_id, "producer-run-1");
  assert.equal(events[0].show_id, "12345");
  assert.equal(events[0].edmtrain_artist_id, 67890);
  assert.equal(events[0].open_count, 7);
  assert.equal(events[0].click_count, 4);
  assert.match(
    String(events[0].source),
    /photo-admin-run-1\/recommendations\/recommendation-1\?arm=trajectory$/,
  );
  assert.doesNotMatch(
    first,
    /contact_name|email|phone|recipient|subject|body|html|notes/i,
  );
});

test("engagement uses Outreach aggregate counters without summing send attempts", () => {
  const event = buildTrajectoryEngagementExportEvent(
    row({
      status: "sent",
      sentAt: null,
      deliveredAt: null,
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 5,
      firstClickedAt: null,
      lastClickedAt: null,
      clickCount: 0,
    }),
  );
  assert.equal(event.status, "sent");
  assert.equal(event.open_count, 5);
});

test("export rejects unapproved fields and email-shaped values", () => {
  assert.throws(
    () =>
      assertProducerCompatibleEvent({
        ...buildTrajectoryEngagementExportEvent(row()),
        contact_name: "Manager",
      }),
    /Unapproved/,
  );
  assert.throws(
    () =>
      assertProducerCompatibleEvent({
        ...buildTrajectoryEngagementExportEvent(row()),
        source: "someone@example.com",
      }),
    /Email-shaped/,
  );
});

test("database export query selects no contact or message PII", () => {
  const source = readFileSync(
    new URL("./trajectoryFeedbackExport.ts", import.meta.url),
    "utf8",
  );
  const queryStart = source.indexOf(
    "export async function loadTrajectoryEngagementExportRows",
  );
  assert.notEqual(queryStart, -1);
  const query = source.slice(queryStart);
  assert.doesNotMatch(
    query,
    /\b(contact|recipientEmails|finalSubject|finalHtml|notes|email|phone|name)\s*:/,
  );
});

const producerRoot = "/Users/joshrehders/misc/artist_trajectory";
test(
  "export fixture passes the producer sanitizer and parser",
  { skip: !existsSync(`${producerRoot}/model_contract.py`) },
  () => {
    const event = buildTrajectoryEngagementExportEvent(row());
    const script = [
      "import json, sys",
      "import model_contract, log_feedback",
      "event = json.loads(sys.stdin.read())",
      "assert model_contract.sanitize_outreach_engagement_event(event) == event",
      "args = log_feedback.parser().parse_args(['outreach-engagement', '--file', 'fixture.jsonl'])",
      "assert args.command == 'outreach-engagement' and args.file == 'fixture.jsonl'",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: producerRoot,
      input: JSON.stringify(event),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  },
);
