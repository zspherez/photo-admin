import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/field";
import { requireServerActionAuth } from "@/lib/auth";
import {
  GLOBAL_AGENT_RULES_MAX_LENGTH,
  readGlobalAgentRules,
  saveGlobalAgentRules,
} from "@/lib/agentRules";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agent rules" };

async function saveAgentRulesAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/agents");
  let destination = "/settings/agents?saved=1";
  try {
    await saveGlobalAgentRules(formData.get("instructions"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    destination = `/settings/agents?error=${encodeURIComponent(detail.slice(0, 180))}`;
  }
  revalidatePath("/settings/agents");
  revalidatePath("/settings");
  redirect(destination);
}

export default async function AgentRulesPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const saved = firstSearchParam(raw.saved);
  const error = firstSearchParam(raw.error);
  const rules = await readGlobalAgentRules();

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href="/settings"
        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Agent rules
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Trusted instructions shared by contact research and other agent jobs.
      </p>

      {saved && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Saved version {rules.version}.
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={saveAgentRulesAction} className="space-y-5">
            <TextArea
              name="instructions"
              label="Global agent rules"
              description={`Scope: all agent jobs. Maximum ${GLOBAL_AGENT_RULES_MAX_LENGTH.toLocaleString()} characters. Artist-specific research notes remain separate and apply only to that artist.`}
              placeholder="Example: Prefer official artist and management-company sources. Explain uncertainty explicitly."
              defaultValue={rules.instructions}
              rows={12}
              maxLength={GLOBAL_AGENT_RULES_MAX_LENGTH}
            />
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
              Saving creates a new version for future claims. Jobs already
              claimed keep their snapshotted rules and claim token; pending,
              expired, or requeued jobs receive the latest version when next
              claimed.
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-zinc-500">
                Current version: {rules.version || "not saved"}
              </p>
              <Button type="submit" variant="primary">
                Save rules
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
