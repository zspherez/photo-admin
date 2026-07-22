import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import test from "node:test";

async function waitForSocket(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const stat = await import("node:fs/promises").then(({ stat }) =>
        stat(path)
      );
      if (stat.isSocket()) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("broker did not create its socket");
}

async function brokerRequest(
  socketPath: string,
  path: string,
  body: unknown,
  session = "session-1"
) {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-contact-audit-session": session,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("audit broker isolates credentials and submits only audit results", async (t) => {
  let authorization: string | undefined;
  const requests: Array<{ url: string; body: unknown }> = [];
  const rosterReview = [
    {
      rosterEntryId: "entry-1",
      assessment: "stale",
      notes: "The audited target is no longer listed.",
    },
    {
      rosterEntryId: "entry-2",
      assessment: "coexisting",
      notes: "The other stored manager remains on the team.",
    },
  ];
  const api = createServer((apiRequest, response) => {
    authorization = apiRequest.headers.authorization;
    const chunks: Buffer[] = [];
    apiRequest.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    apiRequest.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: apiRequest.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          apiRequest.url === "/api/contact-audit/claim"
            ? {
                jobs: [
                  {
                    id: "job-1",
                    runId: "run-1",
                    claimToken: "claim-1",
                    claimExpiresAt: "2026-07-21T18:00:00.000Z",
                    attemptCount: 1,
                    contact: {
                      artistName: "Example Artist",
                      email: "old@example.com",
                      phone: null,
                      directOutreachNote: null,
                      name: "Old Manager",
                      role: "management",
                      source: "manual",
                      notes: null,
                      isFullTeam: false,
                    },
                    contactRoster: {
                      snapshotId: "roster-1",
                      snapshotAt: "2026-07-21T17:00:00.000Z",
                      completeness: "complete",
                      contacts: [
                        {
                          rosterEntryId: "entry-1",
                          contactId: "contact-1",
                          isTarget: true,
                          email: "old@example.com",
                          phone: null,
                          directOutreachNote: null,
                          name: "Old Manager",
                          role: "management",
                          source: "manual",
                          notes: null,
                          isFullTeam: false,
                        },
                        {
                          rosterEntryId: "entry-2",
                          contactId: "contact-2",
                          isTarget: false,
                          email: "other@example.com",
                          phone: "+1 212 555 0100",
                          directOutreachNote: "@othermanager",
                          name: "Other Manager",
                          role: "legacy",
                          source: "sheet",
                          notes: "Full team contact.",
                          isFullTeam: true,
                        },
                      ],
                    },
                  },
                ],
              }
            : apiRequest.url === "/api/contact-audit/known-contacts"
              ? { query: body, matches: [] }
              : { ok: true, runComplete: true }
        )
      );
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === "object");

  const directory = mkdtempSync(join(process.cwd(), ".ca-"));
  const socketPath = join(directory, "broker.sock");
  const metricsFile = join(directory, "metrics.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broker = spawn(
    process.execPath,
    [new URL("./contact-audit-broker.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        APP_BASE_URL: `http://127.0.0.1:${apiAddress.port}`,
        CONTACT_AUDIT_AGENT_TOKEN: "app-secret",
        CONTACT_AUDIT_BROKER_SOCKET: socketPath,
        CONTACT_AUDIT_BROKER_METRICS_FILE: metricsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  t.after(() => broker.kill("SIGTERM"));
  await waitForSocket(socketPath);

  const claimed = await brokerRequest(socketPath, "/claim", { limit: 1 });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.value, {
    jobs: [
      {
        jobId: "job-1",
        runId: "run-1",
        claimToken: "claim-1",
        claimExpiresAt: "2026-07-21T18:00:00.000Z",
        attemptCount: 1,
        contact: {
          artistName: "Example Artist",
          email: "old@example.com",
          phone: null,
          directOutreachNote: null,
          name: "Old Manager",
          role: "management",
          source: "manual",
          notes: null,
          isFullTeam: false,
        },
        contactRoster: {
          snapshotId: "roster-1",
          snapshotAt: "2026-07-21T17:00:00.000Z",
          completeness: "complete",
          contacts: [
            {
              rosterEntryId: "entry-1",
              contactId: "contact-1",
              isTarget: true,
              email: "old@example.com",
              phone: null,
              directOutreachNote: null,
              name: "Old Manager",
              role: "management",
              source: "manual",
              notes: null,
              isFullTeam: false,
            },
            {
              rosterEntryId: "entry-2",
              contactId: "contact-2",
              isTarget: false,
              email: "other@example.com",
              phone: "+1 212 555 0100",
              directOutreachNote: "@othermanager",
              name: "Other Manager",
              role: "legacy",
              source: "sheet",
              notes: "Full team contact.",
              isFullTeam: true,
            },
          ],
        },
      },
    ],
  });
  const lookup = await brokerRequest(socketPath, "/known-contacts", {
    managerName: "New Manager",
    company: "Example Management",
    domain: "example.com",
  });
  assert.equal(lookup.status, 200);
  const invalidRoster = await brokerRequest(socketPath, "/validate-result", {
    jobId: "job-1",
    claimToken: "claim-1",
    finding: "current",
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
    evidence:
      "The official artist profile still confirms the audited management contact.",
    confidence: "high",
    alternatives: [],
    rosterReview: [rosterReview[0]],
  });
  assert.equal(invalidRoster.status, 400);
  assert.match(
    String(
      (invalidRoster.value as { error?: unknown }).error,
    ),
    /missing: entry-2/,
  );
  const invalidStale = await brokerRequest(socketPath, "/submit-result", {
    jobId: "job-1",
    claimToken: "claim-1",
    finding: "stale",
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
    evidence: "The existing contact is no longer current.",
    confidence: "medium",
    alternatives: [
      {
        email: "replacement@example.com",
        role: "management",
        sourceUrls: ["https://nuwave.io/"],
        evidence: "A plausible replacement manager.",
        confidence: "medium",
      },
    ],
    rosterReview,
  });
  assert.equal(invalidStale.status, 400);
  for (const evidence of [
    "test evidence for save",
    "test no official source",
    "test minimal no official source",
  ]) {
    const leaked = await brokerRequest(socketPath, "/submit-result", {
      jobId: "job-1",
      claimToken: "claim-1",
      finding: "current",
      sourceUrls: ["https://www.instagram.com/drinkurwater/"],
      evidence,
      confidence: "low",
      alternatives: [],
      rosterReview,
    });
    assert.equal(leaked.status, 400);
  }
  const wrongJob = await brokerRequest(socketPath, "/submit-result", {
    jobId: "contact-1",
    claimToken: "claim-1",
    finding: "stale",
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
    evidence: "The artist now lists a different management company.",
    confidence: "medium",
    alternatives: [],
    rosterReview,
  });
  assert.equal(wrongJob.status, 409);
  const finalPayload = {
    jobId: "job-1",
    claimToken: "claim-1",
    finding: "changed",
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
    evidence:
      "DRINKURWATER's official Instagram bio publishes Justin's management address.",
    confidence: "high",
    notes: "Checked official artist and agency pages.",
    alternatives: [
      {
        email: "justin@nuwave.io",
        name: "Justin",
        role: "management",
        sourceUrls: ["https://www.instagram.com/drinkurwater/"],
        evidence:
          "DRINKURWATER's official Instagram bio publishes MGMT: justin@nuwave.io.",
        confidence: "high",
      },
    ],
    rosterReview,
  };
  const validated = await brokerRequest(
    socketPath,
    "/validate-result",
    finalPayload
  );
  assert.deepEqual(validated, { status: 200, value: { ok: true } });
  const submitted = await brokerRequest(
    socketPath,
    "/submit-result",
    finalPayload
  );
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.value, { ok: true, runComplete: true });
  assert.equal(
    authorization,
    ["Bear", "er ", "app-secret"].join("")
  );
  assert.deepEqual(requests, [
    { url: "/api/contact-audit/claim", body: { limit: 1 } },
    {
      url: "/api/contact-audit/known-contacts",
      body: {
        managerName: "New Manager",
        company: "Example Management",
        domain: "example.com",
      },
    },
    {
      url: "/api/contact-audit/job-1/result",
      body: {
        claimToken: "claim-1",
        finding: "changed",
        sourceUrls: ["https://www.instagram.com/drinkurwater/"],
        evidence:
          "DRINKURWATER's official Instagram bio publishes Justin's management address.",
        confidence: "high",
        notes: "Checked official artist and agency pages.",
        alternatives: [
          {
            email: "justin@nuwave.io",
            name: "Justin",
            role: "management",
            sourceUrls: ["https://www.instagram.com/drinkurwater/"],
            evidence:
              "DRINKURWATER's official Instagram bio publishes MGMT: justin@nuwave.io.",
            confidence: "high",
          },
        ],
        rosterReview,
      },
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(metricsFile, "utf8")), {
    claimCalls: 1,
    claimedJobs: 1,
    submissions: 1,
    artistBySession: { "session-1": "Example Artist" },
    sessions: {
      "session-1": {
        artist: "Example Artist",
        claimed: true,
        completed: true,
        empty: false,
        stale: false,
      },
    },
  });
});
