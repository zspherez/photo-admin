import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

const EDMTRAIN_BASE = "https://edmtrain.com/api/events";
const NYC_LOCATION_ID = 38;
const DEFAULT_VENUE_BLOCKLIST = ["montauk", "surf lodge"];

export interface EdmtrainArtist {
  id: number;
  name: string;
  b2bInd: boolean;
  link: string | null;
}

export interface EdmtrainEvent {
  id: number;
  date: string;
  ages: string | null;
  electronicGenreInd: boolean;
  festivalInd: boolean;
  livestreamInd: boolean;
  name: string | null;
  link: string | null;
  startTime: string | null;
  endTime: string | null;
  createdDate: string;
  artistList: EdmtrainArtist[];
  venue: {
    id: number;
    name: string;
    location: string;
    state: string;
    address: string;
    country: string;
    latitude: number;
    longitude: number;
  };
}

export async function fetchEdmtrainEvents(daysAhead = 90): Promise<EdmtrainEvent[]> {
  const apiKey = process.env.EDMTRAIN_API_KEY;
  if (!apiKey) throw new Error("Missing EDMTRAIN_API_KEY");
  const today = new Date();
  const end = new Date(today.getTime() + daysAhead * 86400_000);
  const params = new URLSearchParams({
    locationIds: String(NYC_LOCATION_ID),
    client: apiKey,
    startDate: today.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });
  const res = await fetch(`${EDMTRAIN_BASE}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`EDMTrain ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { success: boolean; data: EdmtrainEvent[] };
  return json.data ?? [];
}

export async function getVenueBlocklist(): Promise<string[]> {
  const setting = await db.setting.findUnique({ where: { key: "venue_blocklist" } });
  const raw = setting?.value ?? DEFAULT_VENUE_BLOCKLIST.join(",");
  return raw
    .split(",")
    .map((v: string) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function isBlocked(venueName: string, blocklist: string[]): boolean {
  const lower = venueName.toLowerCase();
  return blocklist.some((term) => lower.includes(term));
}

async function upsertArtistByEdmtrain(a: EdmtrainArtist) {
  const normalized = normalizeArtistName(a.name);
  const existing = await db.artist.findFirst({
    where: { OR: [{ edmtrainId: a.id }, { normalizedName: normalized }] },
  });
  if (!existing) {
    return db.artist.create({
      data: { edmtrainId: a.id, name: a.name, normalizedName: normalized },
    });
  }
  if (existing.edmtrainId == null) {
    return db.artist.update({ where: { id: existing.id }, data: { edmtrainId: a.id } });
  }
  return existing;
}

export interface SyncResult {
  fetched: number;
  upserted: number;
  skippedVenue: number;
  artistsLinked: number;
}

export async function syncEdmtrainShows(daysAhead = 90): Promise<SyncResult> {
  const [events, blocklist] = await Promise.all([
    fetchEdmtrainEvents(daysAhead),
    getVenueBlocklist(),
  ]);

  let upserted = 0;
  let skippedVenue = 0;
  let artistsLinked = 0;

  for (const evt of events) {
    if (isBlocked(evt.venue.name, blocklist)) {
      skippedVenue++;
      continue;
    }
    const locParts = (evt.venue.location ?? "").split(",").map((s) => s.trim());
    const city = locParts[0] ?? "Unknown";
    const state = locParts[1] ?? evt.venue.state ?? null;

    const showData = {
      date: new Date(evt.date + "T00:00:00Z"),
      venueName: evt.venue.name,
      city,
      state,
      ticketUrl: evt.link,
      ages: evt.ages,
      electronicGenre: evt.electronicGenreInd ? "electronic" : "other",
      raw: JSON.stringify(evt),
    };
    const show = await db.show.upsert({
      where: { edmtrainId: evt.id },
      create: { edmtrainId: evt.id, ...showData },
      update: showData,
    });
    upserted++;

    for (const a of evt.artistList ?? []) {
      const artist = await upsertArtistByEdmtrain(a);
      await db.showArtist.upsert({
        where: { showId_artistId: { showId: show.id, artistId: artist.id } },
        create: { showId: show.id, artistId: artist.id, headliner: false },
        update: {},
      });
      artistsLinked++;
    }
  }

  await db.setting.upsert({
    where: { key: "edmtrain_last_sync" },
    create: { key: "edmtrain_last_sync", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

  return { fetched: events.length, upserted, skippedVenue, artistsLinked };
}
