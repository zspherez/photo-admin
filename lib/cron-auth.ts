import { constantTimeEqual } from "@/lib/auth";

export async function isValidCronAuthorization(
  authorization: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): Promise<boolean> {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;

  const token = authorization.slice("Bearer ".length);
  if (!token) return false;

  return constantTimeEqual(token, secret);
}
