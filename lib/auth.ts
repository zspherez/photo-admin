// Core token helpers use Web Crypto across server runtimes. The Server Action
// guard lazily imports request APIs so Proxy can reuse the same module.

export const SESSION_COOKIE = "admin_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const SESSION_VERSION = "v3";
const PASSWORD_VERSION_CONTEXT = "photo-admin/password-version/v2";
const SESSION_KEY_CONTEXT = "photo-admin/session-signing-key/v3";
const SESSION_NONCE_BYTES = 16;
const MAX_SESSION_TOKEN_LENGTH = 2048;
const MAX_CLOCK_SKEW_SECONDS = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type SessionPayload = {
  iat: number;
  exp: number;
  nonce: string;
  access: SessionAccess;
};

export type SessionAccess = "admin" | "read_only";

export type AuthConfiguration =
  | { mode: "protected"; readOnlyEnabled: boolean }
  | { mode: "open" }
  | { mode: "misconfigured"; error: string };

export interface AuthEnvironment {
  nodeEnv?: string;
  allowInsecureOpenMode?: string;
}

export function getAuthConfiguration(
  adminPassword: string | undefined = process.env.ADMIN_PASSWORD,
  sessionSecret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  environment: AuthEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    allowInsecureOpenMode: process.env.ALLOW_INSECURE_OPEN_MODE,
  },
  readOnlyPassword: string | undefined = process.env.READ_ONLY_PASSWORD,
): AuthConfiguration {
  const hasPassword = !!adminPassword;
  const hasSessionSecret = !!sessionSecret;
  if (
    hasPassword &&
    hasSessionSecret &&
    readOnlyPassword &&
    readOnlyPassword === adminPassword
  ) {
    return {
      mode: "misconfigured",
      error:
        "Authentication configuration error: READ_ONLY_PASSWORD must differ from ADMIN_PASSWORD",
    };
  }
  if (hasPassword && hasSessionSecret) {
    return { mode: "protected", readOnlyEnabled: !!readOnlyPassword };
  }

  const production = environment.nodeEnv === "production";
  const openModeRequested =
    environment.allowInsecureOpenMode?.trim().toLowerCase() === "true";
  if (!hasPassword && !production && openModeRequested) {
    return { mode: "open" };
  }

  const missing = [
    !hasPassword ? "ADMIN_PASSWORD" : null,
    !hasSessionSecret ? "ADMIN_SESSION_SECRET" : null,
  ].filter((value): value is string => value !== null);
  const productionSuffix =
    production && openModeRequested
      ? "; ALLOW_INSECURE_OPEN_MODE is ignored in production"
      : "";
  return {
    mode: "misconfigured",
    error: `Authentication configuration error: missing ${missing.join(
      " and ",
    )}${productionSuffix}`,
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;

  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function concatBytes(
  ...values: Uint8Array<ArrayBufferLike>[]
): Uint8Array<ArrayBuffer> {
  const length = values.reduce((total, value) => total + value.length, 0);
  const combined = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const value of values) {
    combined.set(value, offset);
    offset += value.length;
  }
  return combined;
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [aDigest, bDigest] = await Promise.all([sha256(a), sha256(b)]);
  return constantTimeEqualBytes(aDigest, bDigest);
}

export function sanitizeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/";

  const candidate = value.trim() || "/";
  let decoded = candidate;

  for (let pass = 0; pass < 8; pass++) {
    if (
      !decoded.startsWith("/") ||
      decoded.startsWith("//") ||
      /[\\\u0000-\u001f\u007f-\u009f]/.test(decoded)
    ) {
      return "/";
    }

    try {
      const nextDecoded = decodeURIComponent(decoded);
      if (nextDecoded === decoded) return candidate;
      decoded = nextDecoded;
    } catch {
      return "/";
    }
  }

  return "/";
}

