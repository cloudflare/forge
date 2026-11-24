/**
 * Turns the Stainless docs site's SDK JSON files into the site's snippets file. Offline and pure:
 * `./gitlab.ts` fetches the inputs.
 */

/** The SDKs whose snippets are ported, in tab order. */
export const LANGUAGES = ['typescript', 'python', 'go'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Versions the contract between this generator and the site, which checks it. */
export const FORMAT = 1;

/** The part of an `@stainless/sdk-json` spec this generator reads. */
export interface SdkJson {
  resources: Record<string, SdkResource>;
  snippets: Record<string, Record<string, { default?: { content?: string } }> | undefined>;
}

interface SdkResource {
  methods?: Record<string, SdkMethod>;
  subresources?: Record<string, SdkResource>;
}

interface SdkMethod {
  stainlessPath: string;
  /** Where the Stainless config declares the method: `#/resources/zones/methods/list`. */
  configRef?: string;
}

export interface SnippetsFile {
  format: typeof FORMAT;
  source: { apiSchemasSha: string; generatedAt: string };
  /** Old page, collection-relative as in `stainless-redirects.json` → its snippet per language. */
  snippets: Record<string, Partial<Record<Language, string>>>;
}

/**
 * One language's snippets, keyed by the old site's page for the method: its `configRef` without
 * the `#`, which is the page's collection-relative path (`/resources/zones/methods/list/`).
 */
export function extractSnippets(spec: SdkJson, language: Language): Map<string, string> {
  const byPath = spec.snippets[`${language}.default`];
  if (!byPath) {
    throw new Error(
      `${language}: the SDK JSON has no "${language}.default" snippets (it has ${Object.keys(spec.snippets).join(', ') || 'none'}). ` +
        'If the snippets moved to another key, update extractSnippets in scripts/snippets.ts to read it.',
    );
  }
  const snippets = new Map<string, string>();
  /** The method each page's snippet came from, to name both when two claim one page. */
  const owners = new Map<string, string>();
  const visit = (resource: SdkResource) => {
    for (const method of Object.values(resource.methods ?? {})) {
      const content = byPath[method.stainlessPath]?.default?.content;
      if (content === undefined) {
        continue;
      }
      const page = oldPage(method);
      const owner = owners.get(page);
      if (owner !== undefined && snippets.get(page) !== content) {
        throw new Error(
          `${language}: "${owner}" and "${method.stainlessPath}" both have the configRef of ${page}, with different snippets, ` +
            'so the old page has two candidates. Find which one that page showed in the SDK JSON, and make extractSnippets ' +
            'in scripts/snippets.ts keep it, for example by skipping the other stainlessPath.',
        );
      }
      owners.set(page, method.stainlessPath);
      snippets.set(page, content);
    }
    for (const child of Object.values(resource.subresources ?? {})) {
      visit(child);
    }
  };
  for (const resource of Object.values(spec.resources)) {
    visit(resource);
  }
  return snippets;
}

function oldPage(method: SdkMethod): string {
  const ref = method.configRef;
  if (!ref || !/^#\/resources\/[^#]+\/methods\/[^/#]+$/.test(ref)) {
    throw new Error(
      `${method.stainlessPath}: configRef is ${JSON.stringify(ref)}, not "#/resources/<...>/methods/<name>". ` +
        'If the SDK JSON now records a method elsewhere, update oldPage in scripts/snippets.ts to build the old page from it.',
    );
  }
  return `${ref.slice(1)}/`;
}

export interface BuildResult {
  file: SnippetsFile;
  /** Per language: old pages with a snippet but no entry in the redirects snapshot, so skipped. */
  unknown: Record<Language, string[]>;
  /** Per language: old method pages in the snapshot that have no snippet. */
  missing: Record<Language, string[]>;
}

/**
 * Keeps the snippets of the old method pages the redirects snapshot knows (`methods`), so the
 * site can follow its redirects to today's page. Fails if a snippet contains a forbidden string.
 */
export function buildSnippetsFile(input: {
  snippets: Record<Language, Map<string, string>>;
  methods: Iterable<string>;
  forbidden: readonly string[];
  source: SnippetsFile['source'];
}): BuildResult {
  const methods = new Set(input.methods);
  const snippets: SnippetsFile['snippets'] = {};
  const unknown = {} as BuildResult['unknown'];
  const missing = {} as BuildResult['missing'];
  const leaks: string[] = [];
  for (const language of LANGUAGES) {
    const found = input.snippets[language];
    unknown[language] = [...found.keys()].filter((page) => !methods.has(page)).sort();
    missing[language] = [...methods].filter((page) => !found.has(page)).sort();
    for (const [page, content] of found) {
      if (!methods.has(page)) {
        continue;
      }
      const hit = input.forbidden.find((needle) => content.toLowerCase().includes(needle.toLowerCase()));
      if (hit) {
        leaks.push(`${language} ${page}: contains "${hit}"`);
      }
      const entry = snippets[page] ?? {};
      entry[language] = content;
      snippets[page] = entry;
    }
  }
  if (leaks.length > 0) {
    throw new Error(
      `Snippets contain forbidden strings, which must not be published:\n  ${leaks.join('\n  ')}\n` +
        'They come from the source spec the snippets were generated from. Fix the examples there, wait for a new ' +
        'pipeline to publish fresh artifacts, and run again.',
    );
  }
  const sorted: SnippetsFile['snippets'] = {};
  for (const [page, entry] of Object.entries(snippets).sort(([a], [b]) => (a < b ? -1 : 1))) {
    sorted[page] = Object.fromEntries(
      LANGUAGES.flatMap((language) => (entry[language] ? [[language, entry[language]]] : [])),
    );
  }
  return { file: { format: FORMAT, source: input.source, snippets: sorted }, unknown, missing };
}
