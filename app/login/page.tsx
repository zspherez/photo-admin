import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  constantTimeEqual,
  createSessionToken,
  getAuthConfiguration,
  sanitizeNextPath,
} from "@/lib/auth";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { appConfig } from "@/lib/appConfig";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

async function login(formData: FormData) {
  "use server";
  const submittedPassword = formData.get("password");
  const password = typeof submittedPassword === "string" ? submittedPassword : "";
  const next = sanitizeNextPath(formData.get("next"));
  const configuration = getAuthConfiguration();
  if (configuration.mode === "open") redirect(next);
  if (configuration.mode === "misconfigured") {
    redirect(`/login?error=config&next=${encodeURIComponent(next)}`);
  }

  const adminPassword = process.env.ADMIN_PASSWORD!;
  const readOnlyPassword = process.env.READ_ONLY_PASSWORD;
  const [adminMatch, readOnlyMatch] = await Promise.all([
    constantTimeEqual(password, adminPassword),
    constantTimeEqual(
      password,
      readOnlyPassword ?? "photo-admin-disabled-read-only-password",
    ),
  ]);
  const access = adminMatch
    ? "admin"
    : readOnlyPassword && readOnlyMatch
      ? "read_only"
      : null;
  if (!access) {
    redirect(`/login?error=invalid${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  const sessionToken = await createSessionToken(
    process.env.ADMIN_SESSION_SECRET,
    access === "admin" ? adminPassword : readOnlyPassword,
    Date.now(),
    access,
  );
  if (!sessionToken) {
    redirect(`/login?error=config&next=${encodeURIComponent(next)}`);
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  redirect(next);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const next = firstSearchParam(rawSearchParams.next);
  const error = firstSearchParam(rawSearchParams.error);
  const safeNext = sanitizeNextPath(next);
  const configuration = getAuthConfiguration();
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center px-6">
      <div className="mb-8 flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-sm bg-zinc-900 dark:bg-zinc-100" />
        <h1 className="text-2xl font-semibold tracking-tight">{appConfig.repository.name}</h1>
      </div>
      <Card className="w-full">
        <CardBody>
          <h2 className="text-sm font-medium">Sign in</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {configuration.mode === "protected"
              ? configuration.readOnlyEnabled
                ? "Enter the admin or read-only password to continue."
                : "Enter the admin password to continue."
              : "Authentication status for this environment."}
          </p>

          {configuration.mode === "open" && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Explicit local open mode is active. No password is required.
            </div>
          )}
          {configuration.mode === "misconfigured" && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              {configuration.error}
            </div>
          )}
          {error === "invalid" && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Incorrect password.
            </div>
          )}
          {error === "config" && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Authentication is not fully configured.
            </div>
          )}

          {configuration.mode === "protected" && (
            <form action={login} className="mt-4 space-y-3">
              <input type="hidden" name="next" value={safeNext} />
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                placeholder="Password"
                className="block min-h-11 w-full rounded-md border border-zinc-200 bg-white px-3 text-base placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none sm:min-h-9 sm:text-sm dark:border-zinc-800 dark:bg-zinc-950"
              />
              <Button type="submit" variant="primary" size="md" className="w-full">
                Sign in
              </Button>
            </form>
          )}
          {configuration.mode === "open" && (
            <Link
              href={safeNext}
              className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 sm:min-h-9 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              Continue
            </Link>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
