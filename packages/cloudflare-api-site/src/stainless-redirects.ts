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
  /** Every old page → today's page, collection-relative, for `stainlessRedirect`. */
  lookup: Record<string, string>;
  /** Old pages with no page of their own today, sent to an ancestor's instead. */
  fallbacks: string[];
}

export function planStainlessRedirects(snapshot: StainlessSnapshot, site: ForgeSite): StainlessRedirectPlan {
  const lookup: Record<string, string> = { '/overview/': '/' };
  const fallbacks = new Set<string>();
  const fallBack = (path: string, to: string | undefined) => {
    lookup[path] = to ?? '/';
    fallbacks.add(path);
  };

  /** The section each mapped old method's page lives in, as segments. */
  const methodSections: [path: string, segments: string[]][] = [];
  for (const [path, operationId] of Object.entries(snapshot.methods)) {
    const slug = site.operations[operationId];
    if (!slug) continue;
    lookup[path] = `/${slug}/`;
    methodSections.push([path, slug.slice(0, slug.lastIndexOf('/methods/')).split('/')]);
  }
  // Parents first, so a resource can fall back to its parent's target.
  for (const resource of [...snapshot.resources].sort((a, b) => a.length - b.length)) {
    const held = methodSections.filter(([path]) => path.startsWith(resource)).map(([, segments]) => segments);
    const target = existingSection(commonPrefix(inLeadingProduct(held)), site.sections);
    if (target) lookup[resource] = target;
    else fallBack(resource, lookup[parentResource(resource)]);
  }
  for (const path of Object.keys(snapshot.methods)) {
    if (!lookup[path]) fallBack(path, lookup[ownerResource(path, 'methods/')]);
  }
  for (const model of snapshot.models) {
    const owner = ownerResource(model, 'models/');
    if (fallbacks.has(owner)) fallBack(model, lookup[owner]);
    else lookup[model] = lookup[owner] ?? '/';
  }
  const byOperation = new Map(Object.entries(snapshot.methods).map(([path, operationId]) => [operationId, path]));
  for (const operationId of snapshot.operations) {
    const path = `/operations/${operationId}/`;
    const slug = site.operations[operationId];
    const method = byOperation.get(operationId);
    if (slug) lookup[path] = `/${slug}/`;
    else fallBack(path, method && lookup[method]);
  }
  return { lookup, fallbacks: [...fallbacks] };
}

/** The old resource page a method or model page belongs to: `/resources/a/methods/b/` → `/resources/a/`. */
function ownerResource(path: string, segment: 'methods/' | 'models/'): string {
  return path.slice(0, path.lastIndexOf(segment));
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
 * The languages the old site prefixed its pages with. This site has no SDK
 * samples, so their pages fold onto the HTTP ones; Terraform keeps its view.
 */
const LANGUAGE_PREFIX = /^\/(typescript|python|go|node|terraform)(?=\/)/;

/**
 * Where the middleware sends an old Stainless URL: its page; its Markdown twin;
 * or its language variant's, with Terraform in its view (`?lang=terraform`).
 * `/operations/` pages had neither twins nor variants. `path` is
 * collection-relative; `lookup` is the plan's.
 */
export function stainlessRedirect(
  path: string,
  search: string,
  lookup: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const language = LANGUAGE_PREFIX.exec(path)?.[1];
  const terraform = language === 'terraform';
  let page = language ? path.slice(language.length + 1) : path;
  const markdown = page.endsWith('/index.md');
  if (markdown) page = page.slice(0, -'index.md'.length);
  if ((language || markdown) && page.startsWith('/operations/')) return undefined;
  // The old language homes are the only roots that aren't this site's own.
  const target = page === '/' ? (language ? '/' : undefined) : lookup[page];
  if (!target) return undefined;
  if (markdown) return `${target}index.md${search}`;
  if (!terraform) return `${target}${search}`;
  const params = new URLSearchParams(search);
  params.set('lang', 'terraform');
  return `${target}?${params}`;
}
