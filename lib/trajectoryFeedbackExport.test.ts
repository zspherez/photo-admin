import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  assertProducerCompatibleDecision,
  assertProducerCompatibleEvent,
  assertProducerCompatibleOutcome,
  buildTrajectoryDecisionExportEvent,
  buildTrajectoryEngagementExportEvent,
  buildTrajectoryOutcomeExportEvent,
  PRODUCER_FEEDBACK_CONTRACT_VERSION,
  selectLatestEvidenceByRecommendation,
  serializeTrajectoryDecisionJsonl,
  serializeTrajectoryFeedbackJsonl,
  serializeTrajectoryOutcomeJsonl,
  type TrajectoryDecisionExportRow,
  type TrajectoryEngagementExportRow,
  type TrajectoryOutcomeExportRow,
} from "./trajectoryFeedbackExport";

function recommendation() {
  return {
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
    outreaches: [{ id: "outreach-1" }],
  };
}

function engagementRow(
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
    trajectoryRecommendation: recommendation(),
    ...overrides,
  };
}

function decisionRow(
  overrides: Partial<TrajectoryDecisionExportRow> = {},
): TrajectoryDecisionExportRow {
  return {
    id: "decision-1",
    action: "selected",
    propensity: 0.75,
    manualOverride: false,
    recordedAt: new Date("2026-07-21T11:00:00.000Z"),
    recommendation: recommendation(),
    ...overrides,
  };
}

function outcomeRow(
  overrides: Partial<TrajectoryOutcomeExportRow> = {},
): TrajectoryOutcomeExportRow {
  return {
    id: "outcome-1",
    attended: true,
    access: "photo_pass",
    keeperCount: 5,
    relationshipValue: 2,
    publicationValue: 1,
    shootability: "good",
    venueAccessibility: "medium",
    recordedAt: new Date("2026-07-22T11:00:00.000Z"),
    recommendation: recommendation(),
    ...overrides,
  };
}

