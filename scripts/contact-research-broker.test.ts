import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
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
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
                    artist: {
                      id: "artist-1",
                      name: "Example Artist",
                    },
                  },
                ],
              }
            : { ok: true, status: "exhausted" }
        )
      );
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === "object");

  const directory = mkdtempSync(join(tmpdir(), "contact-research-broker-"));
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
  const submitted = await brokerRequest(socketPath, "/submit-exhausted", {
    jobId: "job-1",
    claimToken: "claim-1",
    notes: "Checked the bounded public sources.",
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.value, { ok: true, status: "exhausted" });
  assert.equal(authorization, "Bearer app-secret");
  assert.deepEqual(bodies, [
    { limit: 1 },
    {
      outcome: "exhausted",
      claimToken: "claim-1",
      notes: "Checked the bounded public sources.",
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(metricsFile, "utf8")), {
    claimCalls: 1,
    claimedJobs: 1,
    submissions: 1,
  });
});
