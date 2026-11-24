/**
 * Turns the Stainless docs site's HTTP SDK JSON, the spec it was built from and its model
 * redirects into the site's redirects snapshot (`stainless-redirects.json`). Offline and pure:
 * `./gitlab.ts` fetches the inputs.
 */

/** The part of the HTTP `@stainless/sdk-json` spec this generator reads. */
export interface RedirectsSdkJson {
  resources: Record<string, SdkResource>;
}

interface SdkResource {
  /** Where the Stainless config declares the resource, which is its page: `#/resources/zones`. */
  configRef: string;
  methods?: Record<string, SdkMethod>;
  subresources?: Record<string, SdkResource>;
}

interface SdkMethod {
  /** The method's page: `#/resources/zones/methods/list`. */
  configRef: string;
  /** The operation in the spec: `#/paths/%2Fzones/get`. */
  oasRef: string;
  /** `get /zones`. */
  endpoint: string;
}

interface Spec {
  paths: Record<string, Record<string, unknown> | undefined>;
}

/** The site's `stainless-redirects.json`: the old pages, collection-relative, and every operationId. */
export interface RedirectsSnapshot {
  resources: string[];
  methods: Record<string, string>;
  models: string[];
  operations: string[];
}

export function buildRedirectsSnapshot(input: {
  sdkJson: RedirectsSdkJson;
  spec: Spec;
  modelRedirects: Record<string, unknown>;
}): RedirectsSnapshot {
  const byEndpoint = endpointIndex(input.spec);
  const resources: string[] = [];
  const methods: Record<string, string> = {};
  const unresolved: string[] = [];
  const visit = (resource: SdkResource) => {
    resources.push(page(resource.configRef));
    for (const method of Object.values(resource.methods ?? {})) {
      const operationId = operationIdAt(input.spec, method.oasRef) ?? expandedOperationId(byEndpoint, method.endpoint);
      if (operationId) {
        methods[page(method.configRef)] = operationId;
      } else {
        unresolved.push(`${page(method.configRef)} (${method.endpoint})`);
      }
    }
    for (const child of Object.values(resource.subresources ?? {})) {
      visit(child);
    }
  };
  for (const resource of Object.values(input.sdkJson.resources)) {
    visit(resource);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} old method pages have no operation in the spec they were built from:\n  ${unresolved.join('\n  ')}\n` +
        "Their oasRef doesn't resolve, and their endpoint matches no path. If Stainless templates the paths in a new " +
        'way, teach expandedOperationId in scripts/redirects.ts to expand it, as it does {accounts_or_zones}.',
    );
  }

  const operations = new Set<string>();
  for (const item of Object.values(input.spec.paths)) {
    for (const operation of Object.values(item ?? {})) {
      const id = (operation as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') {
        operations.add(id);
      }
    }
  }
  return {
    resources: resources.sort(),
    methods: Object.fromEntries(Object.entries(methods).sort(([a], [b]) => a.localeCompare(b))),
    // The old site redirected each model page to its resource: the HTTP ones are its pages here.
    models: Object.keys(input.modelRedirects)
      .filter((path) => path.startsWith('/resources/'))
      .map((path) => `${path.replace(/\/$/, '')}/`)
      .sort(),
    operations: [...operations].sort(),
  };
}

/** `#/resources/zones/methods/list` → `/resources/zones/methods/list/`. */
function page(configRef: string): string {
  return `${configRef.slice(1)}/`;
}

/** `get /zones/{zone_id}` → `get /zones/{}`, so paths match whatever their parameters are named. */
function endpointKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '')}`;
}

/** Every operation in the spec by its endpoint key. */
function endpointIndex(spec: Spec): Map<string, string> {
  const index = new Map<string, string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      const id = (operation as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') {
        index.set(endpointKey(method, path), id);
      }
    }
  }
  return index;
}

/**
 * The operation behind an endpoint Stainless templated: `{accounts_or_zones}/{account_or_zone_id}`
 * stands for both an account path and a zone path, and the account one leads.
 */
function expandedOperationId(index: Map<string, string>, endpoint: string): string | undefined {
  const [method = '', path = ''] = endpoint.trim().split(/\s+/);
  if (!path.includes('{accounts_or_zones}')) {
    return undefined;
  }
  for (const kind of ['accounts', 'zones']) {
    const id = index.get(endpointKey(method, path.replace(/\{accounts_or_zones\}\/\{[^}]+\}/, `${kind}/{}`)));
    if (id) {
      return id;
    }
  }
  return undefined;
}

/** The operationId at a JSON pointer into the spec, such as `#/paths/%2Fzones/get`. */
function operationIdAt(spec: Spec, pointer: string): string | undefined {
  let node: unknown = spec;
  for (const segment of pointer.replace(/^#\//, '').split('/')) {
    const key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  const id = (node as { operationId?: unknown } | undefined)?.operationId;
  return typeof id === 'string' ? id : undefined;
}

export interface SnapshotChanges {
  /** Pages and operationIds in the new snapshot only, each prefixed with its kind. */
  added: string[];
  /** Pages and operationIds in the previous snapshot only. */
  removed: string[];
  /** Method pages in both whose operationId changed. */
  remapped: string[];
}

/** What a run changes against the previous snapshot, to review before committing it. */
export function compareSnapshots(previous: RedirectsSnapshot, next: RedirectsSnapshot): SnapshotChanges {
  const entries = (snapshot: RedirectsSnapshot) =>
    new Set([
      ...snapshot.resources.map((path) => `resource ${path}`),
      ...Object.keys(snapshot.methods).map((path) => `method ${path}`),
      ...snapshot.models.map((path) => `model ${path}`),
      ...snapshot.operations.map((id) => `operation ${id}`),
    ]);
  const before = entries(previous);
  const after = entries(next);
  return {
    added: [...after].filter((entry) => !before.has(entry)).sort(),
    removed: [...before].filter((entry) => !after.has(entry)).sort(),
    remapped: Object.entries(next.methods)
      .filter(([path, id]) => previous.methods[path] !== undefined && previous.methods[path] !== id)
      .map(([path, id]) => `${path}: ${previous.methods[path]} → ${id}`)
      .sort(),
  };
}
