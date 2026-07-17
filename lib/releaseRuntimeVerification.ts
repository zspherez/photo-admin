import { randomBytes } from "node:crypto";
import { constantTimeEqual } from "@/lib/auth";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import type { DatabaseTargetConnection } from "@/lib/databaseTargetVerification";

export const RELEASE_RUNTIME_VERIFICATION_SETTING_KEY =
  "release_runtime_database_verification:v1";
export const RELEASE_RUNTIME_APP_BASE_URL_HEADER =
  "x-photo-admin-release-app-base-url";
export const RELEASE_RUNTIME_SHA_HEADER = "x-photo-admin-release-sha";
export const RELEASE_RUNTIME_VERIFICATION_TTL_MS = 25 * 60 * 1_000;
export const RELEASE_RUNTIME_VERIFICATION_MAX_TTL_MS = 30 * 60 * 1_000;

const RELEASE_NONCE_BYTES = 32;
const RELEASE_NONCE_LENGTH = 43;
const MARKER_KEYS = ["expiresAt", "nonce", "releaseSha", "version"];

export interface ReleaseRuntimeVerificationMarker {
  version: 1;
  nonce: string;
  releaseSha: string;
  expiresAt: number;
}

export interface PrepareReleaseRuntimeVerificationOptions {
  releaseSha: string;
  now?: () => number;
  createNonce?: () => string;
  ttlMs?: number;
}

export interface ReleaseRuntimeVerificationRequestInput {
  authorization: string | null;
  expectedAppBaseUrl: string | null;
  expectedReleaseSha: string | null;
}

export interface ReleaseRuntimeVerificationRequestDependencies {
  cronSecret?: string;
  configuredAppBaseUrl?: string;
  readMarkerValue: () => Promise<string | null>;
  now?: () => number;
}

export type ReleaseRuntimeVerificationRequestResult =
  | {
      status: 200;
      body: ReleaseRuntimeVerificationMarker;
    }
  | {
      status: 400 | 401 | 404 | 503;
      body: { error: string };
    };

export class ReleaseRuntimeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRuntimeVerificationError";
  }
}

function validReleaseSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function validReleaseNonce(value: string): boolean {
  if (
    value.length !== RELEASE_NONCE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return (
      decoded.length === RELEASE_NONCE_BYTES &&
      decoded.toString("base64url") === value
    );
  } catch {
    return false;
  }
}

function parseMarkerStructure(value: string): ReleaseRuntimeVerificationMarker {
  if (!value || value.length > 512) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is malformed"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is malformed"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is malformed"
    );
  }

  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== MARKER_KEYS.length ||
    keys.some((key, index) => key !== MARKER_KEYS[index])
  ) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is malformed"
    );
  }

  const version = Reflect.get(parsed, "version");
  const nonce = Reflect.get(parsed, "nonce");
  const releaseSha = Reflect.get(parsed, "releaseSha");
  const expiresAt = Reflect.get(parsed, "expiresAt");
  if (
    version !== 1 ||
    typeof nonce !== "string" ||
    !validReleaseNonce(nonce) ||
    typeof releaseSha !== "string" ||
    !validReleaseSha(releaseSha) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is malformed"
    );
  }

  return { version, nonce, releaseSha, expiresAt };
}

export function parseActiveReleaseRuntimeVerificationMarker(
  value: string,
  now = Date.now()
): ReleaseRuntimeVerificationMarker {
  const marker = parseMarkerStructure(value);
  if (
    marker.expiresAt <= now ||
    marker.expiresAt > now + RELEASE_RUNTIME_VERIFICATION_MAX_TTL_MS
  ) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker is stale"
    );
  }
  return marker;
}

function serializeMarker(marker: ReleaseRuntimeVerificationMarker): string {
  return JSON.stringify(marker);
}

async function readConnectionValues(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection
): Promise<[string | null, string | null]> {
  return Promise.all([
    runtime.readVerificationNonce(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
    direct.readVerificationNonce(RELEASE_RUNTIME_VERIFICATION_SETTING_KEY),
  ]);
}

async function deleteExactMarkerEverywhere(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  value: string
): Promise<void> {
  await Promise.allSettled([
    runtime.deleteVerificationNonce(
      RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
      value
    ),
    direct.deleteVerificationNonce(
      RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
      value
    ),
  ]);
  const values = await readConnectionValues(runtime, direct);
  if (values.includes(value)) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker cleanup could not be confirmed"
    );
  }
}

async function clearReplaceableMarker(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  now: number
): Promise<void> {
  const [runtimeValue, directValue] = await readConnectionValues(runtime, direct);
  if (runtimeValue !== directValue) {
    throw new ReleaseRuntimeVerificationError(
      "DATABASE_URL and DIRECT_URL do not observe the same release marker state"
    );
  }
  if (runtimeValue === null) return;

  let marker: ReleaseRuntimeVerificationMarker | null = null;
  try {
    marker = parseMarkerStructure(runtimeValue);
  } catch {}
  if (
    marker &&
    marker.expiresAt > now &&
    marker.expiresAt <= now + RELEASE_RUNTIME_VERIFICATION_MAX_TTL_MS
  ) {
    throw new ReleaseRuntimeVerificationError(
      "An unexpired release runtime verification marker already exists"
    );
  }

  await deleteExactMarkerEverywhere(runtime, direct, runtimeValue);
}

