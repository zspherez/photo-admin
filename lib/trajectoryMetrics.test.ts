import assert from "node:assert/strict";
import test from "node:test";
import type { TrajectoryMetricsStore } from "./trajectoryMetrics";
import { getTrajectoryOperationalMetrics } from "./trajectoryMetrics";

const now = new Date("2026-07-22T04:00:00.000Z");
const run = {
  id: "run-1",
  producerRunId: "producer-run-1",
  generatedAt: new Date("2026-07-22T02:00:00.000Z"),
  validUntil: new Date("2026-07-25T02:00:00.000Z"),
  importedAt: new Date("2026-07-22T02:05:00.000Z"),
  activatedAt: new Date("2026-07-22T02:06:00.000Z"),
  artifactByteLength: 1234,
  status: "ready" as const,
  summary: {
    recommendationCount: 10,
    mappedRecommendationCount: 6,
    suggestedRecommendationCount: 4,
    mappedSuggestedRecommendationCount: 4,
    nonSuggestedRecommendationCount: 6,
    mappedNonSuggestedRecommendationCount: 2,
    artistCount: 5,
    mappedArtistCount: 4,
  },
};

function contact(
  id: string,
  channels: {
    email?: string;
    phone?: string;
    directOutreachNote?: string;
  },
) {
  return {
    id,
    email: channels.email ?? null,
    phone: channels.phone ?? null,
    directOutreachNote: channels.directOutreachNote ?? null,
    isFullTeam: false,
    state: "active" as const,
  };
}

