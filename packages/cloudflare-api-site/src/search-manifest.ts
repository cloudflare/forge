import { createHash } from 'node:crypto';
import { toPlainText } from './plain-text.ts';

const METADATA_LIMIT = 500;
const CONTENT_LIMIT = 3_000;
const UNIT_SEPARATOR = '\u001f';

export type SearchKind = 'resource' | 'http_method';

export interface SearchManifestRecord {
  sourceId: string;
  content: string;
  metadata: {
    kind: SearchKind;
    title: string;
    path: string;
    crumbs: string;
    detail: string;
  };
}

/** The site's search records: one per product, resource, and operation page. */
export interface SearchManifest {
  version: 2;
  records: SearchManifestRecord[];
}

/** The fields of a Nimbus API page (`getApiPageProps`) a record reads. */
export interface SearchPage {
  kind: string;
  /** Stable across builds: the operationId, or `tags.<tag>` for a section. */
  coordinate: string;
  /** The page's pathname below the site base, as Nimbus gives it. */
  href: string;
  title: string;
  description?: string;
  descriptionHtml?: string;
  breadcrumbs: ReadonlyArray<{ label: string; href: string }>;
  method?: string;
  path?: string;
}

function truncate(value: string, limit = METADATA_LIMIT): string {
  return [...value].slice(0, limit).join('');
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function encodeParts(required: string[], optional: string[] = []): string {
  const prefix = required.map(clean).join(UNIT_SEPARATOR);
  const suffix = optional.map(clean).join(UNIT_SEPARATOR);
  return truncate(suffix ? `${prefix}${UNIT_SEPARATOR}${suffix}` : prefix);
}

function plainDescription(page: SearchPage): string {
  if (page.descriptionHtml) return toPlainText(page.descriptionHtml);
  return page.description ? clean(page.description) : '';
}

/** A section's dotted name from its URL below the API root: `zero-trust.devices.ip-profiles`. */
function qualifiedName(href: string, rootHref: string): string {
  const relative = href.startsWith(rootHref) ? href.slice(rootHref.length) : href;
  return relative.split('/').filter(Boolean).join('.');
}

function record(page: SearchPage, rootHref: string, base: string): SearchManifestRecord | undefined {
  const kind: SearchKind | undefined =
    page.kind === 'operation' ? 'http_method' : page.kind === 'section' ? 'resource' : undefined;
  if (!kind) return undefined;

  const title = clean(page.title);
  const path = `${base.replace(/\/$/, '')}${page.href}`;
  if (!title) throw new Error(`search manifest: page "${page.coordinate}" has no title`);
  if (!path.startsWith('/') || !path.endsWith('/') || [...path].length > METADATA_LIMIT) {
    throw new Error(`search manifest: page "${page.coordinate}" has no usable path ("${path}")`);
  }

  const crumbs = [
    ...page.breadcrumbs.filter((crumb) => crumb.href !== rootHref).map((crumb) => clean(crumb.label)),
    title,
  ];
  const description = plainDescription(page);
  const lines: (string | undefined)[] = [title, crumbs.join(' > ')];
  let detail: string;
  if (kind === 'http_method') {
    const method = page.method ?? '';
    const endpoint = page.path ?? '';
    detail = encodeParts([method, endpoint], [description]);
    lines.push(`${method} ${endpoint}`, page.coordinate);
  } else {
    const name = qualifiedName(page.href, rootHref);
    detail = encodeParts([name]);
    lines.push(name);
  }
  lines.push(description);

  const hash = createHash('sha256').update(`${kind}${UNIT_SEPARATOR}${page.coordinate}`).digest('hex');
  return {
    sourceId: `${kind}-${hash}.md`,
    content: truncate([...new Set(lines.filter(Boolean))].join('\n'), CONTENT_LIMIT),
    metadata: {
      kind,
      title: truncate(title),
      path,
      crumbs: truncate(crumbs.join(UNIT_SEPARATOR)),
      detail,
    },
  };
}

/**
 * The search manifest for a version's API pages: a `resource` record per
 * product and resource page, an `http_method` record per operation page. The
 * API home's own breadcrumb is left out of `crumbs`, and each `path` is the
 * page's absolute pathname under the site's `base`.
 */
export function buildSearchManifest(pages: Iterable<SearchPage>, base = '/'): SearchManifest {
  const all = [...pages];
  const rootHref = all.find((page) => page.kind === 'api')?.href ?? '/';
  const records = all
    .map((page) => record(page, rootHref, base))
    .filter((entry) => entry !== undefined)
    .sort(
      (a, b) =>
        a.metadata.kind.localeCompare(b.metadata.kind) ||
        a.metadata.path.localeCompare(b.metadata.path) ||
        a.sourceId.localeCompare(b.sourceId),
    );
  return { version: 2, records };
}