test("export is deterministic, PII-free, and carries exact attribution", () => {
  const rows = [
    engagementRow({ id: "outreach-b" }),
    engagementRow({ id: "outreach-a", openCount: 7, clickCount: 4 }),
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
    engagementRow({
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

test("decision export maps corrections to the producer evaluator contract", () => {
  const first = serializeTrajectoryDecisionJsonl([
    decisionRow({
      id: "decision-b",
      action: "dismissed",
      propensity: null,
      recordedAt: new Date("2026-07-21T12:00:00.000Z"),
    }),
    decisionRow({
      id: "decision-a",
      action: "manual_override",
      manualOverride: true,
    }),
  ]);
  const events = first
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events[0], {
    show_id: "12345",
    action: "selected",
    arm: "manual",
    propensity: 0.75,
    manual_override: true,
    outreach_id: "outreach-1",
    run_id: "producer-run-1",
    integration_contract_version: PRODUCER_FEEDBACK_CONTRACT_VERSION,
    logged_at_utc: "2026-07-21T11:00:00.000Z",
  });
  assert.equal(events[1].action, "declined");
  assert.equal(events[1].arm, "trajectory");
  assert.equal(events[1].outreach_id, undefined);
  assert.doesNotMatch(first, /artist|venue|contact|email|phone|notes/i);
});

test("outcome export uses producer field names and excludes private notes", () => {
  const event = buildTrajectoryOutcomeExportEvent(outcomeRow());
  assert.deepEqual(event, {
    show_id: "12345",
    attended: "yes",
    access: "photo_pass",
    keepers: 5,
    relationship_value: 2,
    publication_value: 1,
    shootability: "good",
    venue_accessibility: "medium",
    run_id: "producer-run-1",
    integration_contract_version: PRODUCER_FEEDBACK_CONTRACT_VERSION,
    logged_at_utc: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(
    serializeTrajectoryOutcomeJsonl([outcomeRow()]),
    `${JSON.stringify(event)}\n`,
  );
});

test("only the latest unsuperseded evidence per recommendation is exported", () => {
  const older = decisionRow({
    id: "decision-a",
    recordedAt: new Date("2026-07-20T11:00:00.000Z"),
  });
  const newer = decisionRow({
    id: "decision-b",
    action: "declined",
    recordedAt: new Date("2026-07-21T11:00:00.000Z"),
  });
  const other = decisionRow({
    id: "decision-c",
    recommendation: {
      ...recommendation(),
      id: "recommendation-2",
      show: { edmtrainId: 54321 },
    },
  });
  assert.deepEqual(
    selectLatestEvidenceByRecommendation([older, other, newer])
      .map((row) => row.id)
      .sort(),
    ["decision-b", "decision-c"],
  );
});

test("export rejects unapproved fields and email-shaped values", () => {
  assert.throws(
    () =>
      assertProducerCompatibleEvent({
        ...buildTrajectoryEngagementExportEvent(engagementRow()),
        contact_name: "Manager",
      }),
    /Unapproved/,
  );
  assert.throws(
    () =>
      assertProducerCompatibleEvent({
        ...buildTrajectoryEngagementExportEvent(engagementRow()),
        source: "someone@example.com",
      }),
    /Email-shaped/,
  );
  assert.throws(
    () =>
      assertProducerCompatibleDecision({
        ...buildTrajectoryDecisionExportEvent(decisionRow()),
        notes: "Private",
      }),
    /Unapproved/,
  );
  assert.throws(
    () =>
      assertProducerCompatibleOutcome({
        ...buildTrajectoryOutcomeExportEvent(outcomeRow()),
        artist: "someone@example.com",
      }),
    /Unapproved/,
  );
});

test("database export queries select current evidence without contact or message PII", () => {
  const source = readFileSync(
    new URL("./trajectoryFeedbackExport.ts", import.meta.url),
    "utf8",
  );
  for (const loader of [
    "loadTrajectoryDecisionExportRows",
    "loadTrajectoryOutcomeExportRows",
    "loadTrajectoryEngagementExportRows",
  ]) {
    const queryStart = source.indexOf(`export async function ${loader}`);
    assert.notEqual(queryStart, -1);
    const nextLoader = source.indexOf(
      "export async function ",
      queryStart + loader.length,
    );
    const query = source.slice(
      queryStart,
      nextLoader === -1 ? undefined : nextLoader,
    );
    assert.doesNotMatch(
      query,
      /\b(contact|recipientEmails|finalSubject|finalHtml|notes|email|phone|name)\s*:/,
    );
  }
  assert.match(
    source.slice(source.indexOf("loadTrajectoryDecisionExportRows")),
    /where: \{ supersededBy: null \}/,
  );
});

const producerRoot = "/Users/joshrehders/misc/artist_trajectory";
test(
  "decision, outcome, and engagement fixtures pass the producer evaluator",
  { skip: !existsSync(`${producerRoot}/model_contract.py`) },
  () => {
    const decision = buildTrajectoryDecisionExportEvent(decisionRow());
    const outcome = buildTrajectoryOutcomeExportEvent(outcomeRow());
    const engagement = buildTrajectoryEngagementExportEvent(engagementRow());
    const script = [
      "import json, sys",
      "import evaluate_decision_utility, model_contract, log_feedback",
      "payload = json.loads(sys.stdin.read())",
      "decision, outcome, engagement = payload['decision'], payload['outcome'], payload['engagement']",
      "assert decision['integration_contract_version'] == model_contract.CONTRACT_VERSION",
      "assert outcome['integration_contract_version'] == model_contract.CONTRACT_VERSION",
      "assert model_contract.sanitize_outreach_engagement_event(engagement) == engagement",
      "assert evaluate_decision_utility.worth_it(outcome)",
      "summary = evaluate_decision_utility.engagement_summary_by_arm([decision], [engagement])",
      "assert summary['trajectory']['selected'] == 1",
      "assert summary['trajectory']['opened'] == 1",
      "assert summary['trajectory']['clicked'] == 1",
      "args = log_feedback.parser().parse_args(['outreach-engagement', '--file', 'fixture.jsonl'])",
      "assert args.command == 'outreach-engagement' and args.file == 'fixture.jsonl'",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: producerRoot,
      input: JSON.stringify({ decision, outcome, engagement }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  },
);
