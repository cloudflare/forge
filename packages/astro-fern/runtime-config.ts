import { DEFAULT_FERN_CONTENT_COLLECTION } from './content-contract.ts';

/** How execution-target variants are addressed in human documentation URLs. */
export type FernTargetRouting = 'hash' | 'path';

/** The level covered by a generated `llms.txt` index. */
export type AgentScope = 'site' | 'product' | 'snapshot' | 'target';

/** Controls which package-owned Markdown and llms.txt routes are generated and mounted. */
export interface AstroFernAgentsOptions {
  /** Whether `astroFern()` injects the configured agent route handlers. */
  injectRoutes?: boolean;
  /** Whether per-operation Markdown routes are available. */
  markdown?: boolean;
  /** Which `llms.txt` indexes are available, or `false` for none. */
  llms?: false | { scopes?: AgentScope[] };
  /** Instruction prepended to operation Markdown, or `false` to omit it. */
  directive?: string | false;
}

/** Controls the public API mount and execution-target URL strategy. */
export interface AstroFernRoutingOptions {
  /** URL prefix for human pages and scoped agent routes. Defaults to `/api`. */
  base?: string;
  /** Whether execution-target variants use paths or URL hashes. */
  target?: FernTargetRouting;
}

/** Configuration owned exclusively by the Astro integration. */
export interface AstroFernIntegrationOptions {
  /** Name of the content collection registered with `fernCollection()`. Defaults to `apiReference`. */
  collection?: string;
  routing?: AstroFernRoutingOptions;
  agents?: AstroFernAgentsOptions;
}

/** Fully resolved integration configuration consumed by route composition at runtime. */
export interface FernRuntimeConfig {
  collection: string;
  routing: Required<AstroFernRoutingOptions>;
  agents: {
    injectRoutes: boolean;
    markdown: boolean;
    llms: false | { scopes: AgentScope[] };
    directive: string | false;
  };
}

const DEFAULT_DIRECTIVE =
  '> This page is optimized for agents. Use the linked Markdown pages and llms.txt indexes for related API content.';

export function normalizeBase(base: string | undefined): string {
  const value = base?.trim() || '/api';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

export function resolveAgents(agents?: AstroFernAgentsOptions): FernRuntimeConfig['agents'] {
  const scopes =
    agents?.llms === false ? false : { scopes: agents?.llms?.scopes ?? ['site', 'product', 'snapshot', 'target'] };
  if (scopes !== false && new Set(scopes.scopes).size !== scopes.scopes.length) {
    throw new Error('astro-fern: agent llms scopes must be unique');
  }
  return {
    injectRoutes: agents?.injectRoutes ?? true,
    markdown: agents?.markdown ?? true,
    llms: scopes,
    directive: agents?.directive === false ? false : (agents?.directive ?? DEFAULT_DIRECTIVE),
  };
}

export function resolveCollection(collection: string | undefined): string {
  if (collection === undefined) return DEFAULT_FERN_CONTENT_COLLECTION;
  if (collection.trim() === '' || collection.trim() !== collection) {
    throw new Error(
      `astro-fern: collection must be a non-empty name without surrounding whitespace, got "${collection}"`,
    );
  }
  return collection;
}

export function resolveRuntimeConfig(options: AstroFernIntegrationOptions): FernRuntimeConfig {
  return {
    collection: resolveCollection(options.collection),
    routing: {
      base: normalizeBase(options.routing?.base),
      target: options.routing?.target ?? 'hash',
    },
    agents: resolveAgents(options.agents),
  };
}

/** Joins a route pattern to a normalized Fern mount, including the root mount. */
export function mountPattern(base: string, pattern: string): string {
  return base === '/' ? pattern : `${base}${pattern}`;
}
