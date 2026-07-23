import assert from "node:assert/strict";
import test from "node:test";
import {
  getTrajectoryRecommendationPage,
  PROVISIONAL_TRAJECTORY_DISCLAIMER,
  resolveRecommendationRun,
  type RecommendationReadRequest,
  type TrajectoryRecommendationStore,
} from "./trajectoryRecommendations";
import {
  groupRecommendationsByDate,
  type RecommendationView,
} from "./trajectoryRecommendationView";

const NOW = new Date("2026-07-21T16:00:00.000Z");
const QUERY = {
  tab: "suggested",
  workflow: "all",
  dateBand: "all",
} as const;

function run(
  overrides: Record<string, unknown> = {},
): ReturnType<TrajectoryRecommendationStore["findReadyRuns"]> extends Promise<
  infer Rows
>
  ? Rows extends Array<infer Row>
    ? Row
    : never
  : never {
  return {
    id: "run_1",
    generatedAt: new Date("2026-07-21T14:00:00.000Z"),
    asOfDate: new Date("2026-07-20T00:00:00.000Z"),
    decisionDate: new Date("2026-07-21T00:00:00.000Z"),
    minimumShowDate: new Date("2026-07-26T00:00:00.000Z"),
    validUntil: new Date("2026-07-25T00:00:00.000Z"),
    modelStatus: "provisional_population_matched_event_momentum",
    status: "ready",
    failureCode: null,
    failureMessage: null,
    ...overrides,
  } as never;
}

function contact(
  id: string,
  channels: Partial<{
    email: string | null;
    phone: string | null;
    directOutreachNote: string | null;
  }> = {},
) {
  return {
    id,
    email: channels.email ?? null,
    phone: channels.phone ?? null,
    directOutreachNote: channels.directOutreachNote ?? null,
    name: id,
    state: "active" as const,
    isFullTeam: false,
  };
}

