import { appConfig } from "@/lib/appConfig";

export async function triggerScheduledOutreachWorkflow(
  token: string | undefined = process.env.PROFESSIONAL_CONTACT_RESEARCH_DISPATCH_TOKEN,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token?.trim()) {
    return {
      ok: false,
      error: "GitHub workflow dispatch is not configured",
    };
  }

  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(appConfig.repository.owner)}/${encodeURIComponent(appConfig.repository.name)}/actions/workflows/send-scheduled.yml/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { mode: "manual" },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `GitHub rejected the workflow dispatch (${response.status})`,
      };
    }
    return { ok: true };
  } catch (error) {
    console.error("Scheduled outreach workflow dispatch failed", error);
    return {
      ok: false,
      error: "Unable to request the scheduled outreach workflow",
    };
  }
}
