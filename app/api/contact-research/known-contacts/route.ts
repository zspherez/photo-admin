import { NextRequest, NextResponse } from "next/server";
import {
  findKnownContactEmails,
  isValidContactResearchAuthorization,
  parseKnownContactLookup,
} from "@/lib/contactResearch";

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactResearchAuthorization(
      request.headers.get("authorization")
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

  let lookup;
  try {
    lookup = parseKnownContactLookup(value);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await findKnownContactEmails(lookup));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "contact_research_known_contacts_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to search known contacts" },
      { status: 500 }
    );
  }
}