function recommendation(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const artistId = `artist_${id}`;
  return {
    id,
    showId: `show_${id}`,
    arm: "trajectory",
    listRank: 1,
    isSuggested: true,
    slatePosition: 1,
    billingPosition: 2,
    lineupSize: 5,
    isFirstBilled: false,
    rationale: {
      sourceShowDate: "2025-01-01",
      sourceVenueName: "Stale model venue",
    },
    show: {
      id: `show_${id}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      venueName: "Canonical venue",
      city: "Brooklyn",
      state: "NY",
      ticketUrl: "https://tickets.example/show",
      eventName: "Canonical event",
      syncStatus: "active",
      dismissedAt: null,
      interestedAt: null,
      outreaches: [],
    },
    runArtist: {
      sourceName: "Stale model artist",
      coverageState: "C_covered",
      momentumBand: "rising",
      isEarlyStage: true,
      isEstablished: false,
      isVeteran: false,
      eventDelta6m: 7,
      eventsPrior6m: 1,
      eventsRecent6m: 8,
      marketsPrior6m: 1,
      marketsRecent6m: 4,
      careerAgeYears: 1.5,
      analogSummary: {
        configuration: "test",
        k: 3,
        sustained_positive_neighbors: 2,
        sustained_pool_base_rate: 0.17,
        nearest: [
          { name: "Analog A" },
          { name: "Analog B" },
          { name: "Analog C" },
        ],
      },
      releaseContext: { available: false },
      genres: ["house"],
      artist: {
        id: artistId,
        name: `Canonical ${id}`,
        contacts: [contact(`contact_${id}`, { email: `${id}@example.com` })],
      },
    },
    ...overrides,
  };
}

function store(options: {
  ready?: unknown[];
  latest?: unknown;
  recommendations?: unknown[];
  capture?: (request: RecommendationReadRequest) => void;
} = {}): TrajectoryRecommendationStore {
  return {
    findReadyRuns: async () => (options.ready ?? [run()]) as never,
    findLatestRun: async () => (options.latest ?? null) as never,
    findRecommendations: async (request) => {
      options.capture?.(request);
      return (options.recommendations ?? [recommendation("one")]) as never;
    },
  };
}

const sendable = async (
  inputs: readonly { showId: string; contactId: string }[],
) =>
  inputs.map((input) => ({
    ...input,
    artistId: "artist",
    sendable: true,
    mode: "new" as const,
    reason: null,
    recipients: ["person@example.com"],
    fullTeamSend: false,
  }));

test("no run, failed, expired, and multiple-ready states never load recommendations", async () => {
  const cases = [
    {
      expected: "none",
      value: store({ ready: [], latest: null }),
    },
    {
      expected: "failed",
      value: store({
        ready: [],
        latest: run({ status: "failed", failureMessage: "validation failed" }),
      }),
    },
    {
      expected: "expired",
      value: store({
        ready: [run({ validUntil: new Date("2026-07-21T16:00:00.000Z") })],
      }),
    },
    {
      expected: "multiple_ready",
      value: store({ ready: [run(), run({ id: "run_2" })] }),
    },
  ] as const;
  for (const item of cases) {
    let queried = false;
    const guarded = {
      ...item.value,
      findRecommendations: async () => {
        queried = true;
        return [];
      },
    };
    const result = await getTrajectoryRecommendationPage(QUERY, {
      now: NOW,
      store: guarded,
      sendability: sendable,
    });
    assert.equal(result.availability, item.expected);
    assert.equal(result.recommendations.length, 0);
    assert.equal(queried, false);
  }
});

test("a changed active run never falls back to superseded cursor data", async () => {
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    expectedRunId: "old_run",
    store: store(),
    sendability: sendable,
  });
  assert.equal(result.availability, "superseded");
  assert.equal(result.recommendations.length, 0);
});

test("every actionable read is scoped to the exact fresh ready run and current validity", async () => {
  const captured: { value: RecommendationReadRequest | null } = {
    value: null,
  };
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({ capture: (request) => (captured.value = request) }),
    sendability: sendable,
  });
  assert.equal(result.availability, "ready");
  assert.ok(captured.value);
  assert.equal(captured.value.runId, "run_1");
  assert.equal(captured.value.producer, "artist_trajectory");
  assert.equal(captured.value.status, "ready");
  assert.equal(captured.value.validAfter.toISOString(), NOW.toISOString());
  assert.equal("generatedAfter" in captured.value, false);
  assert.equal(
    captured.value.showStart.toISOString(),
    "2026-07-26T00:00:00.000Z",
  );
});

test("all arm tabs remain exact store predicates", async () => {
  for (const tab of [
    "suggested",
    "trajectory",
    "exploration",
    "portfolio",
    "momentum",
  ] as const) {
    let requested = "";
    await getTrajectoryRecommendationPage(
      { ...QUERY, tab },
      {
        now: NOW,
        store: store({ capture: (request) => (requested = request.tab) }),
        sendability: sendable,
      },
    );
    assert.equal(requested, tab);
  }
});

test("canonical show and artist fields override stale model snapshots", async () => {
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store(),
    sendability: sendable,
  });
  assert.equal(result.recommendations[0].venueName, "Canonical venue");
  assert.equal(result.recommendations[0].artistName, "Canonical one");
  assert.equal(
    result.recommendations[0].showDate,
    "2026-08-01T00:00:00.000Z",
  );
  assert.doesNotMatch(
    JSON.stringify(result.recommendations[0]),
    /Stale model venue|Stale model artist|2025-01-01/,
  );
  assert.deepEqual(result.recommendations[0].rationale, [
    "Completed bookings 1 → 8 in the compared six-month windows.",
    "Early-stage criteria met.",
  ]);
});

test("decision and outcome correction history expose current evidence and private notes", async () => {
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({
      recommendations: [
        recommendation("history", {
          feedback: [
            {
              id: "feedback-new",
              action: "saved",
              propensity: null,
              manualOverride: false,
              notes: "Keep this private",
              supersedesId: "feedback-old",
              recordedAt: new Date("2026-07-21T15:00:00.000Z"),
            },
            {
              id: "feedback-old",
              action: "selected",
              propensity: 0.5,
              manualOverride: false,
              notes: null,
              supersedesId: null,
              recordedAt: new Date("2026-07-21T14:00:00.000Z"),
            },
          ],
          outcomes: [
            {
              id: "outcome-new",
              attended: true,
              access: "photo_pass",
              keeperCount: 8,
              relationshipValue: 2,
              publicationValue: 1,
              shootability: "good",
              venueAccessibility: "medium",
              notes: "Lighting was strong",
              supersedesId: "outcome-old",
              recordedAt: new Date("2026-08-02T15:00:00.000Z"),
            },
            {
              id: "outcome-old",
              attended: false,
              access: "none",
              keeperCount: 0,
              relationshipValue: 0,
              publicationValue: 0,
              shootability: null,
              venueAccessibility: null,
              notes: null,
              supersedesId: null,
              recordedAt: new Date("2026-08-02T14:00:00.000Z"),
            },
          ],
        }),
      ],
    }),
    sendability: sendable,
  });

  assert.deepEqual(
    result.recommendations[0].decisionHistory.map((row) => [
      row.id,
      row.isCurrent,
      row.notes,
    ]),
    [
      ["feedback-new", true, "Keep this private"],
      ["feedback-old", false, null],
    ],
  );
  assert.deepEqual(
    result.recommendations[0].outcomeHistory.map((row) => [
      row.id,
      row.isCurrent,
      row.notes,
    ]),
    [
      ["outcome-new", true, "Lighting was strong"],
      ["outcome-old", false, null],
    ],
  );
});

test("outcome controls use canonical show dates and preserve corrections after date changes", async () => {
  const rows = [
    recommendation("today", {
      show: {
        ...recommendation("today").show,
        date: new Date("2026-07-21T00:00:00.000Z"),
      },
    }),
    recommendation("future", {
      show: {
        ...recommendation("future").show,
        date: new Date("2026-07-22T00:00:00.000Z"),
      },
    }),
    recommendation("moved", {
      show: {
        ...recommendation("moved").show,
        date: new Date("2026-07-25T00:00:00.000Z"),
      },
      outcomes: [
        {
          id: "existing-outcome",
          attended: true,
          access: "photo_pass",
          keeperCount: 3,
          relationshipValue: 1,
          publicationValue: 0,
          shootability: "good",
          venueAccessibility: "medium",
          notes: null,
          supersedesId: null,
          recordedAt: new Date("2026-07-21T15:00:00.000Z"),
        },
      ],
    }),
  ];
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({ recommendations: rows }),
    sendability: sendable,
  });
  const byName = new Map(
    result.recommendations.map((row) => [row.artistName, row]),
  );
  assert.equal(byName.get("Canonical today")?.outcomeRecordable, true);
  assert.equal(byName.get("Canonical future")?.outcomeRecordable, false);
  assert.match(
    byName.get("Canonical future")?.outcomeRecordabilityMessage ?? "",
    /2026-07-22/,
  );
  assert.equal(byName.get("Canonical moved")?.outcomeRecordable, true);
  assert.match(
    byName.get("Canonical moved")?.outcomeRecordabilityMessage ?? "",
    /Correction remains available/,
  );
});

test("duplicate recommendation identities and inactive canonical shows do not render", async () => {
  const first = recommendation("one");
  const duplicate = recommendation("duplicate", {
    showId: first.showId,
    arm: first.arm,
    show: first.show,
    runArtist: first.runArtist,
  });
  const inactive = recommendation("inactive", {
    show: {
      ...recommendation("inactive").show,
      syncStatus: "cancelled",
    },
  });
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({ recommendations: [first, duplicate, inactive] }),
    sendability: sendable,
  });
  assert.equal(result.recommendations.length, 1);
});

test("contact queues distinguish ready email, needs email, direct outreach, and blocked email", async () => {
  const rows = [
    recommendation("ready"),
    recommendation("needs", {
      runArtist: {
        ...recommendation("needs").runArtist,
        artist: {
          id: "artist_needs",
          name: "Needs",
          contacts: [],
        },
      },
    }),
    recommendation("direct", {
      runArtist: {
        ...recommendation("direct").runArtist,
        artist: {
          id: "artist_direct",
          name: "Direct",
          contacts: [contact("direct_contact", { phone: "+15550000000" })],
        },
      },
    }),
    recommendation("blocked"),
  ];
  const classify = async (
    inputs: readonly { showId: string; contactId: string }[],
  ) =>
    inputs.map((input) => ({
      ...input,
      artistId: "artist",
      sendable: input.showId !== "show_blocked",
      mode: input.showId !== "show_blocked" ? ("new" as const) : null,
      reason: input.showId === "show_blocked" ? "Existing outreach" : null,
      recipients: [],
      fullTeamSend: false,
    }));
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({ recommendations: rows }),
    sendability: classify,
  });

  assert.deepEqual(
    Object.fromEntries(
      result.recommendations.map((item) => [
        item.artistName,
        item.contactCategory,
      ]),
    ),
    {
      "Canonical ready": "ready_email",
      Needs: "needs_email",
      Direct: "direct_outreach",
      "Canonical blocked": "email_blocked",
    },
  );
  for (const [workflow, expected] of [
    ["ready", "Canonical ready"],
    ["needs", "Needs"],
    ["direct", "Direct"],
  ] as const) {
    const filtered = await getTrajectoryRecommendationPage(
      { ...QUERY, workflow },
      {
        now: NOW,
        store: store({ recommendations: rows }),
        sendability: classify,
      },
    );
    assert.deepEqual(
      filtered.recommendations.map((item) => item.artistName),
      [expected],
    );
  }
});

test("interested, dismissed, sent, opened, and clicked filters use canonical workflow state", async () => {
  const row = recommendation("state", {
    show: {
      ...recommendation("state").show,
      interestedAt: new Date("2026-07-20T00:00:00.000Z"),
      dismissedAt: new Date("2026-07-21T00:00:00.000Z"),
      outreaches: [
        {
          id: "outreach_1",
          artistId: "artist_state",
          kind: "original",
          status: "scheduled",
          sentAt: null,
          deliveredAt: null,
          scheduledFor: new Date("2026-07-22T13:00:00.000Z"),
          openCount: 2,
          clickCount: 1,
        },
      ],
    },
  });
  for (const workflow of [
    "interested",
    "dismissed",
    "sent",
    "opened",
    "clicked",
  ] as const) {
    const result = await getTrajectoryRecommendationPage(
      { ...QUERY, workflow },
      {
        now: NOW,
        store: store({ recommendations: [row] }),
        sendability: sendable,
      },
    );
    assert.equal(result.recommendations.length, 1, workflow);
  }
});

test("cards preserve canonical non-success outreach states", async () => {
  const expected = [
    ["failed", "Failed"],
    ["manual_review", "Manual review"],
    ["queued", "Queued"],
    ["cancelled", "Cancelled"],
    ["test", "Test sent"],
  ] as const;
  for (const [status, label] of expected) {
    const row = recommendation(status, {
      show: {
        ...recommendation(status).show,
        outreaches: [
          {
            artistId: `artist_${status}`,
            kind: "original",
            status,
            sentAt: status === "test" ? NOW : null,
            deliveredAt: null,
            openCount: 0,
            clickCount: 0,
          },
        ],
      },
    });
    const result = await getTrajectoryRecommendationPage(QUERY, {
      now: NOW,
      store: store({ recommendations: [row] }),
      sendability: sendable,
    });
    assert.deepEqual(result.recommendations[0].outreachLabels, [label]);
  }
});

test("same-night alternatives group by canonical date without deduplicating different shows", () => {
  const base = {
    showDate: "2026-08-01T00:00:00.000Z",
    arm: "trajectory",
  };
  const rows = [
    { ...base, id: "one", identityKey: "one", showId: "show_one" },
    { ...base, id: "two", identityKey: "two", showId: "show_two" },
    {
      ...base,
      id: "three",
      identityKey: "three",
      showId: "show_one",
      arm: "portfolio",
    },
  ] as RecommendationView[];
  const groups = groupRecommendationsByDate(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].recommendations.map((item) => item.sameNightRole),
    ["primary", "backup", "primary"],
  );
});

test("workflow order is explicit priority rather than model rank or probability", async () => {
  const interested = recommendation("interested", {
    listRank: 99,
    show: {
      ...recommendation("interested").show,
      interestedAt: NOW,
    },
  });
  const momentum = recommendation("momentum", {
    arm: "momentum",
    listRank: 1,
  });
  const exploration = recommendation("exploration", {
    arm: "exploration",
    listRank: 1,
  });
  const portfolio = recommendation("portfolio", {
    arm: "portfolio",
    listRank: 1,
  });
  const result = await getTrajectoryRecommendationPage(QUERY, {
    now: NOW,
    store: store({
      recommendations: [portfolio, exploration, momentum, interested],
    }),
    sendability: sendable,
  });
  assert.deepEqual(
    result.recommendations.map((row) => [
      row.id,
      row.workflowPriority.rank,
      row.workflowPriority.label,
    ]),
    [
      ["interested", 1, "Interested + ready to send"],
      ["momentum", 4, "Broader momentum"],
      ["exploration", 6, "Exploration"],
      ["portfolio", 7, "Portfolio"],
    ],
  );
});

test("the required provisional disclaimer is exact", () => {
  assert.equal(
    PROVISIONAL_TRAJECTORY_DISCLAIMER,
    "Provisional heuristic; not a validated breakout probability.",
  );
});

test("run resolver reports a valid ready run without consulting older data", async () => {
  let latestRead = false;
  const resolved = await resolveRecommendationRun(NOW, {
    ...store(),
    findLatestRun: async () => {
      latestRead = true;
      return run({ id: "older" });
    },
  });
  assert.equal(resolved.availability, "ready");
  assert.equal(resolved.run?.id, "run_1");
  assert.equal(latestRead, false);
});