function store(): TrajectoryMetricsStore {
  return {
    async findReadyRuns() {
      return [run];
    },
    async findLatestRun() {
      return run;
    },
    async loadRunMetrics() {
      return {
        persistedArtistRows: 4,
        persistedRecommendationRows: 6,
        persistedSuggestedRows: 4,
        summary: run.summary,
        issues: [
          {
            code: "show_not_found",
            recommendationKey: "missing-show",
            detail: { isSuggested: false },
          },
          {
            code: "artist_not_found",
            recommendationKey: "missing-artist",
            detail: { isSuggested: false },
          },
          {
            code: "show_artist_membership_missing",
            recommendationKey: "missing-membership",
            detail: { isSuggested: false },
          },
          {
            code: "artist_not_found",
            recommendationKey: "missing-non-suggested",
            detail: { isSuggested: false },
          },
        ],
        activeSuggested: [
          {
            showId: "show-1",
            showDate: new Date("2026-08-01T00:00:00.000Z"),
            contacts: [contact("contact-email-ready", { email: "private@example.com" })],
          },
          {
            showId: "show-2",
            showDate: new Date("2026-08-01T12:00:00.000Z"),
            contacts: [contact("contact-email-blocked", { email: "blocked@example.com" })],
          },
          {
            showId: "show-3",
            showDate: new Date("2026-08-02T00:00:00.000Z"),
            contacts: [contact("contact-direct", { phone: "555-0100" })],
          },
          {
            showId: "show-4",
            showDate: new Date("2026-08-03T00:00:00.000Z"),
            contacts: [],
          },
        ],
        readiness: [
          {
            showId: "show-1",
            contactId: "contact-email-ready",
            sendable: true,
          },
          {
            showId: "show-2",
            contactId: "contact-email-blocked",
            sendable: false,
          },
        ],
      };
    },
    async loadHistoricalMetrics() {
      return {
        decisions: [
          {
            id: "decision-t-old",
            recommendationId: "recommendation-t",
            runId: "run-1",
            arm: "trajectory",
            action: "selected",
            recordedAt: new Date("2026-07-20T01:00:00Z"),
            superseded: false,
          },
          {
            id: "decision-t-new",
            recommendationId: "recommendation-t",
            runId: "run-1",
            arm: "trajectory",
            action: "dismissed",
            recordedAt: new Date("2026-07-21T01:00:00Z"),
            superseded: false,
          },
          {
            id: "decision-m",
            recommendationId: "recommendation-m",
            runId: "run-1",
            arm: "momentum",
            action: "saved",
            recordedAt: new Date("2026-07-21T02:00:00Z"),
            superseded: false,
          },
          {
            id: "decision-e",
            recommendationId: "recommendation-e",
            runId: "run-2",
            arm: "exploration",
            action: "selected",
            recordedAt: new Date("2026-07-21T03:00:00Z"),
            superseded: false,
          },
          {
            id: "decision-p",
            recommendationId: "recommendation-p",
            runId: "run-2",
            arm: "portfolio",
            action: "manual_override",
            recordedAt: new Date("2026-07-22T01:00:00Z"),
            superseded: false,
          },
          {
            id: "decision-p-superseded",
            recommendationId: "recommendation-p",
            runId: "run-2",
            arm: "portfolio",
            action: "declined",
            recordedAt: new Date("2026-07-22T02:00:00Z"),
            superseded: true,
          },
        ],
        outcomes: [
          {
            id: "outcome-t-old",
            recommendationId: "recommendation-t",
            runId: "run-1",
            arm: "trajectory",
            attended: true,
            access: "photo_pass",
            keeperCount: 12,
            relationshipValue: 2,
            publicationValue: 1,
            shootability: "good",
            venueAccessibility: "medium",
            recordedAt: new Date("2026-07-20T03:00:00Z"),
            superseded: false,
          },
          {
            id: "outcome-t-new",
            recommendationId: "recommendation-t",
            runId: "run-1",
            arm: "trajectory",
            attended: false,
            access: "none",
            keeperCount: null,
            relationshipValue: 0,
            publicationValue: 0,
            shootability: "poor",
            venueAccessibility: "low",
            recordedAt: new Date("2026-07-22T03:00:00Z"),
            superseded: false,
          },
          {
            id: "outcome-m",
            recommendationId: "recommendation-m",
            runId: "run-1",
            arm: "momentum",
            attended: true,
            access: "guestlist",
            keeperCount: 5,
            relationshipValue: 1,
            publicationValue: 1,
            shootability: "ok",
            venueAccessibility: "medium",
            recordedAt: new Date("2026-07-21T04:00:00Z"),
            superseded: false,
          },
          {
            id: "outcome-e",
            recommendationId: "recommendation-e",
            runId: "run-2",
            arm: "exploration",
            attended: true,
            access: "photo_pass",
            keeperCount: 7,
            relationshipValue: 2,
            publicationValue: 2,
            shootability: "good",
            venueAccessibility: "high",
            recordedAt: new Date("2026-07-21T05:00:00Z"),
            superseded: false,
          },
          {
            id: "outcome-p",
            recommendationId: "recommendation-p",
            runId: "run-2",
            arm: "portfolio",
            attended: null,
            access: "other",
            keeperCount: null,
            relationshipValue: null,
            publicationValue: null,
            shootability: null,
            venueAccessibility: null,
            recordedAt: new Date("2026-07-21T06:00:00Z"),
            superseded: false,
          },
        ],
        engagement: [
          {
            runId: "run-1",
            arm: "trajectory",
            status: "sent",
            createdAt: new Date("2026-07-19T01:00:00Z"),
            sentAt: new Date("2026-07-19T02:00:00Z"),
            deliveredAt: new Date("2026-07-19T02:01:00Z"),
            firstOpenedAt: new Date("2026-07-19T03:00:00Z"),
            lastOpenedAt: new Date("2026-07-19T03:30:00Z"),
            openCount: 2,
            firstClickedAt: null,
            lastClickedAt: null,
            clickCount: 0,
            bouncedAt: null,
            complainedAt: null,
          },
          {
            runId: "run-1",
            arm: "momentum",
            status: "failed",
            createdAt: new Date("2026-07-20T01:00:00Z"),
            sentAt: null,
            deliveredAt: null,
            firstOpenedAt: null,
            lastOpenedAt: null,
            openCount: 0,
            firstClickedAt: null,
            lastClickedAt: null,
            clickCount: 1,
            bouncedAt: new Date("2026-07-20T02:00:00Z"),
            complainedAt: null,
          },
          {
            runId: "run-2",
            arm: "exploration",
            status: "delivered",
            createdAt: new Date("2026-07-20T03:00:00Z"),
            sentAt: new Date("2026-07-20T03:01:00Z"),
            deliveredAt: new Date("2026-07-20T03:02:00Z"),
            firstOpenedAt: null,
            lastOpenedAt: null,
            openCount: 0,
            firstClickedAt: null,
            lastClickedAt: null,
            clickCount: 0,
            bouncedAt: null,
            complainedAt: null,
          },
          {
            runId: "run-2",
            arm: "portfolio",
            status: "sent",
            createdAt: new Date("2026-07-20T04:00:00Z"),
            sentAt: new Date("2026-07-20T04:01:00Z"),
            deliveredAt: null,
            firstOpenedAt: null,
            lastOpenedAt: null,
            openCount: 0,
            firstClickedAt: null,
            lastClickedAt: null,
            clickCount: 0,
            bouncedAt: null,
            complainedAt: new Date("2026-07-20T05:00:00Z"),
          },
        ],
      };
    },
  };
}

