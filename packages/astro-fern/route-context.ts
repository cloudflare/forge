/**
 * Per-page routing context derived from a built {@link FernProjectData}. This is
 * the data behind a snapshot switcher: given the pathname currently being
 * rendered, it resolves which product/snapshot/operation the page belongs to and
 * the sibling URL for that same operation in every available product snapshot.
 *
 * The builder is pure (no `astro:content`, no globals) so it is unit-testable in
 * isolation; `server.ts` binds it to the live project meta as
 * `getFernRouteContext`, and the middleware exposes the result as
 * `Astro.locals.fern`.
 */
import type { FernProjectData } from './route-plan.ts';

/**
 * One entry in a snapshot switcher: a configured snapshot paired with the URL of
 * the current operation within it. Produced by {@link buildSnapshotSwitch}; the
 * entry whose {@link SnapshotSwitchOption.current} is `true` is the snapshot of the
 * page being rendered.
 */
export interface SnapshotSwitchOption {
  /** Canonical snapshot id configured for this project. */
  id: string;
  /** Human-facing display label for the snapshot, as resolved by the engine. */
  label: string;
  /**
   * Absolute pathname of the same operation in this snapshot. Built from the
   * snapshot's URL slug (never its id, which may differ), and — when the current
   * route is a per-target variant — the same execution target is preserved.
   */
  href: string;
  /** `true` for the snapshot of the page currently being rendered. */
  current: boolean;
  /** `true` for the org-wide default snapshot, which is served unprefixed under the routing base. */
  default: boolean;
}

/**
 * Per-page routing/snapshot context for a single rendered pathname. Exposed to
 * renderers as `Astro.locals.fern` (populated by astro-fern's middleware) and
 * returned by {@link buildSnapshotSwitch} and `getFernRouteContext`.
 *
 * `product`, `snapshot`, and `operationId` identify the operation the pathname
 * resolves to and are all absent together when the pathname is not a known
 * operation page (a landing page, an agent route, an unknown URL). `snapshots`
 * backs a snapshot switcher.
 */
export interface FernRouteContext {
  /** Id of the product the current page belongs to; `undefined` for a non-operation route. */
  product?: string;
  /** Canonical id of the current page's snapshot; `undefined` for a non-operation route. */
  snapshot?: string;
  /** Id of the operation the current page renders; `undefined` for a non-operation route. */
  operationId?: string;
  /**
   * Id of the current execution target when the rendered pathname is a per-target
   * variant (path target routing); `undefined` on the canonical page and on
   * non-operation routes. Lets consumers keep the same target when re-pointing
   * links across the page (e.g. a snapshot- and target-aware sidebar).
   */
  target?: string;
  /**
   * The current operation across every product snapshot where it exists, in configured order.
   * Empty for routes that do not resolve to an operation. A switcher is normally
   * only worth rendering when this holds two or more entries (a single-snapshot
   * site yields exactly one).
   */
  snapshots: SnapshotSwitchOption[];
}

const EMPTY: FernRouteContext = { snapshots: [] };

/** Strip query/hash and a trailing slash so build- and request-time paths compare equal. */
function normalizePath(pathname: string): string {
  const clean = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/**
 * Resolve the {@link FernRouteContext} for `pathname` from a built project's
 * catalog and human route table. Matches the pathname against a human route
 * (canonical or per-target), locates the owning product/snapshot, and maps the
 * operation across every available product snapshot, preserving the execution
 * target when the matched route is a target variant. Snapshots in which the
 * product or operation does not exist are omitted.
 */
export function buildSnapshotSwitch(
  data: Pick<FernProjectData, 'catalog' | 'humanRoutes'>,
  pathname: string,
): FernRouteContext {
  const normalized = normalizePath(pathname);
  const route = data.humanRoutes.find((candidate) => normalizePath(candidate.pathname) === normalized);
  if (!route) return EMPTY;

  for (const product of data.catalog.products) {
    for (const snapshot of product.snapshots) {
      const currentPage = snapshot.pages.find((page) => page.id === route.pageId);
      if (!currentPage) continue;
      const { entryId, operationId } = currentPage;
      const snapshots = product.snapshots
        .map((candidate): SnapshotSwitchOption | undefined => {
          const canonical = candidate.pages.find((page) => page.entryId === entryId);
          if (!canonical) return undefined;
          // Preserve the execution target across the switch when the matched
          // route is a per-target variant (path target routing).
          const href = route.target
            ? (data.humanRoutes.find((entry) => entry.pageId === canonical.id && entry.target === route.target)
                ?.pathname ?? canonical.pathname)
            : canonical.pathname;
          return {
            id: candidate.id,
            label: candidate.label,
            href,
            current: candidate.id === snapshot.id,
            default: candidate.default,
          };
        })
        .filter((option): option is SnapshotSwitchOption => option !== undefined);
      return {
        product: product.id,
        snapshot: snapshot.id,
        operationId,
        ...(route.target ? { target: route.target } : {}),
        snapshots,
      };
    }
  }
  return EMPTY;
}
