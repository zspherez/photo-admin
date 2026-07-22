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
        artistRows: 5,
        mappedArtistRows: 4,
        recommendationRows: 6,
        suggestedRows: 4,
        issues: [
          { code: "show_not_found", recommendationKey: "missing-show" },
          { code: "artist_not_found", recommendationKey: "missing-artist" },
          {
            code: "show_artist_membership_missing",
            recommendationKey: "missing-membership",
          },
          { code: "artist_not_found", recommendationKey: null },
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
          { action: "selected", recordedAt: new Date("2026-07-20T01:00:00Z") },
          { action: "saved", recordedAt: new Date("2026-07-21T01:00:00Z") },
          {
            action: "manual_override",
            recordedAt: new Date("2026-07-22T01:00:00Z"),
          },
        ],
        outcomes: [
          {
            attended: true,
            access: "photo_pass",
            keeperCount: 12,
            relationshipValue: 2,
            publicationValue: 1,
            shootability: "good",
            venueAccessibility: "medium",
            recordedAt: new Date("2026-07-21T03:00:00Z"),
          },
          {
            attended: false,
            access: "none",
            keeperCount: null,
            relationshipValue: 0,
            publicationValue: 0,
            shootability: "poor",
            venueAccessibility: "low",
            recordedAt: new Date("2026-07-22T03:00:00Z"),
          },
        ],
        engagement: [
          {
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
    artistRows: 5,
    mappedArtistRows: 4,
    unmappedArtistRows: 1,
    importedRecommendationRows: 6,
    unresolvedRecommendationRows: 3,
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
  assert.equal(metrics.decisions.manualOverride, 1);
  assert.equal(metrics.engagement.opened, 1);
  assert.equal(metrics.engagement.clicked, 1);
  assert.equal(metrics.access.photoPass, 1);
  assert.equal(metrics.outcomes.keeperTotal, 12);
  assert.equal(metrics.exportLag.available, false);

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
