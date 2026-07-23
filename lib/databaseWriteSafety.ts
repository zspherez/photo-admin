import { createHash } from "node:crypto";

export const DESTRUCTIVE_TEST_CONFIRMATION =
  "CONFIRM_NONLOCAL_DATABASE_TEST_WRITE";
export const SAFE_TEST_DATABASE_URL =
  "postgresql://photo_admin_test:photo_admin_test@127.0.0.1:1/photo_admin_test";

interface DatabaseWriteSafetyEnvironment {
  DESTRUCTIVE_TEST_DATABASE_CONFIRMATION?: string;
  NODE_ENV?: string;
  TEST_DATABASE_ALLOWED_DATABASES?: string;
  TEST_DATABASE_ALLOWED_HOSTS?: string;
  TEST_DATABASE_ALLOWED_SHA256?: string;
  VERCEL?: string;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
}

function isLocalLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function databaseName(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase();
  } catch {
    throw new Error("The database target has an invalid database name");
  }
}

function isDisposableLocalDatabaseName(name: string): boolean {
  return /(^|[_-])test($|[_-])/i.test(name);
}

function hasProductionIdentity(url: URL): boolean {
  return /prod|vercel/i.test(
    `${url.username} ${url.hostname} ${databaseName(url)}`
  );
}

function allowlistValues(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function databaseTargetFingerprint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The database target is not a valid URL");
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("The database target must use PostgreSQL");
  }
  const identity = [
    "postgresql",
    url.hostname.toLowerCase().replace(/\.$/, ""),
    url.port || "5432",
    databaseName(url),
  ].join("|");
  return createHash("sha256").update(identity).digest("hex");
}

export function assertSafeDatabaseTestWrite(
  databaseUrls: readonly (string | undefined)[],
  environment: DatabaseWriteSafetyEnvironment = process.env
): void {
  const isProductionMarker = (value: string | undefined) =>
    value?.trim().toLowerCase() === "production";
  const productionEnvironment =
    isProductionMarker(environment.VERCEL_ENV) ||
    isProductionMarker(environment.VERCEL_TARGET_ENV) ||
    isProductionMarker(environment.NODE_ENV) ||
    environment.VERCEL === "1";
  const confirmedDisposableTarget =
    environment.DESTRUCTIVE_TEST_DATABASE_CONFIRMATION ===
    DESTRUCTIVE_TEST_CONFIRMATION;
  const allowedHosts = allowlistValues(
    environment.TEST_DATABASE_ALLOWED_HOSTS
  );
  const allowedDatabases = allowlistValues(
    environment.TEST_DATABASE_ALLOWED_DATABASES
  );
  const allowedFingerprints = allowlistValues(
    environment.TEST_DATABASE_ALLOWED_SHA256
  );

  for (const value of databaseUrls) {
    if (!value) {
      throw new Error("A database URL is required for this write-capable test");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("The database target is not a valid URL");
    }
    if (
      url.protocol !== "postgres:" &&
      url.protocol !== "postgresql:"
    ) {
      throw new Error("The database target must use PostgreSQL");
    }
    if (productionEnvironment || hasProductionIdentity(url)) {
      throw new Error(
        "Refusing a write-capable test against a production database target"
      );
    }
    const targetDatabase = databaseName(url);
    if (isLocalLoopbackHost(url.hostname)) {
      if (!isDisposableLocalDatabaseName(targetDatabase)) {
        throw new Error(
          "Refusing a write-capable test against a non-test local database"
        );
      }
      continue;
    }
    const allowlistedByIdentity =
      allowedHosts.has(url.hostname.toLowerCase().replace(/\.$/, "")) &&
      allowedDatabases.has(targetDatabase);
    const allowlistedByFingerprint = allowedFingerprints.has(
      databaseTargetFingerprint(value)
    );
    if (
      !confirmedDisposableTarget ||
      (!allowlistedByIdentity && !allowlistedByFingerprint)
    ) {
      throw new Error(
        "Refusing a write-capable test against an unknown remote database target; remote targets require confirmation plus an explicit disposable-target allowlist or fingerprint"
      );
    }
  }
}

export function sanitizedTestEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    NODE_ENV: "test",
    VERCEL_ENV: "development",
    VERCEL_TARGET_ENV: "development",
    DATABASE_URL: SAFE_TEST_DATABASE_URL,
    DIRECT_URL: SAFE_TEST_DATABASE_URL,
    SHADOW_DATABASE_URL: SAFE_TEST_DATABASE_URL,
    DOTENV_CONFIG_PATH: "scripts/.env.test-disabled",
    DOTENV_CONFIG_OVERRIDE: "false",
    DOTENV_CONFIG_QUIET: "true",
    CONTACT_RESEARCH_AGENT_TOKEN: "",
    CONTACT_AUDIT_AGENT_TOKEN: "",
    READ_ONLY_PASSWORD: "",
    CRON_SECRET: "",
    DESTRUCTIVE_TEST_DATABASE_CONFIRMATION: "",
    TEST_DATABASE_ALLOWED_HOSTS: "",
    TEST_DATABASE_ALLOWED_DATABASES: "",
    TEST_DATABASE_ALLOWED_SHA256: "",
  };
}
