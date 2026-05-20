// Edge-safe auth helpers. Uses Web Crypto so this works in both Node runtime
// (route handlers / server actions) and the Edge runtime (middleware).

export const SESSION_COOKIE = "admin_session";
const SESSION_SALT = "photo-admin-session-v1";

export async function expectedSessionHash(): Promise<string | null> {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(pw + ":" + SESSION_SALT));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function isAuthenticated(cookieValue: string | undefined): Promise<boolean> {
  const expected = await expectedSessionHash();
  if (expected === null) return true; // no password set → open mode
  if (!cookieValue) return false;
  return constantTimeEqual(cookieValue, expected);
}
