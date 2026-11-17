/**
 * Redirects from the retired Stainless API reference to this site.
 *
 * The snapshot (`stainless-redirects.json`) lists what the old site served, in
 * its HTTP form: each method page with its operationId, each resource page, each
 * model page, and every operationId it knew. Paths are collection-relative.
 */
export interface StainlessSnapshot {
  resources: string[];
  methods: Record<string, string>;
  models: string[];
  operations: string[];
}

/** What this site publishes: `operationId` → slug, and the product and resource pages. */
export interface ForgeSite {
  operations: Record<string, string>;
  sections: ReadonlySet<string>;
}

export interface StainlessRedirectPlan {
  /** The old resource, method, operation and overview pages → today's, for `stainlessRedirect`. */
  lookup: Record<string, string>;
  /** Every old HTML page → today's page, collection-relative. */
  redirects: Record<string, string>;
  /** Old pages with no page of their own today, sent to an ancestor's instead. */
  fallbacks: string[];
  /** The highest-ranked old pages, for Astro's `redirects`, which the adapter writes to `_redirects`. */
  edge: Record<string, string>;
}

export interface StainlessRedirectOptions {
  /** How many static `_redirects` rules the plan may use. */
  staticRules?: number;
}

/** Workers static assets apply at most 2,000 static `_redirects` rules and drop the rest silently. */
export const STATIC_RULE_LIMIT = 2000;

/** The edge takes the overview first, then resources, then methods, each shallowest first. */
function rank(path: string): [kind: number, depth: number] {
  const kind =
    path === '/overview/'
      ? 0
      : path.includes('/methods/')
        ? 2
        : path.includes('/models/')
          ? 3
          : path.startsWith('/operations/')
            ? 4
            : 1;
  return [kind, path.split('/subresources/').length];
}

export function planStainlessRedirects(
  snapshot: StainlessSnapshot,
  site: ForgeSite,
  { staticRules = STATIC_RULE_LIMIT }: StainlessRedirectOptions = {},
): StainlessRedirectPlan {
  const table: Record<string, string> = { '/overview/': '/' };
  /** The section each mapped old method's page lives in, as segments. */
  const methodSections: [path: string, segments: string[]][] = [];
  for (const [path, operationId] of Object.entries(snapshot.methods)) {
    const slug = site.operations[operationId];
    if (!slug) continue;
    table[path] = `/${slug}/`;
    methodSections.push([path, slug.slice(0, slug.lastIndexOf('/methods/')).split('/')]);
  }
  const fallbacks: string[] = [];
  // Parents first, so a resource can fall back to its parent's target.
  const resources = [...snapshot.resources].sort((a, b) => a.length - b.length);
  for (const resource of resources) {
    const held = methodSections.filter(([path]) => path.startsWith(resource)).map(([, segments]) => segments);
    const target = existingSection(commonPrefix(inLeadingProduct(held)), site.sections);
    if (target) {
      table[resource] = target;
      continue;
    }
    table[resource] = table[parentResource(resource)] ?? '/';
    fallbacks.push(resource);
  }
  for (const path of Object.keys(snapshot.methods)) {
    if (table[path]) continue;
    table[path] = table[path.slice(0, path.lastIndexOf('methods/'))] ?? '/';
    fallbacks.push(path);
  }
  const redirects = { ...table };
  for (const model of snapshot.models) {
    redirects[model] = table[model.slice(0, model.lastIndexOf('models/'))] ?? '/';
  }
  const byOperation = new Map(Object.entries(snapshot.methods).map(([path, operationId]) => [operationId, path]));
  const lookup = { ...table };
  for (const operationId of snapshot.operations) {
    const slug = site.operations[operationId];
    const method = byOperation.get(operationId);
    lookup[`/operations/${operationId}/`] = redirects[`/operations/${operationId}/`] = slug
      ? `/${slug}/`
      : ((method && table[method]) ?? '/');
  }
  const ranked = Object.keys(redirects).sort((a, b) => {
    const [kindA, depthA] = rank(a);
    const [kindB, depthB] = rank(b);
    return kindA - kindB || depthA - depthB || a.localeCompare(b);
  });
  const edge = Object.fromEntries(ranked.slice(0, staticRules).map((path) => [path, redirects[path]!]));
  return { lookup, redirects, fallbacks, edge };
}

/** `/resources/a/subresources/b/` → `/resources/a/`; a top-level resource has none. */
function parentResource(resource: string): string {
  const at = resource.lastIndexOf('/subresources/');
  return at === -1 ? '' : resource.slice(0, at + 1);
}

/** The sections in the product that holds the most of them; ties go to the first. */
function inLeadingProduct(sections: string[][]): string[][] {
  const counts = new Map<string, number>();
  for (const [product] of sections) counts.set(product!, (counts.get(product!) ?? 0) + 1);
  let leading: string | undefined;
  for (const [product, count] of counts) if (!leading || count > counts.get(leading)!) leading = product;
  return sections.filter(([product]) => product === leading);
}

function commonPrefix(paths: string[][]): string[] {
  const [first, ...rest] = paths;
  if (!first) return [];
  let length = first.length;
  for (const path of rest) {
    let shared = 0;
    while (shared < length && path[shared] === first[shared]) shared++;
    length = shared;
  }
  return first.slice(0, length);
}

/** The deepest section page at or above `segments`. */
function existingSection(segments: string[], sections: ReadonlySet<string>): string | undefined {
  for (let depth = segments.length; depth > 0; depth--) {
    const path = `/${segments.slice(0, depth).join('/')}/`;
    if (sections.has(path)) return path;
  }
  return undefined;
}

/**
 * Where the middleware sends an old Stainless URL: its page, with a model page
 * standing for its resource; its Markdown twin; or, under `/terraform/`, the page
 * in its Terraform view (`?lang=terraform`). `path` is collection-relative;
 * `lookup` is the plan's.
 */
export function stainlessRedirect(
  path: string,
  search: string,
  lookup: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const terraform = path.startsWith('/terraform/');
  let page = terraform ? path.slice('/terraform'.length) : path;
  const markdown = page.endsWith('/index.md');
  if (markdown) page = page.slice(0, -'index.md'.length);
  const model = page.lastIndexOf('/models/');
  if (model !== -1) page = page.slice(0, model + 1);
  // The old Terraform home is the only root that isn't this site's own.
  const target = page === '/' ? (terraform ? '/' : undefined) : lookup[page];
  if (!target) return undefined;
  if (markdown) return `${target}index.md${search}`;
  if (!terraform) return `${target}${search}`;
  const params = new URLSearchParams(search);
  params.set('lang', 'terraform');
  return `${target}?${params}`;
}
