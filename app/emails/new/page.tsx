import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import {
  formatNextDispatchActionLabel,
  getNextNormalOutreachDispatch,
} from "@/lib/schedule";
import { ComposeEmailForm } from "./compose-email-form";

export const metadata: Metadata = { title: "Compose email" };

export default function ComposeEmailPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compose email</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Paste rich content or HTML; it is normalized for valid email HTML and
            a matching plain-text alternative before sending.
          </p>
        </div>
        <Link href="/emails" className="text-sm text-zinc-500 hover:text-zinc-900">
          Back to emails
        </Link>
      </div>

      <Card className="mt-6">
        <CardBody>
          <ComposeEmailForm
            compositionId={randomUUID()}
            queueLabel={formatNextDispatchActionLabel(
              getNextNormalOutreachDispatch(),
            )}
          />
        </CardBody>
      </Card>
    </main>
  );
}
