export type SearchParamValue = string | string[] | undefined;

export function firstSearchParam(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return typeof value[0] === "string" ? value[0] : undefined;
}

export function validatedTrimmedSearchParam(
  value: unknown,
  options: { maxLength?: number } = {}
): string | undefined {
  const normalized = firstSearchParam(value)?.trim();
  const maxLength = options.maxLength ?? 200;
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function positiveIntegerSearchParam(
  value: unknown,
  fallback = 1
): number {
  const normalized = firstSearchParam(value);
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
