import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  decodeFestivalContactImportPayload,
  parseFestivalContactCsv,
  planFestivalContactImport,
} from "./festivalContactImport";

const HEADER =
  "festival,festival_dates,day,name,contact_email,source,source_url,worked_with_before,confidence,notes,status";

test("festival contact CSV parser handles quoted commas and gzip payloads", () => {
  const csv = `${HEADER}\nFestival,Aug 1,Fri,Artist,manager@example.com,Website,https://example.com,N,high,\"Manager, official\",\n`;
  assert.equal(parseFestivalContactCsv(csv)[0].notes, "Manager, official");
  assert.equal(
    decodeFestivalContactImportPayload({
      gzipBase64: gzipSync(Buffer.from(csv)).toString("base64"),
    }),
    csv,
  );
});

test("festival contact import skips exact matches and plans new/conflicting candidates", () => {
  const rows = parseFestivalContactCsv(
    [
      HEADER,
      "Festival,Aug 1,Fri,Artist,existing@example.com,Website,https://example.com,N,high,Exact,",
      "Festival,Aug 1,Fri,Artist,new@example.com,Website,https://example.com,N,medium,New,",
      "Festival,Aug 1,Fri,Unknown,unknown@example.com,Website,https://example.com,N,high,Unknown,",
      "Festival,Aug 1,Fri,Artist,,none-found,,N,none-found,None,",
    ].join("\n"),
  );
  const plan = planFestivalContactImport(
    rows,
    [
      {
        id: "artist-1",
        name: "Artist",
        customName: null,
        normalizedName: "artist",
        activeSkip: false,
        contacts: [
          { email: "existing@example.com", state: "active" },
        ],
        job: null,
      },
    ],
    true,
  );
  assert.equal(plan.summary.exactActiveMatches, 1);
  assert.equal(plan.summary.createdCandidates, 1);
  assert.equal(plan.summary.unmatchedArtists, 1);
  assert.equal(plan.summary.rowsWithoutEmail, 1);
  assert.equal(plan.candidates[0].normalizedEmail, "new@example.com");
});

test("festival contact import respects intentional skips and prior candidate decisions", () => {
  const rows = parseFestivalContactCsv(
    `${HEADER}\nFestival,Aug 1,Fri,Artist,manager@example.com,Website,https://example.com,N,high,Imported,\n`,
  );
  const skipped = planFestivalContactImport(
    rows,
    [
      {
        id: "artist-1",
        name: "Artist",
        customName: null,
        normalizedName: "artist",
        activeSkip: true,
        contacts: [],
        job: null,
      },
    ],
    false,
  );
  assert.equal(skipped.summary.intentionallySkippedArtists, 1);

  const csvSkipped = planFestivalContactImport(
    parseFestivalContactCsv(
      `${HEADER}\nFestival,Aug 1,Fri,Artist,manager@example.com,Website,https://example.com,N,high,Imported,intentional-skip\n`,
    ),
    [
      {
        id: "artist-1",
        name: "Artist",
        customName: null,
        normalizedName: "artist",
        activeSkip: false,
        contacts: [],
        job: null,
      },
    ],
    false,
  );
  assert.equal(csvSkipped.summary.intentionallySkippedArtists, 1);
  assert.equal(csvSkipped.summary.createdCandidates, 0);

  const reviewed = planFestivalContactImport(
    rows,
    [
      {
        id: "artist-1",
        name: "Artist",
        customName: null,
        normalizedName: "artist",
        activeSkip: false,
        contacts: [],
        job: {
          id: "job-1",
          status: "complete",
          candidates: [
            { normalizedEmail: "manager@example.com", status: "rejected" },
          ],
        },
      },
    ],
    false,
  );
  assert.equal(reviewed.summary.existingCandidates, 1);
  assert.equal(reviewed.summary.createdCandidates, 0);
});
