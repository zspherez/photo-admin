const DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6,
  0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0,
  0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80,
  0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900,
  0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
  0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
  0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50,
  0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1e140, 0x1e2f0,
  0x1e950,
] as const;

function decimalDigit(character: string): string | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return null;
  for (const zero of DECIMAL_ZERO_CODE_POINTS) {
    const value = codePoint - zero;
    if (value >= 0 && value <= 9) return String(value);
  }
  return null;
}

export function normalizeUnicodeDigits(value: string): string {
  let normalized = "";
  for (const character of value.normalize("NFKC")) {
    normalized += decimalDigit(character) ?? character;
  }
  return normalized;
}

function isDateGroups(groups: readonly string[]): boolean {
  if (groups.length !== 3) return false;
  return (
    (groups[0].length === 4 &&
      groups[1].length === 2 &&
      groups[2].length === 2) ||
    (groups[0].length === 2 &&
      groups[1].length === 2 &&
      groups[2].length === 4)
  );
}

export function containsPhoneLikeNumber(
  value: string,
  options: { allowStandaloneNumericId?: boolean } = {},
): boolean {
  const normalized = normalizeUnicodeDigits(value).replace(
    /\b(?:id|version|release)\s*[:#]?\s*\d{7,15}\b/gi,
    "",
  );
  const candidates =
    normalized.match(/[+()]?\d(?:[\d\s()./\\-]*\d)?/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    const hasStrongMarker = /[+()]/.test(candidate);
    const groups = candidate.split(/\D+/).filter(Boolean);
    if (isDateGroups(groups)) continue;
    if (hasStrongMarker) return true;
    if (groups.length >= 2 && groups.every((group) => group.length <= 4)) {
      return true;
    }
    if (
      groups.length === 1 &&
      !options.allowStandaloneNumericId
    ) {
      return true;
    }
  }
  return false;
}

export function assertNoPhoneLikeNumber(
  value: string,
  field: string,
): void {
  if (containsPhoneLikeNumber(value)) {
    throw new Error(`${field} cannot contain a phone number`);
  }
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

export function assertAgentSafeSourceUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  const phoneKey = /^(?:phone|tel|telephone|mobile|cell|call|sms|whatsapp)$/i;
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    if (
      containsPhoneLikeNumber(safelyDecode(segment), {
        allowStandaloneNumericId: true,
      })
    ) {
      throw new Error(`${field} cannot contain a phone number`);
    }
  }
  for (const [key, rawValue] of url.searchParams) {
    const decoded = safelyDecode(rawValue);
    if (
      containsPhoneLikeNumber(decoded, {
        allowStandaloneNumericId: !phoneKey.test(key),
      })
    ) {
      throw new Error(`${field} cannot contain a phone number`);
    }
  }
}
