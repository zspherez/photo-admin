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
    ["claim_jobs", "submit_candidates", "submit_exhausted"]
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
  assert.match(agent, /tools: \["web", "contact-research\/\*"\]/);
  assert.doesNotMatch(agent, /tools: \[[^\]]*"execute"/);
  assert.match(runner, /--allow-all-tools/);
  assert.match(runner, /--allow-all-urls/);
  assert.match(runner, /--no-ask-user/);
  assert.doesNotMatch(runner, /--max-ai-credits/);
});
