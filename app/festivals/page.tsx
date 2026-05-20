import { db } from "@/lib/db";
import { CardLink } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

type FestivalRow = Awaited<ReturnType<typeof loadFestivals>>[number];

async function loadFestivals() {
  return db.show.findMany({
    where: { isFestival: true, date: { gte: new Date() } },
    orderBy: { date: "asc" },
    include: {
      artists: {
        include: {
          artist: {
            include: {
              listenSignals: { take: 1, orderBy: { rank: "asc" } },
              contacts: { take: 1 },
            },
          },
        },
      },
    },
    take: 400,
  });
}

interface FestivalGroup {
  primary: FestivalRow;
  dates: Date[];
}

function groupFestivals(rows: FestivalRow[]): FestivalGroup[] {
  const groups = new Map<string, FestivalGroup>();
  for (const f of rows) {
    const key = `${(f.eventName ?? f.venueName).toLowerCase().trim()}|${f.venueName.toLowerCase().trim()}|${f.city.toLowerCase().trim()}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { primary: f, dates: [f.date] });
    } else {
      existing.dates.push(f.date);
      if (f.artists.length > existing.primary.artists.length) {
        existing.primary = f;
      }
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      Math.min(...a.dates.map((d) => d.getTime())) -
      Math.min(...b.dates.map((d) => d.getTime()))
  );
}

function dateRangeLabel(dates: Date[]): string {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
  if (sorted.length === 1) return fmt(first, true);
  if (first.getFullYear() === last.getFullYear()) {
    return `${fmt(first, false)} – ${fmt(last, true)}`;
  }
  return `${fmt(first, true)} – ${fmt(last, true)}`;
}

export default async function FestivalsPage() {
  const festivals = await loadFestivals();
  const allGroups = groupFestivals(festivals);
  const groups = allGroups.filter((g) => g.primary.artists.length > 0);
  const hiddenEmpty = allGroups.length - groups.length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Festivals</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {groups.length} upcoming
            {hiddenEmpty > 0 && ` · ${hiddenEmpty} empty-lineup hidden`}
          </p>
        </div>
        <LinkButton href="/festivals/new" variant="primary" size="sm">+ Add festival</LinkButton>
      </div>

      {groups.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No festivals yet. The next sync will populate this, or add one manually.
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(({ primary: f, dates }) => {
            const matched = f.artists.filter((sa) => sa.artist.listenSignals.length > 0).length;
            const withContact = f.artists.filter((sa) => sa.artist.contacts.length > 0).length;
            const headliners = f.artists.slice(0, 3).map((sa) => sa.artist.name);
            return (
              <CardLink key={f.id} href={`/festivals/${f.id}`} className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium leading-tight">{f.eventName || f.venueName}</p>
                  {f.source === "manual" && <Badge tone="muted" size="xs">manual</Badge>}
                </div>
                <p className="mt-1.5 text-xs text-zinc-500">
                  {dateRangeLabel(dates)}
                  {dates.length > 1 && (
                    <span className="ml-1 text-zinc-400">({dates.length}d)</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {f.venueName}
                  {f.state ? `, ${f.state}` : f.city ? `, ${f.city}` : ""}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone="default" size="xs">{f.artists.length} artists</Badge>
                  {matched > 0 && <Badge tone="success" size="xs">{matched} matched</Badge>}
                  {withContact > 0 && <Badge tone="info" size="xs">{withContact} contact</Badge>}
                </div>
                {headliners.length > 0 && (
                  <p className="mt-3 truncate text-xs text-zinc-500">
                    {headliners.join(", ")}
                    {f.artists.length > 3 ? ` +${f.artists.length - 3}` : ""}
                  </p>
                )}
              </CardLink>
            );
          })}
        </ul>
      )}
    </main>
  );
}
