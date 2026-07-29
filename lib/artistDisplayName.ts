export interface ArtistDisplayNameInput {
  name: string;
  customName?: string | null;
}

export function artistDisplayName(artist: ArtistDisplayNameInput): string {
  return artist.customName?.trim() || artist.name;
}

export function normalizeArtistCustomName(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("Custom artist name must be text");
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 200) {
    throw new Error("Custom artist name must be 200 characters or fewer");
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Custom artist name contains unsupported characters");
  }
  return normalized;
}
