import type { Metadata } from "next";
import Link from "next/link";
import { TemplateEditor } from "@/components/template-editor";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { sendArbitraryEmailAction } from "@/app/emails/actions";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";

export const metadata: Metadata = { title: "Compose email" };

export default async function ComposeEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: SearchParamValue }>;
}) {
  const error = firstSearchParam((await searchParams).error);

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

      {error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={sendArbitraryEmailAction} className="space-y-6">
            <div>
              <label htmlFor="recipients" className="text-sm font-medium">
                Recipients
              </label>
              <textarea
                id="recipients"
                name="recipients"
                required
                rows={2}
                placeholder="person@example.com, another@example.com"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Separate up to 50 addresses with commas, semicolons, or new lines.
              </p>
            </div>

            <TemplateEditor
              initialSubject=""
              initialHtml="<p></p>"
              variables={[]}
              previewNormalization="arbitrary-email"
            />
            <p className="-mt-4 text-xs text-zinc-500">
              Normalization avoids malformed MIME/HTML and improves mail-client
              compatibility. Inbox placement also depends on DNS authentication,
              sender reputation, content, and sending behavior. Paste rendered
              content or decoded HTML, not quoted-printable message source. Only
              safe web, email, and phone links and visible absolute web images
              are retained; unsafe schemes and hidden tracking pixels are removed.
            </p>

            <fieldset>
              <legend className="text-sm font-medium">UTM tags</legend>
              <p className="mt-1 text-xs text-zinc-500">
                Non-empty values are added to every HTTP or HTTPS link unless that
                link already specifies the same tag.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {[
                  ["utm_source", "Source", "photo_admin"],
                  ["utm_medium", "Medium", "email"],
                  ["utm_campaign", "Campaign", ""],
                  ["utm_content", "Content", ""],
                  ["utm_term", "Term", ""],
                ].map(([name, label, defaultValue]) => (
                  <label key={name} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {label}
                    <input
                      name={name}
                      defaultValue={defaultValue}
                      maxLength={200}
                      className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex justify-end">
              <Button type="submit">Send email</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