export async function prepareReleaseRuntimeVerification(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  options: PrepareReleaseRuntimeVerificationOptions
): Promise<ReleaseRuntimeVerificationMarker> {
  const releaseSha = options.releaseSha.trim().toLowerCase();
  if (!validReleaseSha(releaseSha)) {
    throw new ReleaseRuntimeVerificationError(
      "A full release commit SHA is required"
    );
  }

  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? RELEASE_RUNTIME_VERIFICATION_TTL_MS;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > RELEASE_RUNTIME_VERIFICATION_MAX_TTL_MS
  ) {
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification timing is invalid"
    );
  }

  const createNonce =
    options.createNonce ??
    (() => randomBytes(RELEASE_NONCE_BYTES).toString("base64url"));
  const nonce = createNonce();
  if (!validReleaseNonce(nonce)) {
    throw new ReleaseRuntimeVerificationError(
      "Generated release runtime verification nonce is invalid"
    );
  }

  const marker: ReleaseRuntimeVerificationMarker = {
    version: 1,
    nonce,
    releaseSha,
    expiresAt: now + ttlMs,
  };
  const value = serializeMarker(marker);

  await clearReplaceableMarker(runtime, direct, now);
  try {
    await runtime.writeVerificationNonce(
      RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
      value
    );
    if (
      (await direct.readVerificationNonce(
        RELEASE_RUNTIME_VERIFICATION_SETTING_KEY
      )) !== value
    ) {
      throw new ReleaseRuntimeVerificationError(
        "The release marker written through DATABASE_URL was not observed through DIRECT_URL"
      );
    }
  } catch (error) {
    await deleteExactMarkerEverywhere(runtime, direct, value).catch(() => {});
    if (error instanceof ReleaseRuntimeVerificationError) throw error;
    throw new ReleaseRuntimeVerificationError(
      "Release runtime verification marker could not be prepared"
    );
  }

  return marker;
}

export async function cleanupReleaseRuntimeVerification(
  runtime: DatabaseTargetConnection,
  direct: DatabaseTargetConnection,
  expectedNonce: string
): Promise<void> {
  if (!validReleaseNonce(expectedNonce)) {
    throw new ReleaseRuntimeVerificationError(
      "A valid release runtime verification nonce is required for cleanup"
    );
  }

  const values = await readConnectionValues(runtime, direct);
  const presentValues = values
    .map((value, index) => ({
      connection: index === 0 ? runtime : direct,
      value,
    }))
    .filter(
      (
        entry
      ): entry is {
        connection: DatabaseTargetConnection;
        value: string;
      } => entry.value !== null
    );
  for (const { value } of presentValues) {
    let marker: ReleaseRuntimeVerificationMarker;
    try {
      marker = parseMarkerStructure(value);
    } catch {
      throw new ReleaseRuntimeVerificationError(
        "Release runtime verification cleanup refused a malformed marker"
      );
    }
    if (!(await constantTimeEqual(marker.nonce, expectedNonce))) {
      throw new ReleaseRuntimeVerificationError(
        "Release runtime verification cleanup refused a different marker"
      );
    }
  }

  await Promise.allSettled(
    presentValues.map(({ connection, value }) =>
      connection.deleteVerificationNonce(
        RELEASE_RUNTIME_VERIFICATION_SETTING_KEY,
        value
      )
    )
  );

  const remainingValues = await readConnectionValues(runtime, direct);
  for (const value of remainingValues) {
    if (value === null) continue;
    try {
      const marker = parseMarkerStructure(value);
      if (await constantTimeEqual(marker.nonce, expectedNonce)) {
        throw new ReleaseRuntimeVerificationError(
          "Release runtime verification marker cleanup could not be confirmed"
        );
      }
    } catch (error) {
      if (error instanceof ReleaseRuntimeVerificationError) throw error;
    }
  }
}

function normalizeHttpsOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export async function resolveReleaseRuntimeVerificationRequest(
  input: ReleaseRuntimeVerificationRequestInput,
  dependencies: ReleaseRuntimeVerificationRequestDependencies
): Promise<ReleaseRuntimeVerificationRequestResult> {
  if (
    !(await isValidCronAuthorization(
      input.authorization,
      dependencies.cronSecret
    ))
  ) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const expectedAppBaseUrl = normalizeHttpsOrigin(input.expectedAppBaseUrl);
  const configuredAppBaseUrl = normalizeHttpsOrigin(
    dependencies.configuredAppBaseUrl
  );
  if (!expectedAppBaseUrl) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!configuredAppBaseUrl) {
    return { status: 503, body: { error: "verification_unavailable" } };
  }
  if (!(await constantTimeEqual(expectedAppBaseUrl, configuredAppBaseUrl))) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const expectedReleaseSha = input.expectedReleaseSha?.trim().toLowerCase();
  if (!expectedReleaseSha || !validReleaseSha(expectedReleaseSha)) {
    return { status: 400, body: { error: "invalid_request" } };
  }

  let value: string | null;
  try {
    value = await dependencies.readMarkerValue();
  } catch {
    return { status: 503, body: { error: "verification_unavailable" } };
  }
  if (value === null) {
    return { status: 404, body: { error: "verification_unavailable" } };
  }

  let marker: ReleaseRuntimeVerificationMarker;
  try {
    marker = parseActiveReleaseRuntimeVerificationMarker(
      value,
      dependencies.now?.() ?? Date.now()
    );
  } catch {
    return { status: 404, body: { error: "verification_unavailable" } };
  }
  if (!(await constantTimeEqual(marker.releaseSha, expectedReleaseSha))) {
    return { status: 404, body: { error: "verification_unavailable" } };
  }

  return { status: 200, body: marker };
}
