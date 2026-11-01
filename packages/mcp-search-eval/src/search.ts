/**
 * A BM25 index over what a client sees of each tool: its name, title and
 * description. It stands in for the search an MCP client runs over a large
 * tool list (a tool search tool, or code that greps the list), so a score
 * shows whether a tool's name and description carry the words people use for
 * what it does. Clients search differently, so it is a proxy: a fall in the
 * score is worth a look, a single rank is not.
 */

/** The parts of a listed tool that a search reads. */
export interface Listed {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
}

/**
 * Splits `text` into lower-case words: at anything that isn't a letter or a
 * digit, and between the words of a camelCase or snake_case name, so
 * `zeroTrust_access_applications_list` is `zero trust access application
 * list`. A trailing `s` is dropped, so `bucket` finds `buckets`.
 */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

const K1 = 1.2;
const B = 0.75;

/** The words a tool is found by. The name counts twice: it is what a client shows and calls. */
function document(tool: Listed): string[] {
  return words(`${tool.name} ${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`);
}

/** Ranks `tools` for a query, best first. */
export function index<T extends Listed>(tools: readonly T[]): (query: string) => T[] {
  const docs = tools.map((tool) => {
    const counts = new Map<string, number>();
    const list = document(tool);
    for (const word of list) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return { counts, length: list.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const frequency = new Map<string, number>();
  for (const doc of docs) {
    for (const word of doc.counts.keys()) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const idf = (word: string) => {
    const n = frequency.get(word) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return (query) => {
    const terms = [...new Set(words(query))];
    return docs
      .map((doc, i) => {
        let score = 0;
        for (const term of terms) {
          const f = doc.counts.get(term) ?? 0;
          if (f > 0) {
            score += (idf(term) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / average));
          }
        }
        return { score, i };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ i }) => tools[i]!);
  };
}
