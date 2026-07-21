import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDashboardData } from "@/lib/match";
import {
  buildDashboardHref,
  dashboardHrefWithoutLegacyPage,
  firstSearchParam,
  parseDashboardQuery,
} from "@/lib/dashboardQuery";
import { getTestOverride } from "@/lib/resend";
import { isWeekendET } from "@/lib/schedule";
import { cn } from "@/lib/cn";
import { getDashboardInteractionState } from "@/lib/dashboardInteractionState";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
} from "@/lib/auth";
import { dashboardSessionIdentity } from "@/lib/dashboardSession";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Matched shows" };

function Banner({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const toneClass: Record<typeof tone, string> = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    success:
      "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warning:
      "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    danger:
      "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  };
  return (
    <div className={cn("rounded-lg border px-4 py-2 text-sm", toneClass[tone])}>
      {children}
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const legacyPageRedirect = dashboardHrefWithoutLegacyPage(params);
  if (legacyPageRedirect) redirect(legacyPageRedirect);
  const query = parseDashboardQuery(params);
  const sent = firstSearchParam(params.sent);
  const error = firstSearchParam(params.error);
  const added = firstSearchParam(params.added);
  const updated = firstSearchParam(params.updated);
  const deleted = firstSearchParam(params.deleted);
  const sheetErrors = firstSearchParam(params.sheet_errors);
  const marked = firstSearchParam(params.marked);
  const unmarked = firstSearchParam(params.unmarked);
  const scheduled = firstSearchParam(params.scheduled);
  const cancelled = firstSearchParam(params.cancelled);
  const followUpSent = firstSearchParam(params.followup_sent);
  const followUpScheduled = firstSearchParam(params.followup_scheduled);
  const now = new Date();
  const configuration = getAuthConfiguration();
  const cookieValue = (await cookies()).get(SESSION_COOKIE)?.value;
  const { ownerKey, persistenceScope } = dashboardSessionIdentity(
    cookieValue,
    configuration
  );
  const [testOverride, dashboard] = await Promise.all([
    getTestOverride(),
    getDashboardData(query, ownerKey, now),
  ]);

  const interactionState = await getDashboardInteractionState(
    dashboard.shows,
    now
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Matched shows</h1>

      <div className="mt-3 space-y-2">
        {testOverride && (
          <Banner tone="warning">
            Test override active — all sends go to <b>{testOverride}</b>. Subject
            prefixed with <code>[TEST → original]</code>.
          </Banner>
        )}
        {sent && <Banner tone="success">Email sent.</Banner>}
        {scheduled && (
          <Banner tone="success">
            Email scheduled for Monday morning (9–10 AM ET). You can cancel it
            from the listing.
          </Banner>
        )}
        {cancelled && (
          <Banner tone="success">
            Scheduled send, follow-up, or retry cancelled.
          </Banner>
        )}
        {followUpSent && <Banner tone="success">Follow-up sent.</Banner>}
        {followUpScheduled && (
          <Banner tone="success">
            Follow-up scheduled for Monday morning.
          </Banner>
        )}
        {marked && <Banner tone="success">Marked as sent.</Banner>}
        {unmarked && <Banner tone="success">Manual mark removed.</Banner>}
        {added && (
          <Banner tone="success">
            {added === "0" && updated
              ? `${updated} contact${Number(updated) === 1 ? "" : "s"} updated.`
              : updated
                ? `${added} added, ${updated} updated.`
                : `${added} contact${Number(added) === 1 ? "" : "s"} added.`}
          </Banner>
        )}
        {deleted && <Banner tone="success">Contact deleted.</Banner>}
        {sheetErrors && (
          <Banner tone="warning">
            DB updated; sheet sync had errors: {sheetErrors}
          </Banner>
        )}
        {error && <Banner tone="danger">Action failed: {error}</Banner>}
      </div>

      <DashboardClient
        key={`${persistenceScope}:${buildDashboardHref(query)}`}
        data={dashboard}
        query={query}
        persistenceScope={persistenceScope}
        isWeekend={isWeekendET(now)}
        {...interactionState}
      />
    </main>
  );
}
