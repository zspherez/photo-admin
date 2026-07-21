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
          "x-contact-research-session": session,
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

test("agent broker keeps app authentication behind narrow localhost tools", async (t) => {
  let authorization: string | undefined;
  const bodies: unknown[] = [];
  const api = createServer((request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/api/contact-research/claim"
            ? {
                jobs: [
                  {
                    id: "job-1",
                    claimToken: "claim-1",
                    priority: 10,
                    globalAgentRules: {
                      scope: "global",
                      version: 4,
                      instructions:
                        "Skip artists managed by a Metatone manager.",
                      directOutreachInstructions:
                        "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.",
                    },
                    artist: {
                      id: "artist-1",
                      name: "Example Artist",
                    },
                  },
                ],
              }
            : request.url === "/api/contact-research/known-contacts"
              ? {
                  query: {
                    managerName: "Greg Burnell",
                    company: "Palm Artists",
                    domain: "palmartists.com",
                  },
                  matches: [
                    {
                      email: "greg@palmartists.com",
                      name: null,
                      evidence: null,
                      source: "active_contact",
                      status: "active",
                      artists: ["Gorgon City", "SG Lewis"],
                      sourceUrls: [],
                      score: 125,
                      matchReasons: [
                        "same company domain",
                        "email local-part matches manager first name",
                        "already present in active contact list",
                      ],
                      sources: ["active_contact"],
                    },
                  ],
                }
              : {
                  ok: true,
                  status:
                    body.outcome === "skipped" ? "skipped" : "exhausted",
                }
        )
      );
    });

  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === "object");

  const directory = mkdtempSync(join(process.cwd(), ".br-"));
  const socketPath = join(directory, "broker.sock");
  const metricsFile = join(directory, "metrics.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broker = spawn(
    process.execPath,
    [new URL("./contact-research-broker.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        APP_BASE_URL: `http://127.0.0.1:${apiAddress.port}`,
        CONTACT_RESEARCH_AGENT_TOKEN: "app-secret",
        CONTACT_RESEARCH_BROKER_SOCKET: socketPath,
        CONTACT_RESEARCH_BROKER_METRICS_FILE: metricsFile,
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
        claimToken: "claim-1",
        priority: 10,
        globalAgentRules: {
          scope: "global",
          version: 4,
          instructions: "Skip artists managed by a Metatone manager.",
          directOutreachInstructions:
            "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.",
        },
        artist: { name: "Example Artist" },
      },
    ],
  });

  const duplicateClaim = await brokerRequest(
    socketPath,
    "/claim",
    { limit: 1 }
  );
  assert.equal(duplicateClaim.status, 409);
  const knownContacts = await brokerRequest(
    socketPath,
    "/known-contacts",
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }
  );
  assert.equal(knownContacts.status, 200);
  assert.deepEqual(knownContacts.value, {
    query: {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    },
    matches: [
      {
        email: "greg@palmartists.com",
        name: null,
        evidence: null,
        source: "active_contact",
        status: "active",
        artists: ["Gorgon City", "SG Lewis"],
        sourceUrls: [],
        score: 125,
        matchReasons: [
          "same company domain",
          "email local-part matches manager first name",
          "already present in active contact list",
        ],
        sources: ["active_contact"],
      },
    ],
  });
  const leakedEvidence = await brokerRequest(
    socketPath,
    "/submit-candidates",
    {
      jobId: "job-1",
      claimToken: "claim-1",
      notes: "Official artist sources were checked.",
      candidates: [
        {
          email: "justin@nuwave.io",
          name: "Justin",
          sourceUrls: ["https://www.instagram.com/drinkurwater/"],
          evidence: "test evidence for save",
          confidence: "high",
          needsApproval: true,
          officialSource: null,
        },
      ],
      reviewedEmails: [
        {
          email: "justin@nuwave.io",
          classification: "named_manager",
          personName: "Justin",
          reason: "Official Instagram labels this address MGMT.",
        },
      ],
    }
  );
  assert.equal(leakedEvidence.status, 400);
  const leakedExhausted = await brokerRequest(
    socketPath,
    "/submit-exhausted",
    {
      jobId: "job-1",
      claimToken: "claim-1",
      notes: "test no official source",
    }
  );
  assert.equal(leakedExhausted.status, 400);
  const leakedMinimal = await brokerRequest(
    socketPath,
    "/submit-exhausted",
    {
      jobId: "job-1",
      claimToken: "claim-1",
      notes: "test minimal no official source",
    }
  );
  assert.equal(leakedMinimal.status, 400);
  const wrongId = await brokerRequest(
    socketPath,
    "/submit-exhausted",
    {
      jobId: "artist-1",
      claimToken: "claim-1",
      notes: "Wrong identifier.",
    }
  );
  assert.equal(wrongId.status, 409);
  const finalPayload = {
    jobId: "job-1",
    claimToken: "claim-1",
    notes:
      "DRINKURWATER's official Instagram explicitly labels the manager.",
    candidates: [
      {
        email: "justin@nuwave.io",
        name: "Justin",
        sourceUrls: ["https://www.instagram.com/drinkurwater/"],
        evidence:
          "DRINKURWATER's official Instagram bio publishes MGMT: justin@nuwave.io.",
        confidence: "high",
        needsApproval: false,
        officialSource: {
          type: "instagram",
          url: "https://www.instagram.com/drinkurwater/",
          managementLabel: "mgmt",
          evidence:
            "DRINKURWATER official Instagram bio: MGMT: justin@nuwave.io",
        },
      },
    ],
    reviewedEmails: [
      {
        email: "justin@nuwave.io",
        classification: "named_manager",
        personName: "Justin",
        reason:
          "DRINKURWATER's official Instagram labels Justin's address MGMT.",
      },
    ],
  };
  const validated = await brokerRequest(socketPath, "/validate-result", {
    action: "submit-candidates",
    payload: finalPayload,
  });
  assert.deepEqual(validated, {
    status: 200,
    value: { ok: true, action: "submit-candidates" },
  });
  const submitted = await brokerRequest(
    socketPath,
    "/submit-candidates",
    finalPayload
  );
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.value, { ok: true, status: "exhausted" });
  const secondClaim = await brokerRequest(
    socketPath,
    "/claim",
    { limit: 1 },
    "session-2"
  );
  assert.equal(secondClaim.status, 200);
  const skipped = await brokerRequest(
    socketPath,
    "/submit-skipped",
    {
      jobId: "job-1",
      claimToken: "claim-1",
      notes: "Metatone artist",
      ruleVersion: 4,
      ruleText: "Skip artists managed by a Metatone manager.",
    },
    "session-2"
  );
  assert.equal(skipped.status, 200);
  assert.deepEqual(skipped.value, { ok: true, status: "skipped" });
  assert.equal(authorization, "Bearer app-secret");
  assert.deepEqual(bodies, [
    { limit: 1 },
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    },
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes:
        "DRINKURWATER's official Instagram explicitly labels the manager.",
      candidates: [
        {
          email: "justin@nuwave.io",
          name: "Justin",
          sourceUrls: ["https://www.instagram.com/drinkurwater/"],
          evidence:
            "DRINKURWATER's official Instagram bio publishes MGMT: justin@nuwave.io.",
          confidence: "high",
          needsApproval: false,
          officialSource: {
            type: "instagram",
            url: "https://www.instagram.com/drinkurwater/",
            managementLabel: "mgmt",
            evidence:
              "DRINKURWATER official Instagram bio: MGMT: justin@nuwave.io",
          },
          role: "management",
        },
      ],
    },
    { limit: 1 },
    {
      outcome: "skipped",
      claimToken: "claim-1",
      notes: "Metatone artist",
      ruleVersion: 4,
      ruleText: "Skip artists managed by a Metatone manager.",
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(metricsFile, "utf8")), {
    claimCalls: 2,
    claimedJobs: 2,
    submissions: 2,
    artistBySession: {
      "session-1": "Example Artist",
      "session-2": "Example Artist",
    },
    sessions: {
      "session-1": {
        artist: "Example Artist",
        claimed: true,
        completed: true,
        empty: false,
        stale: false,
      },
      "session-2": {
        artist: "Example Artist",
        claimed: true,
        completed: true,
        empty: false,
        stale: false,
      },
    },
  });
});

