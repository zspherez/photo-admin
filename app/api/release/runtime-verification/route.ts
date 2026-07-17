import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  RELEASE_RUNTIME_APP_BASE_URL_HEADER,
  RELEASE_RUNTIME_SHA_HEADER,
  RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
  resolveReleaseRuntimeVerificationRequest,
} from "@/lib/releaseRuntimeVerification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const result = await resolveReleaseRuntimeVerificationRequest(
    {
      authorization: request.headers.get("authorization"),
      expectedAppBaseUrl: request.headers.get(
        RELEASE_RUNTIME_APP_BASE_URL_HEADER
      ),
      expectedReleaseSha: request.headers.get(RELEASE_RUNTIME_SHA_HEADER),
    },
    {
      cronSecret: process.env.CRON_SECRET,
      configuredAppBaseUrl: process.env.APP_BASE_URL,
      readMarkerValue: async () => {
        const setting = await db.setting.findUnique({
          where: { key: RELEASE_RUNTIME_VERIFICATION_SETTING_KEY },
          select: { value: true },
        });
        return setting?.value ?? null;
      },
    }
  );

  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}
