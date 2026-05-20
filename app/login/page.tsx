import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, expectedSessionHash, constantTimeEqual } from "@/lib/auth";

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
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">photo-admin</h1>
      <p className="mt-2 text-sm text-zinc-500">Sign in to continue.</p>

      {!pwSet && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <code>ADMIN_PASSWORD</code> is not set. Auth is currently disabled; anyone hitting this URL gets in.
        </div>
      )}
      {error && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Incorrect password.
        </div>
      )}

      <form action={login} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={next ?? "/"} />
        <div>
          <label htmlFor="password" className="text-sm font-medium">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
