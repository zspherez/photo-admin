import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
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
                    contact: {
                      artistName: "Example Artist",
                      email: "old@example.com",
                      name: "Old Manager",
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

  const directory = join(
    process.cwd(),
    `.ca-${process.pid}-${Date.now().toString(36)}`
  );
  mkdirSync(directory);
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
        contact: {
          artistName: "Example Artist",
          email: "old@example.com",
          name: "Old Manager",
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
  const invalidStale = await brokerRequest(socketPath, "/submit-result", {
    jobId: "job-1",
    claimToken: "claim-1",
    finding: "stale",
    sourceUrls: ["https://artist.example/contact"],
    evidence: "The existing contact is no longer current.",
    confidence: "medium",
    alternatives: [
      {
        email: "replacement@example.com",
        role: "management",
        sourceUrls: ["https://agency.example/team"],
        evidence: "A plausible replacement manager.",
        confidence: "medium",
      },
    ],
  });
  assert.equal(invalidStale.status, 400);
  const wrongJob = await brokerRequest(socketPath, "/submit-result", {
    jobId: "contact-1",
    claimToken: "claim-1",
    finding: "stale",
    sourceUrls: ["https://artist.example/contact"],
    evidence: "The artist now lists a different management company.",
    confidence: "medium",
    alternatives: [],
  });
  assert.equal(wrongJob.status, 409);
  const submitted = await brokerRequest(socketPath, "/submit-result", {
    jobId: "job-1",
    claimToken: "claim-1",
    finding: "changed",
    sourceUrls: ["https://artist.example/contact"],
    evidence: "The official artist page publishes a new manager.",
    confidence: "high",
    notes: "Checked official artist and agency pages.",
    alternatives: [
      {
        email: "new@example.com",
        name: "New Manager",
        role: "management",
        sourceUrls: ["https://agency.example/team"],
        evidence: "The official agency roster confirms the address.",
        confidence: "high",
      },
    ],
  });
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
        sourceUrls: ["https://artist.example/contact"],
        evidence: "The official artist page publishes a new manager.",
        confidence: "high",
        notes: "Checked official artist and agency pages.",
        alternatives: [
          {
            email: "new@example.com",
            name: "New Manager",
            role: "management",
            sourceUrls: ["https://agency.example/team"],
            evidence: "The official agency roster confirms the address.",
            confidence: "high",
          },
        ],
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
