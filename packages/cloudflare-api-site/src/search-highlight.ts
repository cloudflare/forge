export interface SearchHighlightPart {
  text: string;
  highlighted: boolean;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitWithTerms(value: string, terms: string[]): SearchHighlightPart[] {
  const normalizedTerms = new Set(terms.map((term) => term.toLocaleLowerCase()));
  const alternatives = terms
    .toSorted((left, right) => right.length - left.length)
    .map(escapeRegularExpression)
    .join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives})`, 'giu');

  return value
    .split(pattern)
    .filter(Boolean)
    .map((text) => ({ text, highlighted: normalizedTerms.has(text.toLocaleLowerCase()) }));
}

/**
 * Splits `value` into the parts that match `query` and the rest. The complete
 * query is preferred; otherwise each whitespace-separated term matches on its
 * own. Matches start a word, so a half-typed word already shows where it
 * leads; they are case-insensitive and keep their casing.
 */
export function splitSearchHighlight(value: string, query: string): SearchHighlightPart[] {
  const trimmedQuery = query.trim();
  if (!value || !trimmedQuery) return value ? [{ text: value, highlighted: false }] : [];

  const exactQueryPattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegularExpression(trimmedQuery)}`, 'iu');
  if (exactQueryPattern.test(value)) return splitWithTerms(value, [trimmedQuery]);

  return splitWithTerms(value, Array.from(new Set(trimmedQuery.split(/\s+/))));
}
