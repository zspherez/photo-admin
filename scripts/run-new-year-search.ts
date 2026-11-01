import { searchWeb, fetchReadablePage } from "./contact-research-web.mjs";
import { extractRunEvidence, type RunEvidence } from "../lib/newYearSearchEvidence";

const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
const batchId = process.env.NEW_YEAR_BATCH_ID;
if (!baseUrl || !batchId) throw new Error("APP_BASE_URL and NEW_YEAR_BATCH_ID are required");

async function workerRequest(body: object) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("GitHub Actions OIDC is required");
  const oidcUrl = new URL(url);
  oidcUrl.searchParams.set("audience", "photo-admin-new-year-runs-search");
  const oidc = await fetch(oidcUrl, { headers: { authorization: `bearer ${bearer}` }, signal: AbortSignal.timeout(15_000) });
  if (!oidc.ok) throw new Error(`OIDC token request failed: ${oidc.status}`);
  const { value } = await oidc.json();
  const response = await fetch(`${baseUrl}/api/new-year-search`, {
    method: "POST",
    headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
    body: JSON.stringify({ batchId, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Worker API returned ${response.status}`);
  return response.json();
}

async function discover(artist: string, year: number): Promise<RunEvidence[]> {
  const rows = new Map<string, RunEvidence>();
  const queries = [
    `"${artist}" December ${year} tour dates concerts`,
    `"${artist}" January ${year + 1} tour dates concerts`,
  ];
  let successfulSearches = 0;
  for (const query of queries) {
    let results;
    try {
      results = await searchWeb(query, 3);
      successfulSearches++;
    } catch (error) {
      console.warn("Web search unavailable:", error);
      continue;
    }
    for (const result of results.slice(0, 2)) {
      try {
        const page = await fetchReadablePage(result.url);
        for (const block of page.blocks.slice(0, 150)) {
          const row = extractRunEvidence(artist, page.title, block, page.url, year);
          if (row) rows.set(`${row.date}|${row.city.toLowerCase()}|${row.state}`, row);
        }
      } catch (error) {
        console.warn("Page unavailable:", error);
      }
    }
  }
  if (!successfulSearches) throw new Error("Both public searches failed");
  return [...rows.values()].slice(0, 12);
}

for (let processed = 0; processed < 100; processed++) {
  const claim = await workerRequest({ action: "claim" });
  if (claim.done) break;
  if (claim.waiting) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    continue;
  }
  let rows: RunEvidence[] = [];
  let error: string | undefined;
  try {
    rows = await discover(claim.artist, claim.year);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  await workerRequest({
    action: "finish", jobId: claim.jobId, claimToken: claim.claimToken, rows, error,
  });
  console.log(`${claim.artist}: ${error ?? `${rows.length} event evidence row(s)`}`);
}
