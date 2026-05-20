import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { db } from "@/lib/db";

interface ResendEvent {
  type: string;
  created_at: string;
  data: {
    created_at?: string;
    email_id?: string;
    // Resend webhook payloads send tags as { key: value }, but the SDK accepts
    // [{ name, value }]. Accept either to be safe.
    tags?: Record<string, string> | { name: string; value: string }[];
    headers?: { name: string; value: string }[];
    click?: { link?: string; timestamp?: string };
  };
}

function findOutreachId(evt: ResendEvent): string | null {
  const tags = evt.data.tags;
  if (tags) {
    if (Array.isArray(tags)) {
      const tag = tags.find((t) => t.name === "outreach_id");
      if (tag?.value) return tag.value;
    } else if (typeof tags === "object" && tags.outreach_id) {
      return tags.outreach_id;
    }
  }
  const hdr = evt.data.headers?.find(
    (h) => h.name.toLowerCase() === "x-outreach-id"
  );
  return hdr?.value ?? null;
}

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const raw = await request.text();

  try {
    let parsed: ResendEvent;

    if (secret) {
      try {
        const wh = new Webhook(secret);
        const headers = {
          "svix-id": request.headers.get("svix-id") ?? "",
          "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
          "svix-signature": request.headers.get("svix-signature") ?? "",
        };
        parsed = wh.verify(raw, headers) as ResendEvent;
      } catch (e) {
        console.error("[resend webhook] signature verification failed", e);
        return NextResponse.json(
          { error: "invalid signature", detail: e instanceof Error ? e.message : String(e) },
          { status: 401 }
        );
      }
    } else {
      parsed = JSON.parse(raw) as ResendEvent;
    }

    const outreachId = findOutreachId(parsed);
    const messageId = parsed.data.email_id ?? null;

    const outreach = outreachId
      ? await db.outreach.findUnique({ where: { id: outreachId } })
      : messageId
      ? await db.outreach.findFirst({ where: { providerMessageId: messageId } })
      : null;

    if (!outreach) {
      console.warn(
        `[resend webhook] no matching outreach (type=${parsed.type}, outreachId=${outreachId}, messageId=${messageId})`
      );
      return NextResponse.json({ ok: true, note: "no matching outreach" });
    }

    const now = new Date();
    let update: Record<string, unknown> = {};

    switch (parsed.type) {
      case "email.sent":
        update = { providerMessageId: messageId ?? outreach.providerMessageId };
        break;
      case "email.delivered":
        update = { deliveredAt: now };
        break;
      case "email.opened":
        update = {
          firstOpenedAt: outreach.firstOpenedAt ?? now,
          lastOpenedAt: now,
          openCount: { increment: 1 },
        };
        break;
      case "email.clicked":
        update = {
          firstClickedAt: outreach.firstClickedAt ?? now,
          lastClickedAt: now,
          clickCount: { increment: 1 },
        };
        break;
      case "email.bounced":
        update = { bouncedAt: now, status: "failed", error: "bounced" };
        break;
      case "email.complained":
        update = { complainedAt: now };
        break;
      case "email.delivery_delayed":
      case "email.failed":
        update = { status: "failed", error: parsed.type };
        break;
      default:
        return NextResponse.json({ ok: true, note: `unhandled type: ${parsed.type}` });
    }

    await db.outreach.update({ where: { id: outreach.id }, data: update });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[resend webhook] unhandled error", e);
    return NextResponse.json(
      { error: "handler error", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Resend webhook — POST events here" });
}
