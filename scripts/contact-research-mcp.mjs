import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchReadablePage,
  searchWeb,
} from "./contact-research-web.mjs";

const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
const token = process.env.CONTACT_RESEARCH_AGENT_TOKEN?.trim();
const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
const oidcRequestToken =
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
const oidcAudience = "photo-admin-contact-research";
if (
  !baseUrl ||
  (!token && (!oidcRequestUrl || !oidcRequestToken))
) {
  throw new Error(
    "APP_BASE_URL plus a static token or GitHub Actions OIDC environment are required"
  );
}

async function authorizationToken() {
  if (oidcRequestUrl && oidcRequestToken) {
    const url = new URL(oidcRequestUrl);
    url.searchParams.set("audience", oidcAudience);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${oidcRequestToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub Actions OIDC returned ${response.status}`
      );
    }
    const data = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      typeof data.value !== "string" ||
      !data.value
    ) {
      throw new Error("GitHub Actions OIDC response omitted value");
    }
    return data.value;
  }
  return token;
}

async function request(path, body) {
  const requestToken = await authorizationToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requestToken}`,
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
  "search_web",
  {
    description:
      "Search the public web for artist management evidence. Returns result titles, URLs, and snippets.",
    inputSchema: {
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(10).default(8),
    },
  },
  async ({ query, limit }) => toolResult(await searchWeb(query, limit))
);

server.registerTool(
  "fetch_page",
  {
    description:
      "Fetch a public HTTP(S) page and extract bounded readable text and links. Private-network URLs are blocked.",
    inputSchema: {
      url: z.string().url(),
    },
  },
  async ({ url }) => toolResult(await fetchReadablePage(url))
);

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

server.registerTool(
    "submit_skipped",
    {
      description:
        "Intentionally skip a claimed artist only when the trusted global-rule snapshot requires it.",
      inputSchema: {
        jobId: z.string().min(1),
        claimToken: z.string().min(1),
        notes: z.string().min(1).max(4_000),
        ruleVersion: z.number().int().min(1),
        ruleText: z.string().min(1).max(8_000),
      },
    },
    async ({ jobId, claimToken, notes, ruleVersion, ruleText }) =>
      toolResult(
        await request(
          `/api/contact-research/${encodeURIComponent(jobId)}/result`,
          {
            outcome: "skipped",
            claimToken,
            notes,
            ruleVersion,
            ruleText,
          }
        )
      )
);

const transport = new StdioServerTransport();
await server.connect(transport);
