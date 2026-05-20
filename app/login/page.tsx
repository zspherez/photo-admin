import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, expectedSessionHash, constantTimeEqual } from "@/lib/auth";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const password = ((formData.get("password") as string) ?? "").trim();
  const next = ((formData.get("next") as string) ?? "/").trim() || "/";
  const expected = await expectedSessionHash();
  if (expected === null) redirect(next);

  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(password + ":photo-admin-session-v1"));
  const submitted = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!constantTimeEqual(submitted, expected)) {
    redirect(`/login?error=invalid${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  redirect(next);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const pwSet = !!process.env.ADMIN_PASSWORD;
  return (
    <main className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-md flex-col items-center justify-center px-6">
      <div className="mb-8 flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-sm bg-zinc-900 dark:bg-zinc-100" />
        <h1 className="text-2xl font-semibold tracking-tight">photo-admin</h1>
      </div>
      <Card className="w-full">
        <CardBody>
          <h2 className="text-sm font-medium">Sign in</h2>
          <p className="mt-1 text-xs text-zinc-500">Enter the admin password to continue.</p>

          {!pwSet && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <code>ADMIN_PASSWORD</code> not set — auth is disabled.
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Incorrect password.
            </div>
          )}

          <form action={login} className="mt-4 space-y-3">
            <input type="hidden" name="next" value={next ?? "/"} />
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              placeholder="Password"
              className="block h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <Button type="submit" variant="primary" size="md" className="w-full">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
