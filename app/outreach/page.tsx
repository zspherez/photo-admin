import Link from "next/link";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { ArtistLink } from "@/components/artist-modal";
import { cn } from "@/lib/cn";
import { formatShowDate } from "@/lib/formatDate";

export const dynamic = "force-dynamic";

type StatusFilter = "all" | "sent" | "delivered" | "opened" | "clicked" | "test" | "failed";

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "opened", label: "Opened" },
  { key: "clicked", label: "Clicked" },
  { key: "test", label: "Test" },
  { key: "failed", label: "Failed" },
];

interface OutreachLike {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

function statusLabels(o: OutreachLike): string[] {
  if (o.status === "failed") return ["Failed"];
  if (o.status === "queued") return ["Queued"];
  const labels: string[] = [];
  if (o.status === "test") labels.push("Test sent");
  else if (o.sentAt) labels.push("Sent");
  if (o.deliveredAt) labels.push("Delivered");
  if (o.openCount > 0) labels.push(o.openCount > 1 ? `Opened (${o.openCount})` : "Opened");
  if (o.clickCount > 0) labels.push(o.clickCount > 1 ? `Clicked (${o.clickCount})` : "Clicked");
  return labels.length > 0 ? labels : [o.status];
}

function statusTone(o: OutreachLike): BadgeTone {
  if (o.status === "failed") return "danger";
  if (o.clickCount > 0) return "info";
  if (o.openCount > 0) return "info";
  if (o.deliveredAt) return "success";
  if (o.status === "test") return "warning";
  return "default";
}

function buildWhere(status: StatusFilter, search: string) {
  const where: Record<string, unknown> = {};
  if (status === "sent") where.status = "sent";
  else if (status === "test") where.status = "test";
  else if (status === "failed") where.status = "failed";
  else if (status === "delivered") where.deliveredAt = { not: null };
  else if (status === "opened") where.openCount = { gt: 0 };
  else if (status === "clicked") where.clickCount = { gt: 0 };
  if (search) {
    where.contact = { artist: { name: { contains: search, mode: "insensitive" } } };
  }
  return where;
}

export default async function OutreachLogPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const sp = await searchParams;
  const status = (STATUS_OPTIONS.find((s) => s.key === sp.status)?.key ?? "all") as StatusFilter;
  const search = (sp.search ?? "").trim();

  const where = buildWhere(status, search);

  const [outreach, totalAll, totalSent, totalDelivered, totalOpened, totalClicked, totalFailed] = await Promise.all([
    db.outreach.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        show: true,
        contact: { include: { artist: true } },
      },
    }),
    db.outreach.count(),
    db.outreach.count({ where: { status: "sent" } }),
    db.outreach.count({ where: { deliveredAt: { not: null } } }),
    db.outreach.count({ where: { openCount: { gt: 0 } } }),
    db.outreach.count({ where: { clickCount: { gt: 0 } } }),
    db.outreach.count({ where: { status: "failed" } }),
  ]);

  const stats = [
    { label: "Total", value: totalAll },
    { label: "Sent", value: totalSent },
    { label: "Delivered", value: totalDelivered },
    { label: "Opened", value: totalOpened },
    { label: "Clicked", value: totalClicked },
    { label: "Failed", value: totalFailed },
  ];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Outreach log</h1>
      <p className="mt-1 text-sm text-zinc-500">Every send, in order, with delivery + engagement status.</p>

      <div className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label}>
            <div className="p-3">
              <div className="text-2xl font-semibold">{s.value.toLocaleString()}</div>
              <div className="text-xs text-zinc-500">{s.label}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-6 p-3">
        <form className="flex gap-2" action="/outreach" method="get">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search by artist name…"
            className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            Search
          </button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Status</span>
          {STATUS_OPTIONS.map((opt) => {
            const params = new URLSearchParams();
            if (opt.key !== "all") params.set("status", opt.key);
            if (search) params.set("search", search);
            const qs = params.toString();
            return (
              <Link
                key={opt.key}
                href={qs ? `/outreach?${qs}` : "/outreach"}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                  status === opt.key
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                )}
              >
                {opt.label}
              </Link>
            );
          })}
        </div>
      </Card>

      {outreach.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {totalAll === 0 ? "No outreach yet. Send your first one from the dashboard." : "No outreach matches this filter."}
        </div>
      ) : (
        <Card className="mt-6">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {outreach.map((o) => {
              const sentDate = o.sentAt ?? o.createdAt;
              const showHref = o.show.isFestival ? `/festivals/${o.show.id}` : "/dashboard";
              return (
                <li key={o.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ArtistLink artistId={o.contact.artistId} className="text-sm font-medium">
                          {o.contact.artist.name}
                        </ArtistLink>
                        <Badge tone={statusTone(o)}>{statusLabels(o).join(" · ")}</Badge>
                        {o.show.isFestival && <Badge tone="accent" size="xs">Festival</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">
                        <Link href={showHref} className="hover:underline">
                          {o.show.eventName || o.show.venueName}
                          {" · "}
                          {formatShowDate(o.show.date, { month: "short", day: "numeric", year: "numeric" })}
                        </Link>
                        {" · "}
                        <Link href={`/dashboard/contact/${o.contactId}`} className="hover:underline">
                          {o.contact.name ? `${o.contact.name} <${o.contact.email}>` : o.contact.email}
                        </Link>
                      </p>
                      {o.error && (
                        <p className="mt-0.5 truncate text-xs text-red-700 dark:text-red-400">
                          Error: {o.error}
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 text-xs text-zinc-400">
                      {sentDate.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </main>
  );
}
