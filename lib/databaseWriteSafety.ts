export const DESTRUCTIVE_TEST_CONFIRMATION =
  "CONFIRM_NONLOCAL_DATABASE_TEST_WRITE";
export const SAFE_TEST_DATABASE_URL =
  "postgresql://photo_admin_test:photo_admin_test@127.0.0.1:1/photo_admin_test";

interface DatabaseWriteSafetyEnvironment {
  DESTRUCTIVE_TEST_DATABASE_CONFIRMATION?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
}

function isLocalDatabaseHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".test")
  );
}

function hasProductionIdentity(url: URL): boolean {
  return /(^|[^a-z])(prod|production|vercel)([^a-z]|$)/i.test(
    `${url.username} ${url.hostname} ${url.pathname}`
  );
}

export function assertSafeDatabaseTestWrite(
  databaseUrls: readonly (string | undefined)[],
  environment: DatabaseWriteSafetyEnvironment = process.env
): void {
  const productionEnvironment =
    environment.VERCEL_ENV === "production" ||
    environment.VERCEL_TARGET_ENV === "production" ||
    environment.NODE_ENV === "production";
  const confirmedDisposableTarget =
    environment.DESTRUCTIVE_TEST_DATABASE_CONFIRMATION ===
    DESTRUCTIVE_TEST_CONFIRMATION;

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
    if (productionEnvironment || hasProductionIdentity(url)) {
      throw new Error(
        "Refusing a write-capable test against a production database target"
      );
    }
    if (!isLocalDatabaseHost(url.hostname) && !confirmedDisposableTarget) {
      throw new Error(
        "Refusing a write-capable test against a production or non-local database target; set the one-off destructive-test confirmation only for an intentional disposable target"
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
    CRON_SECRET: "",
    DESTRUCTIVE_TEST_DATABASE_CONFIRMATION: "",
  };
}
