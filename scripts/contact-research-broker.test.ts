import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
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

async function brokerRequest(socketPath: string, path: string, body: unknown) {
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
  let body: unknown;
  const api = createServer((request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jobs: [] }));
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === "object");

  const directory = mkdtempSync(join(tmpdir(), "contact-research-broker-"));
  const socketPath = join(directory, "broker.sock");
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  t.after(() => broker.kill("SIGTERM"));
  await waitForSocket(socketPath);

  const claimed = await brokerRequest(socketPath, "/claim", { limit: 2 });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.value, { jobs: [] });
  assert.equal(authorization, "Bearer app-secret");
  assert.deepEqual(body, { limit: 2 });
});