test("aggregates operational counts without exposing contact PII or model probability", async () => {
  const metrics = await getTrajectoryOperationalMetrics({
    now,
    store: store(),
  });

  assert.equal(metrics.run?.availability, "ready");
  assert.deepEqual(metrics.mapping, {
    available: true,
    sourceArtistRows: { value: 5, unavailableReason: null },
    mappedArtistRows: { value: 4, unavailableReason: null },
    sourceRecommendationRows: { value: 10, unavailableReason: null },
    mappedRecommendationRows: { value: 6, unavailableReason: null },
    sourceSuggestedRows: { value: 4, unavailableReason: null },
    mappedSuggestedRows: { value: 4, unavailableReason: null },
    sourceNonSuggestedRows: { value: 6, unavailableReason: null },
    mappedNonSuggestedRows: { value: 2, unavailableReason: null },
    unresolvedRows: 4,
    unresolvedSuggestedRows: { value: 0, unavailableReason: null },
    unresolvedNonSuggestedRows: { value: 4, unavailableReason: null },
  });
  assert.deepEqual(metrics.issues, {
    total: 4,
    showNotFound: 1,
    artistNotFound: 2,
    membershipMissing: 1,
  });
  assert.deepEqual(metrics.contactReadiness, {
    available: true,
    scopeRows: 4,
    readyEmail: 1,
    emailBlocked: 1,
    directOutreach: 1,
    needsContact: 1,
  });
  assert.deepEqual(metrics.sameNight, {
    available: true,
    nightsWithAlternatives: 1,
    distinctShows: 2,
    recommendationRows: 2,
    comparisonAvailable: false,
    comparisonReason:
      "Primary and backup roles are derived for display and are not persisted with decisions or outcomes.",
  });
  assert.equal(metrics.decisions.records, 4);
  assert.equal(metrics.decisions.selected, 1);
  assert.equal(metrics.decisions.dismissed, 1);
  assert.equal(metrics.decisions.manualOverride, 1);
  assert.equal(metrics.decisions.byArm.trajectory.dismissed, 1);
  assert.equal(metrics.decisions.byArm.momentum.saved, 1);
  assert.equal(metrics.decisions.byArm.exploration.selected, 1);
  assert.equal(metrics.decisions.byArm.portfolio.manualOverride, 1);
  assert.equal(metrics.engagement.opened, 1);
  assert.equal(metrics.engagement.clicked, 1);
  assert.equal(metrics.engagement.byArm.trajectory.opened, 1);
  assert.equal(metrics.engagement.byArm.momentum.bounced, 1);
  assert.equal(metrics.engagement.byArm.exploration.delivered, 1);
  assert.equal(metrics.engagement.byArm.portfolio.complained, 1);
  assert.equal(metrics.access.photoPass, 1);
  assert.equal(metrics.access.byArm.trajectory.none, 1);
  assert.equal(metrics.access.byArm.momentum.guestlist, 1);
  assert.equal(metrics.access.byArm.exploration.photoPass, 1);
  assert.equal(metrics.access.byArm.portfolio.other, 1);
  assert.equal(metrics.outcomes.keeperTotal, 12);
  assert.equal(metrics.outcomes.byArm.trajectory.keeperTotal, 0);
  assert.equal(metrics.outcomes.byArm.momentum.keeperTotal, 5);
  assert.equal(metrics.outcomes.byArm.exploration.keeperTotal, 7);
  assert.equal(metrics.outcomes.byArm.portfolio.records, 1);
  assert.equal(metrics.exportLag.available, false);
  assert.equal("latestExportableChangeAt" in metrics.exportLag, false);

  const serialized = JSON.stringify(metrics);
  for (const forbidden of [
    "private@example.com",
    "blocked@example.com",
    "555-0100",
    "propensity",
    "probability",
    "caused",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
  }
});

test("reports run-scoped metrics unavailable when no trajectory run exists", async () => {
  const emptyStore: TrajectoryMetricsStore = {
    async findReadyRuns() {
      return [];
    },
    async findLatestRun() {
      return null;
    },
    async loadRunMetrics() {
      throw new Error("must not load run metrics");
    },
    async loadHistoricalMetrics() {
      return { decisions: [], outcomes: [], engagement: [] };
    },
  };

  const metrics = await getTrajectoryOperationalMetrics({
    now,
    store: emptyStore,
  });
  assert.equal(metrics.run, null);
  assert.equal(metrics.import.available, false);
  assert.equal(metrics.mapping.available, false);
  assert.equal(metrics.contactReadiness.available, false);
  assert.equal(metrics.sameNight.available, false);
  assert.equal(metrics.exportLag.available, false);
});

test("labels legacy summary fields unavailable instead of inferring them from inserted rows", async () => {
  const legacyRun = {
    ...run,
    summary: {
      recommendationCount: 10,
      mappedRecommendationCount: 6,
    },
  };
  const legacyStore = store();
  legacyStore.findReadyRuns = async () => [legacyRun];
  legacyStore.findLatestRun = async () => legacyRun;
  legacyStore.loadRunMetrics = async () => ({
    persistedArtistRows: 4,
    persistedRecommendationRows: 6,
    persistedSuggestedRows: 4,
    summary: legacyRun.summary,
    issues: [
      {
        code: "artist_not_found",
        recommendationKey: "non-suggested-unresolved",
        detail: { isSuggested: false },
      },
    ],
    activeSuggested: [],
    readiness: [],
  });

  const metrics = await getTrajectoryOperationalMetrics({
    now,
    store: legacyStore,
  });
  assert.equal(metrics.mapping.available, true);
  assert.deepEqual(metrics.mapping.sourceRecommendationRows, {
    value: 10,
    unavailableReason: null,
  });
  assert.deepEqual(metrics.mapping.mappedRecommendationRows, {
    value: 6,
    unavailableReason: null,
  });
  assert.equal(metrics.mapping.sourceSuggestedRows.value, null);
  assert.match(
    metrics.mapping.sourceSuggestedRows.unavailableReason ?? "",
    /legacy or incomplete imports/,
  );
  assert.equal(metrics.mapping.sourceArtistRows.value, null);
  assert.deepEqual(metrics.mapping.unresolvedNonSuggestedRows, {
    value: 1,
    unavailableReason: null,
  });
});
