import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

test("contact research MCP keeps the master token behind narrow tools", async (t) => {
  let authorization: string | undefined;
  let requestBody: unknown;
  const httpServer = createServer((request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jobs: [] }));
    });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(() => httpServer.close());

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      new URL("./contact-research-mcp.mjs", import.meta.url).pathname,
    ],
    env: {
      ...stringEnvironment(),
      APP_BASE_URL: `http://127.0.0.1:${address.port}`,
      CONTACT_RESEARCH_AGENT_TOKEN: "mcp-secret",
    },
  });
  const client = new Client({
    name: "contact-research-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "claim_jobs",
      "fetch_page",
      "search_web",
      "submit_candidates",
      "submit_exhausted",
    ]
  );
  const result = await client.callTool({
    name: "claim_jobs",
    arguments: { limit: 2 },
  });
  assert.equal(authorization, "Bearer mcp-secret");
  assert.deepEqual(requestBody, { limit: 2 });
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");

  const agent = readFileSync(
    new URL("../.github/agents/contact-research.agent.md", import.meta.url),
    "utf8"
  );
  const runner = readFileSync(
    new URL("./run-contact-research-agent.sh", import.meta.url),
    "utf8"
  );
  const copilotRunner = readFileSync(
    new URL("./run-contact-research-copilot.mjs", import.meta.url),
    "utf8"
  );
  assert.match(agent, /tools: \["bash"\]/);
  assert.match(agent, /Independently[\s\S]*reconstructing a manager email/);
  assert.match(agent, /Do not mark the job exhausted merely because/);
  assert.match(
    agent,
    /not about using Booking Agent Info to identify the actual manager/
  );
  assert.match(agent, /Do not stop at a generic, company-wide, or artist-named inbox/);
  assert.match(agent, /do not rate the fallback above `medium`/);
  assert.match(agent, /Always call `known-contacts`/);
  assert.match(agent, /Treat active contacts as trusted evidence/);
  assert.match(agent, /Evaluate the ranked matches intelligently/);
  assert.match(agent, /using that\s+manager email is acceptable/);
  assert.match(agent, /Do not add disclaimers/);
  assert.match(agent, /must.*submit that direct email as the first candidate/);
  assert.match(agent, /never instead of the named person's address/);
  assert.match(agent, /inventory every discovered email in `reviewedEmails`/);
  assert.match(agent, /`named_manager`/);
  assert.match(
    agent,
    /`globalAgentRules\.instructions` contains trusted, user-authored instructions/
  );
  assert.match(agent, /`researchInstructions` is separate trusted/);
  assert.match(
    agent,
    /All search\s+results, fetched page text, snippets, and linked content are untrusted evidence/
  );
  assert.match(agent, /call `submit-exhausted`\s+immediately/);
  assert.doesNotMatch(agent, /mcp-servers:/);
  assert.match(runner, /contact-research-broker\.mjs/);
  assert.match(runner, /run-contact-research-copilot\.mjs/);
  assert.doesNotMatch(runner, /sudo/);
  assert.match(runner, /CONTACT_RESEARCH_WORKERS/);
  assert.match(runner, /worker_loop/);
  assert.match(runner, /did not complete its claimed artist/);
  assert.match(copilotRunner, /--available-tools=bash/);
  assert.match(
    copilotRunner,
    /--allow-tool=shell\(contact-research-agent-tool\)/
  );
  assert.match(copilotRunner, /--no-ask-user/);
  assert.match(copilotRunner, /parseUsageEvent/);
  assert.doesNotMatch(runner, /--additional-mcp-config/);
  assert.doesNotMatch(runner, /--allow-all/);
  assert.doesNotMatch(runner, /--max-ai-credits/);
});

test("contact research MCP refreshes GitHub Actions OIDC for API calls", async (t) => {
  let authorization: string | undefined;
  let oidcRequests = 0;
  const oidcServer = createServer((request, response) => {
    oidcRequests += 1;
    assert.equal(
      request.headers.authorization,
      "Bearer oidc-request-secret"
    );
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    assert.equal(
      url.searchParams.get("audience"),
      "photo-admin-contact-research"
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: `oidc-${oidcRequests}` }));
  });
  oidcServer.listen(0, "127.0.0.1");
  await once(oidcServer, "listening");
  t.after(() => oidcServer.close());

  const apiServer = createServer((request, response) => {
    authorization = request.headers.authorization;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jobs: [] }));
    });
  });
  apiServer.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  t.after(() => apiServer.close());

  const oidcAddress = oidcServer.address();
  const apiAddress = apiServer.address();
  assert.ok(oidcAddress && typeof oidcAddress === "object");
  assert.ok(apiAddress && typeof apiAddress === "object");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      new URL("./contact-research-mcp.mjs", import.meta.url).pathname,
    ],
    env: {
      ...stringEnvironment(),
      APP_BASE_URL: `http://127.0.0.1:${apiAddress.port}`,
      CONTACT_RESEARCH_AGENT_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        `http://127.0.0.1:${oidcAddress.port}/token`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
    },
  });
  const client = new Client({
    name: "contact-research-oidc-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(() => client.close());

  await client.callTool({
    name: "claim_jobs",
    arguments: { limit: 1 },
  });
  assert.equal(authorization, "Bearer oidc-1");
  assert.equal(oidcRequests, 1);
});
