import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  resolveContactAuditArtist,
  type ContactAuditArtistAction,
} from "./contactAuditArtistDecision";

const now = new Date("2026-07-22T20:00:00.000Z");

function contact(id: string, email: string) {
  return {
    id,
    artistId: "artist-1",
    email,
    phone: null,
    directOutreachNote: null,
    name: id,
    role: "management",
    source: "sheet",
    notes: null,
    state: "active",
    isFullTeam: false,
  };
}

function rosterEntry(id: string, email: string) {
  return {
    id: `entry-${id}`,
    rosterSnapshotId: "roster-1",
    snapshotContactId: id,
    snapshotEmail: email,
    snapshotPhone: null,
    snapshotDirectOutreachNote: null,
    snapshotName: id,
    snapshotRole: "management",
    snapshotSource: "sheet",
    snapshotNotes: null,
    snapshotIsFullTeam: false,
    createdAt: now,
  };
}

async function runDecision(
  action: ContactAuditArtistAction,
  selectedContactIds: string[],
  staleContactIds = ["contact-1", "contact-2"],
  auditState = {
    status: "complete",
    resolution: null as string | null,
    resolutionClaimToken: null as string | null,
    resolutionClaimedAt: null as Date | null,
  },
) {
  const contacts = new Map([
    ["contact-1", contact("contact-1", "one@example.com")],
    ["contact-2", contact("contact-2", "two@example.com")],
  ]);
  const decisions: Array<Record<string, unknown>> = [];
  const mutations: Array<Record<string, unknown>> = [];
  const createdContacts: Array<Record<string, unknown>> = [];
  let reviewed = 0;
  let jobFindCalls = 0;
  const alternative =
    action === "append" || action === "replace_selected"
      ? {
          id: "alternative-1",
          normalizedEmail: "new@example.com",
          name: "New Manager",
        }
      : null;
  const tx = {
    $queryRaw: async () => [{ id: "artist-1" }],
    contactAuditArtistDecision: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        decisions.push(data);
        return data;
      },
    },
    contactAuditJob: {
      findMany: async () => {
        jobFindCalls += 1;
        if (jobFindCalls === 1) {
          return [auditState];
        }
        return action === "deactivate_selected"
          ? staleContactIds.map((contactId, index) => ({
              id: `job-${index + 1}`,
              snapshotArtistName: "Artist One",
              finding: "stale",
              targetRosterEntryId: `entry-${contactId}`,
              alternatives: [],
            }))
          : [
              {
                id: "job-1",
                snapshotArtistName: "Artist One",
                finding: "changed",
                targetRosterEntryId: "entry-contact-1",
                alternatives: alternative ? [alternative] : [],
              },
            ];
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.reviewedAt) reviewed += 1;
        return { count: 1 };
      },
    },
    contactAuditRosterSnapshot: {
      findUnique: async () => ({
        id: "roster-1",
        runId: "run-1",
        snapshotArtistId: "artist-1",
        snapshotArtistName: "Artist One",
        createdAt: now,
        entries: [
          rosterEntry("contact-1", "one@example.com"),
          rosterEntry("contact-2", "two@example.com"),
        ],
      }),
    },
    contact: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const value = contacts.get(id);
          return value ? [value] : [];
        }),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdContacts.push(data);
        return { id: "created-contact" };
      },
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          const value = contacts.get(id);
          if (value) value.state = "quarantined";
        }
        return { count: where.id.in.length };
      },
    },
    contactAuditDecisionContact: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        mutations.push(...data);
        return { count: data.length };
      },
    },
  };

  const result = await resolveContactAuditArtist(
    {
      runId: "run-1",
      artistId: "artist-1",
      action,
      alternativeId: alternative?.id ?? null,
      selectedContactIds,
    },
    now,
    async (work) => work(tx as unknown as Prisma.TransactionClient),
  );
  return { result, decisions, mutations, createdContacts, contacts, reviewed };
}

test("artist audit can append a new contact without mutating the roster", async () => {
  const state = await runDecision("append", []);
  assert.equal(state.result.ok, true);
  assert.equal(state.createdContacts.length, 1);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.contacts.get("contact-1")?.state, "active");
  assert.equal(state.decisions[0].action, "append");
});

test("artist audit can replace any selected subset without rewriting identities", async () => {
  const state = await runDecision("replace_selected", ["contact-2"]);
  assert.equal(state.result.ok, true);
  assert.equal(state.createdContacts.length, 1);
  assert.equal(state.mutations.length, 1);
  assert.equal(state.contacts.get("contact-1")?.state, "active");
  assert.equal(state.contacts.get("contact-2")?.state, "quarantined");
  assert.equal(state.mutations[0].contactId, "contact-2");
  assert.equal(state.decisions[0].action, "replace_selected");
});

test("artist audit can deactivate selected stale contacts without adding one", async () => {
  const state = await runDecision("deactivate_selected", [
    "contact-1",
    "contact-2",
  ]);
  assert.equal(state.result.ok, true);
  assert.equal(state.createdContacts.length, 0);
  assert.equal(state.mutations.length, 2);
  assert.equal(state.contacts.get("contact-1")?.state, "quarantined");
  assert.equal(state.contacts.get("contact-2")?.state, "quarantined");
});

test("artist audit cannot deactivate a contact not explicitly found stale", async () => {
  const state = await runDecision(
    "deactivate_selected",
    ["contact-2"],
    ["contact-1"],
  );
  assert.equal(state.result.ok, false);
  assert.match(
    state.result.ok ? "" : state.result.error,
    /Only contacts explicitly found stale/,
  );
  assert.equal(state.contacts.get("contact-2")?.state, "active");
});

test("rejecting an artist audit preserves every existing contact", async () => {
  const state = await runDecision("rejected", []);
  assert.equal(state.result.ok, true);
  assert.equal(state.createdContacts.length, 0);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.contacts.get("contact-1")?.state, "active");
  assert.equal(state.contacts.get("contact-2")?.state, "active");
  assert.equal(state.reviewed, 1);
});

test("artist audit decisions wait for every contact job and legacy claim", async () => {
  const incomplete = await runDecision("rejected", [], [], {
    status: "claimed",
    resolution: null,
    resolutionClaimToken: null,
    resolutionClaimedAt: null,
  });
  assert.equal(incomplete.result.ok, false);
  assert.match(
    incomplete.result.ok ? "" : incomplete.result.error,
    /still running/,
  );

  const claimed = await runDecision("rejected", [], [], {
    status: "complete",
    resolution: null,
    resolutionClaimToken: "claim-1",
    resolutionClaimedAt: now,
  });
  assert.equal(claimed.result.ok, false);
  assert.match(
    claimed.result.ok ? "" : claimed.result.error,
    /decision is in progress/,
  );
});

test("artist audit decisions serialize with Sheet reconciliation", () => {
  const source = readFileSync(
    new URL("./contactAuditArtistDecision.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /acquireArtistIdentityLock\(tx\)/);
});
