import { google, sheets_v4 } from "googleapis";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";

function loadGoogleCreds(): { client_email: string; private_key: string } {
  const jsonEnv = process.env.GOOGLE_CREDENTIALS_JSON;
  if (jsonEnv) return JSON.parse(jsonEnv);
  const path = process.env.GOOGLE_CREDENTIALS_PATH;
  if (path) return JSON.parse(readFileSync(path, "utf-8"));
  throw new Error("Missing GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH");
}

function getSheetsClient(): sheets_v4.Sheets {
  const creds = loadGoogleCreds();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    // Read+write — needed so manually-added contacts get appended back to the Sheet.
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function listTabs(): Promise<string[]> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Missing SPREADSHEET_ID");
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  return (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));
}

export type SheetRow = Record<string, string>;

export async function readTab(tabName: string): Promise<SheetRow[]> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Missing SPREADSHEET_ID");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
  });
  const values = (res.data.values ?? []) as string[][];
  if (values.length === 0) return [];
  const [header, ...rows] = values;
  const normHeader = header.map((h: string) => (h ?? "").trim().toLowerCase());
  return rows.map((row) => {
    const obj: SheetRow = {};
    normHeader.forEach((key: string, i: number) => {
      if (!key) return;
      obj[key] = (row[i] ?? "").trim();
    });
    return obj;
  });
}

export async function syncContactsFromSheet(tabName = "Artists"): Promise<{
  read: number;
  contactsUpserted: number;
  artistsCreated: number;
  skipped: number;
}> {
  const rows = await readTab(tabName);

  const result = { read: rows.length, contactsUpserted: 0, artistsCreated: 0, skipped: 0 };

  const fullTeamPattern = /full\s*teams?/i;

  for (const row of rows) {
    const artistName = (row.artist ?? row["artist name"] ?? "").trim();
    const emailRaw = (row.email ?? "").trim();
    const isFullTeam = fullTeamPattern.test(emailRaw);
    const cleanedEmail = emailRaw
      .replace(/full\s*teams?/gi, "")
      .replace(/[,;]\s*$/, "")
      .replace(/^\s*[,;]\s*/, "")
      .trim()
      .toLowerCase();
    const email = cleanedEmail;

    if (!artistName || !email) {
      result.skipped++;
      continue;
    }

    const normalized = normalizeArtistName(artistName);
    let artist = await db.artist.findFirst({ where: { normalizedName: normalized } });
    if (!artist) {
      artist = await db.artist.create({
        data: { name: artistName, normalizedName: normalized },
      });
      result.artistsCreated++;
    }

    const contactData = {
      name: row.manager_name || row["manager name"] || null,
      role: row.role || null,
      customPrice: row.price || row.rate || null,
      notes: row.notes || null,
      source: "sheet",
      isFullTeam,
    };
    await db.contact.upsert({
      where: { artistId_email: { artistId: artist.id, email } },
      create: { artistId: artist.id, email, ...contactData },
      update: contactData,
    });
    result.contactsUpserted++;
  }

  await db.setting.upsert({
    where: { key: "sheets_last_sync" },
    create: { key: "sheets_last_sync", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

  return result;
}

export interface AppendContactInput {
  artistName: string;
  email: string;
  managerName?: string | null;
  role?: string | null;
  customPrice?: string | null;
  notes?: string | null;
}

// Appends a new contact row to the Artists tab so the Sheet stays in sync
// with manual additions. Best-effort: caller should catch + log on failure.
export async function appendContactToSheet(
  data: AppendContactInput,
  tabName = "Artists"
): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Missing SPREADSHEET_ID");

  // Read header row to map our keys onto whatever columns the sheet has.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:ZZ1`,
  });
  const headerRaw = (headerRes.data.values?.[0] ?? []) as string[];
  if (headerRaw.length === 0) {
    throw new Error(`Sheet tab "${tabName}" has no header row`);
  }
  const header = headerRaw.map((h) => (h ?? "").trim().toLowerCase());

  const row: string[] = new Array(header.length).fill("");
  const setCol = (key: string, value: string | null | undefined) => {
    if (!value) return;
    const idx = header.indexOf(key);
    if (idx >= 0) row[idx] = value;
  };

  setCol("artist", data.artistName);
  setCol("artist name", data.artistName);
  setCol("manager_name", data.managerName ?? null);
  setCol("manager name", data.managerName ?? null);
  setCol("email", data.email);
  setCol("price", data.customPrice ?? null);
  setCol("rate", data.customPrice ?? null);
  setCol("role", data.role ?? null);
  setCol("notes", data.notes ?? null);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

