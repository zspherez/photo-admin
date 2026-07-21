import { constantTimeEqual } from "@/lib/auth";

export interface AgentMutationEnvironment {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
}

export interface AgentMutationAuthorizationOptions {
  environment?: AgentMutationEnvironment;
  staticSecrets?: string | readonly (string | undefined)[];
  verifyOidcToken: (token: string) => Promise<boolean>;
}

export function isProductionAgentEnvironment(
  environment: AgentMutationEnvironment = process.env
): boolean {
  return (
    environment.VERCEL_ENV === "production" ||
    environment.VERCEL_TARGET_ENV === "production" ||
    environment.NODE_ENV === "production"
  );
}

export async function isValidAgentMutationAuthorization(
  authorization: string | null,
  options: AgentMutationAuthorizationOptions
): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token) return false;

  if (await options.verifyOidcToken(token)) return true;
  if (isProductionAgentEnvironment(options.environment)) return false;

  const candidates = (
    Array.isArray(options.staticSecrets)
      ? options.staticSecrets
      : [options.staticSecrets]
  ).filter((secret): secret is string => Boolean(secret));
  const matches = await Promise.all(
    candidates.map((secret) => constantTimeEqual(token, secret))
  );
  return matches.some(Boolean);
}
