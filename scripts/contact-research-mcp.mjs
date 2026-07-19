import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
const token = process.env.CONTACT_RESEARCH_AGENT_TOKEN?.trim();
if (!baseUrl || !token) {
  throw new Error(
    "APP_BASE_URL and CONTACT_RESEARCH_AGENT_TOKEN are required"
  );
}

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 500) || "invalid response" };
  }
  if (!response.ok) {
    throw new Error(
      `photo-admin returned ${response.status}: ${
        typeof data.error === "string" ? data.error : "request failed"
      }`
    );
  }
  return data;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

const candidateSchema = z.object({
  email: z.string().describe("Professional contact email"),
  name: z.string().nullable().optional().describe("Contact name"),
  sourceUrls: z
    .array(z.string().url())
    .min(1)
    .max(5)
    .describe("Public evidence URLs"),
  evidence: z
    .string()
    .min(1)
    .describe("Why the sources support this exact address and role"),
  confidence: z.enum(["high", "medium", "low"]),
});

const server = new McpServer({
  name: "photo-admin-contact-research",
  version: "1.0.0",
});

server.registerTool(
  "claim_jobs",
  {
    description:
      "Claim queued artist contact-research jobs from photo-admin. Claims expire after one hour.",
    inputSchema: {
      limit: z.number().int().min(1).max(10).default(3),
    },
  },
  async ({ limit }) => toolResult(await request("/api/contact-research/claim", { limit }))
);

server.registerTool(
  "submit_candidates",
  {
    description:
      "Submit evidence-backed artist-manager candidates for human review. Booking, publicist, label, and other contacts are not accepted.",
    inputSchema: {
      jobId: z.string().min(1),
      claimToken: z.string().min(1),
      notes: z.string().max(4_000).nullable().optional(),
      candidates: z.array(candidateSchema).min(1).max(10),
    },
  },
  async ({ jobId, claimToken, notes, candidates }) =>
    toolResult(
      await request(
        `/api/contact-research/${encodeURIComponent(jobId)}/result`,
        {
          outcome: "candidates",
          claimToken,
          notes: notes ?? null,
          candidates: candidates.map((candidate) => ({
            ...candidate,
            role: "management",
          })),
        }
      )
    )
);

server.registerTool(
  "submit_exhausted",
  {
    description:
      "Mark a claimed research job exhausted after bounded public-source research finds no defensible professional email.",
    inputSchema: {
      jobId: z.string().min(1),
      claimToken: z.string().min(1),
      notes: z.string().min(1).max(4_000),
    },
  },
  async ({ jobId, claimToken, notes }) =>
    toolResult(
      await request(
        `/api/contact-research/${encodeURIComponent(jobId)}/result`,
        {
          outcome: "exhausted",
          claimToken,
          notes,
        }
      )
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);
