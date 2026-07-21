import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { readGlobalAgentRulesForEditing } from "@/lib/agentRules";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { AgentRulesForm } from "./agent-rules-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agent rules" };

export default async function AgentRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: SearchParamValue }>;
}) {
  const raw = await searchParams;
  const saved = firstSearchParam(raw.saved);
  const rules = await readGlobalAgentRulesForEditing();

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
      <Card className="mt-6">
        <CardBody>
          <AgentRulesForm
            version={rules.version}
            initialState={{
              message: rules.directOutreachStorageError,
              values: {
                instructions: rules.instructions,
                directOutreachInstructions:
                  rules.directOutreachInstructions,
              },
              fieldErrors: {},
            }}
          />
        </CardBody>
      </Card>
    </main>
  );
}
