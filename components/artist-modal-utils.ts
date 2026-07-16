function safeRelativePage(value: string): string {
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

export function artistModalLoginPath(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  const next = safeRelativePage(
    `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`,
  );
  return `/login?${new URLSearchParams({ next }).toString()}`;
}
