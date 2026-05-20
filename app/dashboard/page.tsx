import { getMatchedShowsForClient } from "@/lib/match";
import { db } from "@/lib/db";
import { getTestOverride, getRateCardInfo } from "@/lib/resend";
import { cn } from "@/lib/cn";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

function Banner({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const toneClass: Record<typeof tone, string> = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  };
  return (
    <div className={cn("rounded-lg border px-4 py-2 text-sm", toneClass[tone])}>{children}</div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    sent?: string;
    error?: string;
    added?: string;
  }>;
}) {
  const sp = await searchParams;
  const testOverride = getTestOverride();
  const rateCard = getRateCardInfo();

  const [matched, totalUpcoming, totalSignals] = await Promise.all([
    getMatchedShowsForClient(),
    db.show.count({ where: { date: { gte: new Date() } } }),
    db.listenSignal.count(),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Matched shows</h1>

      <div className="mt-3 space-y-2">
        {testOverride && (
          <Banner tone="warning">
            Test override active — all sends go to <b>{testOverride}</b>. Subject prefixed with <code>[TEST → original]</code>.
          </Banner>
        )}
        {rateCard && !rateCard.exists && (
          <Banner tone="danger">
            <code>RATE_CARD_PATH</code> set to <code>{rateCard.source}</code> but the file doesn&apos;t exist. Sends will go without the attachment.
          </Banner>
        )}
        {rateCard && rateCard.exists && (
          <p className="text-xs text-zinc-500">
            Attaching <code>{rateCard.filename}</code> ({rateCard.kind === "url" ? "fetched per send" : "local file"}) to every send.
          </p>
        )}
        {sp.sent && <Banner tone="success">Email sent.</Banner>}
        {sp.added && <Banner tone="success">Contact saved.</Banner>}
        {sp.error && <Banner tone="danger">Send failed: {sp.error}</Banner>}
      </div>

      <DashboardClient shows={matched} totalUpcoming={totalUpcoming} totalSignals={totalSignals} />
    </main>
  );
}
