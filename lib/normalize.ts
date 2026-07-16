export function normalizeArtistName(name: string): string {
  let folded = "";
  let precedingLetterIsNonLatin = false;

  for (const character of name.normalize("NFKD").toLowerCase()) {
    if (/\p{M}/u.test(character)) {
      if (precedingLetterIsNonLatin) folded += character;
      continue;
    }
    precedingLetterIsNonLatin =
      /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character);
    folded += character;
  }

  return folded
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
