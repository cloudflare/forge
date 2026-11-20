/**
 * Splits an OpenAPI identifier into the lowercase words a Forge `Name` would produce.
 *
 * Word boundaries follow Forge's `Name::new` rules (see `crates/forge/src/name.rs`):
 *
 * - Non-alphanumeric characters separate words (`list.zones` → `list`, `zones`).
 * - A lowercase letter or digit before an uppercase letter starts a new word
 *   (`getBy` → `get`, `by`; `ipv4Cidr` → `ipv4`, `cidr`).
 * - The last letter of an acronym before a lowercase letter starts a new word
 *   (`XMLDocument` → `xml`, `document`).
 *
 * Returns the lowercase word list, or an empty array for input that has no letters or digits (an
 * empty string, `"*"`, `"---"`, a non-string value). Two names are considered to collide when
 * their word lists are equal.
 */
export function toForgeWords(name: unknown): string[] {
  if (typeof name !== 'string') {
    return [];
  }
  const words: string[] = [];
  const chars = [...name];
  let wordStart: number | null = null;
  let prevChar: string | null = null;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (/[\p{Alphabetic}\p{N}]/u.test(char)) {
      if (wordStart !== null) {
        const nextChar = index + 1 < chars.length ? chars[index + 1]! : null;
        const nextLower = nextChar !== null && /\p{Ll}/u.test(nextChar);
        if (
          (/\p{Ll}/u.test(prevChar!) || /\p{N}/u.test(prevChar!) || (/\p{Lu}/u.test(prevChar!) && nextLower)) &&
          /\p{Lu}/u.test(char)
        ) {
          words.push(chars.slice(wordStart, index).join('').toLowerCase());
          wordStart = index;
        }
      } else {
        wordStart = index;
      }
      prevChar = char;
    } else if (wordStart !== null) {
      words.push(chars.slice(wordStart, index).join('').toLowerCase());
      wordStart = null;
      prevChar = null;
    }
  }
  if (wordStart !== null) {
    words.push(chars.slice(wordStart).join('').toLowerCase());
  }
  return words;
}

/**
 * Canonical collision key for `toForgeWords`: two names collide iff their keys are equal. Using
 * `\u0000` as the word separator keeps the key unambiguous even for inputs like `["a", "bc"]` vs
 * `["ab", "c"]`.
 */
export function forgeWordsKey(name: unknown): string {
  return toForgeWords(name).join('\u0000');
}