async function importSessionKey(
  secret: string,
  password: string,
  access: SessionAccess,
): Promise<CryptoKey> {
  const passwordVersion = await sha256(
    `${PASSWORD_VERSION_CONTEXT}\u0000${access}\u0000${password}`,
  );
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derivedKey = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    concatBytes(encoder.encode(`${SESSION_KEY_CONTEXT}\u0000`), passwordVersion),
  );
  return crypto.subtle.importKey(
    "raw",
    derivedKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(
  secret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  password: string | undefined = process.env.ADMIN_PASSWORD,
  now = Date.now(),
  access: SessionAccess = "admin",
): Promise<string | null> {
  if (!secret || !password) return null;

  const issuedAt = Math.floor(now / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(SESSION_NONCE_BYTES));
  const payload: SessionPayload = {
    iat: issuedAt,
    exp: issuedAt + SESSION_COOKIE_MAX_AGE_SECONDS,
    nonce: bytesToBase64Url(nonceBytes),
    access,
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const unsignedToken = `${SESSION_VERSION}.${encodedPayload}`;
  const key = await importSessionKey(secret, password, access);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedToken)));

  return `${unsignedToken}.${bytesToBase64Url(signature)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  password: string | undefined = process.env.ADMIN_PASSWORD,
  now = Date.now(),
  expectedAccess: SessionAccess = "admin",
): Promise<boolean> {
  if (!token || !secret || !password || token.length > MAX_SESSION_TOKEN_LENGTH) return false;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;

  const [, encodedPayload, encodedSignature] = parts;
  const signature = base64UrlToBytes(encodedSignature);
  if (!signature || signature.length !== 32) return false;

  const payloadBytes = base64UrlToBytes(encodedPayload);
  if (!payloadBytes) return false;

  try {
    const payload = JSON.parse(decoder.decode(payloadBytes)) as Partial<SessionPayload>;
    const { iat, exp, nonce: encodedNonce, access } = payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !== "access,exp,iat,nonce" ||
      typeof iat !== "number" ||
      !Number.isSafeInteger(iat) ||
      typeof exp !== "number" ||
      !Number.isSafeInteger(exp) ||
      typeof encodedNonce !== "string" ||
      (access !== "admin" && access !== "read_only") ||
      access !== expectedAccess
    ) {
      return false;
    }

    const key = await importSessionKey(secret, password, access);
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(`${SESSION_VERSION}.${encodedPayload}`),
    );
    if (!validSignature) return false;

    const nonce = base64UrlToBytes(encodedNonce);
    if (!nonce || nonce.length !== SESSION_NONCE_BYTES) return false;

    const nowSeconds = Math.floor(now / 1000);
    return (
      iat <= nowSeconds + MAX_CLOCK_SKEW_SECONDS &&
      exp > nowSeconds &&
      exp - iat === SESSION_COOKIE_MAX_AGE_SECONDS
    );
  } catch {
    return false;
  }
}

export async function getSessionAccess(
  cookieValue: string | undefined,
  adminPassword: string | undefined = process.env.ADMIN_PASSWORD,
  sessionSecret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  now = Date.now(),
  environment: AuthEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    allowInsecureOpenMode: process.env.ALLOW_INSECURE_OPEN_MODE,
  },
  readOnlyPassword: string | undefined = process.env.READ_ONLY_PASSWORD,
): Promise<SessionAccess | null> {
  const configuration = getAuthConfiguration(
    adminPassword,
    sessionSecret,
    environment,
    readOnlyPassword,
  );
  if (configuration.mode === "open") return "admin";
  if (configuration.mode === "misconfigured") return null;
  if (
    await verifySessionToken(
      cookieValue,
      sessionSecret,
      adminPassword,
      now,
      "admin",
    )
  ) {
    return "admin";
  }
  if (
    readOnlyPassword &&
    (await verifySessionToken(
      cookieValue,
      sessionSecret,
      readOnlyPassword,
      now,
      "read_only",
    ))
  ) {
    return "read_only";
  }
  return null;
}

export async function isAuthenticated(
  cookieValue: string | undefined,
  adminPassword: string | undefined = process.env.ADMIN_PASSWORD,
  sessionSecret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  now = Date.now(),
  environment: AuthEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    allowInsecureOpenMode: process.env.ALLOW_INSECURE_OPEN_MODE,
  },
  readOnlyPassword: string | undefined = process.env.READ_ONLY_PASSWORD,
): Promise<boolean> {
  return (
    (await getSessionAccess(
      cookieValue,
      adminPassword,
      sessionSecret,
      now,
      environment,
      readOnlyPassword,
    )) !== null
  );
}

export async function hasWriteAccess(
  cookieValue: string | undefined,
  adminPassword: string | undefined = process.env.ADMIN_PASSWORD,
  sessionSecret: string | undefined = process.env.ADMIN_SESSION_SECRET,
  now = Date.now(),
  environment: AuthEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    allowInsecureOpenMode: process.env.ALLOW_INSECURE_OPEN_MODE,
  },
): Promise<boolean> {
  return (
    (await getSessionAccess(
      cookieValue,
      adminPassword,
      sessionSecret,
      now,
      environment,
      process.env.READ_ONLY_PASSWORD,
    )) === "admin"
  );
}

export function serverActionReadOnlyPath(returnTo: unknown): string {
  const params = new URLSearchParams({
    next: sanitizeNextPath(returnTo),
  });
  return `/read-only?${params.toString()}`;
}

export function serverActionLoginPath(returnTo: unknown): string {
  const params = new URLSearchParams({
    next: sanitizeNextPath(returnTo),
  });
  return `/login?${params.toString()}`;
}

export interface ServerActionAuthDependencies {
  readSessionCookie: () => Promise<string | undefined>;
  authenticate: (cookieValue: string | undefined) => Promise<boolean>;
  readAccess?: (
    cookieValue: string | undefined,
  ) => Promise<SessionAccess | null>;
  redirect: (location: string) => never;
}

export async function requireServerActionAuth(
  returnTo: unknown = "/",
  dependencies?: ServerActionAuthDependencies,
): Promise<void> {
  if (dependencies) {
    const cookieValue = await dependencies.readSessionCookie();
    if (await dependencies.authenticate(cookieValue)) return;
    if ((await dependencies.readAccess?.(cookieValue)) === "read_only") {
      return dependencies.redirect(serverActionReadOnlyPath(returnTo));
    }
    return dependencies.redirect(serverActionLoginPath(returnTo));
  }

  const [{ cookies }, { redirect }] = await Promise.all([
    import("next/headers"),
    import("next/navigation"),
  ]);
  const cookieValue = (await cookies()).get(SESSION_COOKIE)?.value;
  const access = await getSessionAccess(cookieValue);
  if (access === "admin") return;
  if (access === "read_only") {
    redirect(serverActionReadOnlyPath(returnTo));
  }
  redirect(serverActionLoginPath(returnTo));
}
