import { NextRequest, NextResponse } from "next/server";
import {
  decodeFestivalContactImportPayload,
  FestivalContactImportError,
  importFestivalContactsCsv,
} from "@/lib/festivalContactImport";
import { isValidContactResearchAuthorization } from "@/lib/contactResearch";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactResearchAuthorization(
      request.headers.get("authorization"),
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  let csv: string;
  let dryRun: boolean;
  try {
    csv = decodeFestivalContactImportPayload(value);
    dryRun =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { dryRun?: unknown }).dryRun === true;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof FestivalContactImportError
            ? error.message
            : "invalid import payload",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await importFestivalContactsCsv(csv, dryRun));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "festival_contact_import_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      {
        error:
          error instanceof FestivalContactImportError
            ? error.message
            : "unable to import festival contacts",
      },
      {
        status: error instanceof FestivalContactImportError ? 400 : 500,
      },
    );
  }
}
