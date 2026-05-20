import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";

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
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/festivals" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Festivals</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add festival</h1>
      <p className="mt-1 text-sm text-zinc-500">
        For festivals EDMTrain doesn&apos;t have yet, or where you have the lineup before they do.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error === "missing_fields"
            ? "Name, date, venue, and city are required."
            : error === "invalid_date"
            ? "Invalid date — use YYYY-MM-DD."
            : error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={createFestival} className="space-y-4">
            <Field name="name" label="Festival name" placeholder="ARC Music Festival 2026" required />
            <div className="grid grid-cols-2 gap-3">
              <Field name="date" label="Date" type="date" required />
              <Field name="state" label="State" placeholder="IL" />
            </div>
            <Field name="venueName" label="Venue" placeholder="Union Park" required />
            <Field name="city" label="City" placeholder="Chicago" required />
            <TextArea
              name="lineup"
              label="Lineup"
              description="One artist per line. Existing artists match by normalized name; new ones get created."
              rows={12}
              placeholder={"Solomun\nAdam Beyer\nDixon\nAdriatique\n..."}
              mono
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Create festival</Button>
              <LinkButton href="/festivals" variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