test("agent skip submissions are schema and claim-token protected", () => {
  const source = readFileSync(
    new URL("./contact-research-broker.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /"submit-skipped": z\.object\(\{[\s\S]*jobId: z\.string\(\)\.min\(1\)[\s\S]*claimToken: z\.string\(\)\.min\(1\)[\s\S]*notes: z\.string\(\)\.min\(1\)\.max\(4_000\)[\s\S]*ruleVersion: z\.number\(\)\.int\(\)\.min\(1\)[\s\S]*ruleText: z\.string\(\)\.min\(1\)\.max\(8_000\)/
  );
  assert.match(
    source,
    /case "submit-skipped": \{[\s\S]*requireSessionClaim\(state, input\)[\s\S]*outcome: "skipped"[\s\S]*claimToken: input\.claimToken/
  );
  assert.match(
    source,
    /error\.status === 409[\s\S]*metrics\.sessions\[sessionId\]\.stale = true/
  );
});

test("broker accepts versioned freeform instruction provenance for direct outreach", () => {
  const source = readFileSync(
    new URL("./contact-research-broker.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /const directOutreachSchema = z[\s\S]*instructionVersion: z\.number\(\)\.int\(\)\.min\(1\)[\s\S]*instructionExcerpt: z\.string\(\)\.min\(1\)\.max\(7_984\)[\s\S]*managerName: z\.string\(\)\.min\(1\)\.max\(200\)[\s\S]*note: z\.string\(\)\.min\(1\)\.max\(900\)[\s\S]*sourceUrl: z\.string\(\)\.url\(\)[\s\S]*quote: z\.string\(\)\.min\(1\)\.max\(2_000\)[\s\S]*\.min\(1\)[\s\S]*\.max\(5\)[\s\S]*\.strict\(\)/,
  );
  assert.match(
    source,
    /"submit-direct-outreach": z\.object\(\{[\s\S]*directOutreach: directOutreachSchema/,
  );
  assert.match(
    source,
    /case "submit-direct-outreach": \{[\s\S]*requireSessionClaim\(state, input\)[\s\S]*candidates: \[\][\s\S]*directOutreach: input\.directOutreach/,
  );
  assert.match(
    source,
    /case "submit-candidates": \{[\s\S]*input\.directOutreach[\s\S]*directOutreach: input\.directOutreach/,
  );
});
