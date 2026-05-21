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

  // Clean up any previously-bad rows: contacts whose email contains a comma
  // (left over from when the sync didn't split multi-email cells).
  await db.contact.deleteMany({ where: { email: { contains: "," } } });

  const fullTeamPattern = /full\s*teams?/i;

  for (const row of rows) {
    const artistName = (row.artist ?? row["artist name"] ?? "").trim();
    const emailRaw = (row.email ?? "").trim();
    const isFullTeam = fullTeamPattern.test(emailRaw);
    // Strip the "full teams" marker, then split by any common separator
    // (some cells are "manager@x.com, booking@x.com" or "a@x.com; b@x.com").
    const stripped = emailRaw.replace(/full\s*teams?/gi, "");
    const emails = Array.from(
      new Set(
        stripped
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes("@") && e.length >= 5)
      )
    );

    if (!artistName || emails.length === 0) {
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

    for (const email of emails) {
      await db.contact.upsert({
        where: { artistId_email: { artistId: artist.id, email } },
        create: { artistId: artist.id, email, ...contactData },
        update: contactData,
      });
      result.contactsUpserted++;
    }
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

function colNumToLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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

export interface UpdateContactInput {
  artistName: string;
  oldEmail: string;
  newEmail: string;
  managerName?: string | null;
  role?: string | null;
  customPrice?: string | null;
  notes?: string | null;
}

// Updates an existing row in the Artists tab. Finds the row by matching
// (artist name + old email) — old vs new because the user might be changing
// the email itself. If the row isn't found (e.g. contact was originally
// added manually and never appeared in the sheet), appends a fresh row.
export async function updateContactInSheet(
  data: UpdateContactInput,
  tabName = "Artists"
): Promise<{ updated: boolean; rowIndex: number | null }> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Missing SPREADSHEET_ID");

  const allRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
  });
  const values = (allRes.data.values ?? []) as string[][];
  if (values.length < 2) {
    // Just a header (or empty) — append instead
    await appendContactToSheet(
      {
        artistName: data.artistName,
        email: data.newEmail,
        managerName: data.managerName,
        role: data.role,
        customPrice: data.customPrice,
        notes: data.notes,
      },
      tabName
    );
    return { updated: false, rowIndex: null };
  }

  const [headerRaw, ...rows] = values;
  const header = headerRaw.map((h) => (h ?? "").trim().toLowerCase());
  const artistCol = header.findIndex((h) => h === "artist" || h === "artist name");
  const emailCol = header.indexOf("email");
  if (artistCol < 0 || emailCol < 0) {
    // Can't reliably locate — fall back to append
    await appendContactToSheet(
      {
        artistName: data.artistName,
        email: data.newEmail,
        managerName: data.managerName,
        role: data.role,
        customPrice: data.customPrice,
        notes: data.notes,
      },
      tabName
    );
    return { updated: false, rowIndex: null };
  }

  const targetArtist = data.artistName.trim().toLowerCase();
  const targetEmail = data.oldEmail.trim().toLowerCase();
  const matchIndex = rows.findIndex((r) => {
    const a = (r[artistCol] ?? "").trim().toLowerCase();
    const e = (r[emailCol] ?? "").trim().toLowerCase();
    return a === targetArtist && e === targetEmail;
  });

  if (matchIndex < 0) {
    // Not in sheet yet — append
    await appendContactToSheet(
      {
        artistName: data.artistName,
        email: data.newEmail,
        managerName: data.managerName,
        role: data.role,
        customPrice: data.customPrice,
        notes: data.notes,
      },
      tabName
    );
    return { updated: false, rowIndex: null };
  }

  const sheetRow = matchIndex + 2; // +1 for header, +1 for 1-indexed
  const existing = rows[matchIndex];
  // Pad to header length
  const updated = Array.from({ length: header.length }, (_, i) => existing[i] ?? "");

  const setCol = (key: string, value: string | null | undefined) => {
    if (value == null) return;
    const idx = header.indexOf(key);
    if (idx >= 0) updated[idx] = value;
  };

  setCol("email", data.newEmail);
  setCol("manager_name", data.managerName ?? "");
  setCol("manager name", data.managerName ?? "");
  setCol("price", data.customPrice ?? "");
  setCol("rate", data.customPrice ?? "");
  setCol("role", data.role ?? "");
  setCol("notes", data.notes ?? "");

  const endCol = colNumToLetter(header.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A${sheetRow}:${endCol}${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [updated] },
  });
  return { updated: true, rowIndex: sheetRow };
}

