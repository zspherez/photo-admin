export const NEW_SHOWS_PAGE_SIZE = 300;

export interface NewShowSnapshotCursor {
  createdAt: Date;
  id: string;
}

export interface NewShowSnapshotRow {
  createdAt: Date;
  id: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function parseSnapshotCutoff(
  value: unknown,
  now = new Date(),
): Date | null {
  const raw = firstString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== raw ||
    parsed > now
  ) {
    return null;
  }
  return parsed;
}

export function parseSnapshotCursor(
  createdAtValue: unknown,
  idValue: unknown,
  cutoff: Date,
): NewShowSnapshotCursor | null {
  const createdAt = parseSnapshotCutoff(createdAtValue, cutoff);
  const id = firstString(idValue);
  if (
    !createdAt ||
    !id ||
    id.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    return null;
  }
  return { createdAt, id };
}

export function snapshotPageHref(
  cutoff: Date,
  cursor?: NewShowSnapshotCursor,
): string {
  const params = new URLSearchParams({ cutoff: cutoff.toISOString() });
  if (cursor) {
    params.set("beforeCreatedAt", cursor.createdAt.toISOString());
    params.set("beforeId", cursor.id);
  }
  return `/new?${params.toString()}`;
}

function comesAfterCursor(
  row: NewShowSnapshotRow,
  cursor: NewShowSnapshotCursor,
): boolean {
  const rowTime = row.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  return rowTime < cursorTime || (rowTime === cursorTime && row.id < cursor.id);
}

export async function traverseNewShowSnapshot<T extends NewShowSnapshotRow>({
  cutoff,
  fetchPage,
  pageSize = NEW_SHOWS_PAGE_SIZE,
}: {
  cutoff: Date;
  fetchPage: (options: {
    cutoff: Date;
    cursor: NewShowSnapshotCursor | null;
    take: number;
  }) => Promise<T[]>;
  pageSize?: number;
}): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Snapshot page size must be a positive integer");
  }

  let cursor: NewShowSnapshotCursor | null = null;
  let traversed = 0;

  while (true) {
    const rows = await fetchPage({ cutoff, cursor, take: pageSize });
    if (rows.length > pageSize) {
      throw new Error("Snapshot query returned more rows than requested");
    }

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row.createdAt > cutoff) {
        throw new Error("Snapshot query returned a row after the cutoff");
      }
      if (cursor && !comesAfterCursor(row, cursor)) {
        throw new Error("Snapshot query did not advance past its cursor");
      }
      if (index > 0 && !comesAfterCursor(row, rows[index - 1])) {
        throw new Error("Snapshot query returned unstable ordering");
      }
    }

    traversed += rows.length;
    if (rows.length < pageSize) return traversed;

    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}
