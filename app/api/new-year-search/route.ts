import { NextRequest, NextResponse } from "next/server";
import {
  authorizedNewYearWorker,
  claimNewYearSearchJob,
  finishNewYearSearchJob,
} from "@/lib/newYearSearch";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  if (!(await authorizedNewYearWorker(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || typeof body.batchId !== "string" ||
      !/^[a-z0-9]{10,40}$/.test(body.batchId)) {
      return NextResponse.json({ error: "invalid batch" }, { status: 400 });
    }
    if (body.action === "claim") {
      return NextResponse.json(await claimNewYearSearchJob(body.batchId));
    }
    if (body.action === "finish" &&
      typeof body.jobId === "string" && typeof body.claimToken === "string" &&
      Array.isArray(body.rows) && body.rows.length <= 12 &&
      (body.error === undefined || typeof body.error === "string")) {
      await finishNewYearSearchJob(
        body.batchId, body.jobId, body.claimToken, body.rows, body.error
      );
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  } catch (error) {
    console.error("New Year worker request failed", error);
    return NextResponse.json({ error: "worker request failed" }, { status: 500 });
  }
}
