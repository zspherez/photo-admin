import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

export const dynamic = "force-dynamic";

async function createFestival(formData: FormData) {
  "use server";
  const name = ((formData.get("name") as string) ?? "").trim();
  const dateStr = ((formData.get("date") as string) ?? "").trim();
  const venueName = ((formData.get("venueName") as string) ?? "").trim();
  const city = ((formData.get("city") as string) ?? "").trim();
  const state = ((formData.get("state") as string) ?? "").trim();
  const lineupText = ((formData.get("lineup") as string) ?? "").trim();

  if (!name || !dateStr || !venueName || !city) {
    redirect("/festivals/new?error=missing_fields");
  }

  const date = new Date(dateStr + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) {
    redirect("/festivals/new?error=invalid_date");
  }

  const festival = await db.show.create({
    data: {
      date,
      venueName,
      city,
      state: state || null,
      isFestival: true,
      eventName: name,
      source: "manual",
    },
  });

  const lines = lineupText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const artistName of lines) {
    const normalized = normalizeArtistName(artistName);
    let artist = await db.artist.findFirst({ where: { normalizedName: normalized } });
    if (!artist) {
      artist = await db.artist.create({
        data: { name: artistName, normalizedName: normalized },
      });
    }
    await db.showArtist.upsert({
      where: { showId_artistId: { showId: festival.id, artistId: artist.id } },
      create: { showId: festival.id, artistId: artist.id, headliner: false },
      update: {},
    });
  }

  redirect(`/festivals/${festival.id}`);
}

export default async function NewFestivalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/festivals" className="text-sm text-blue-600 hover:underline">← Festivals</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Add festival</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        For festivals EDMTrain doesn&apos;t have yet, or where you have the lineup before they do. Lineup match is fuzzy-by-normalized-name against existing artists; unknowns get created.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error === "missing_fields"
            ? "Name, date, venue, and city are required."
            : error === "invalid_date"
            ? "Invalid date — use YYYY-MM-DD."
            : error}
        </div>
      )}

      <form action={createFestival} className="mt-6 space-y-4">
        <Field name="name" label="Festival name" placeholder="ARC Music Festival 2026" required />
        <div className="grid grid-cols-2 gap-3">
          <Field name="date" label="Date" type="date" required />
          <Field name="state" label="State (optional)" placeholder="IL" />
        </div>
        <Field name="venueName" label="Venue" placeholder="Union Park" required />
        <Field name="city" label="City" placeholder="Chicago" required />
        <div>
          <label htmlFor="lineup" className="text-sm font-medium">Lineup (one artist per line)</label>
          <textarea
            id="lineup"
            name="lineup"
            rows={12}
            placeholder={"Solomun\nAdam Beyer\nDixon\nAdriatique\n..."}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Each line becomes one artist linked to this festival. Existing artists match by normalized name; new ones get created. You can leave empty and add via /dashboard/add-contact for individual artists later.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
            Create festival
          </button>
          <Link href="/festivals" className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}

function Field({
  name,
  label,
  type = "text",
  placeholder,
  required,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </div>
  );
}
