import type { FernCatalogPage, FernRoutePlan } from 'astro-fern';

type Catalog = FernRoutePlan['catalog'];

/** Projection ID prefix `fern-forge` gives `x-forge-aliases` entries. */
const FORGE_ALIAS_PROJECTION_PREFIX = 'forge:alias:';

function isForgeAlias(page: FernCatalogPage): boolean {
  return page.placement?.projectionId.startsWith(FORGE_ALIAS_PROJECTION_PREFIX) ?? false;
}

/**
 * Removes Forge alias pages from the catalog, so the site documents each
 * operation once, at its primary SDK address. An alias such as
 * `o11y.shared-queries.get` repeats `observability.shared-queries.get`;
 * keeping it would publish a second page for the same operation. Products
 * left without pages, such as `o11y`, are removed too.
 *
 * An alias stays when its operation has no primary page in that snapshot,
 * for example after the primary lost a route collision, so that the operation
 * is still documented.
 */
export function withoutForgeAliases(catalog: Catalog): Catalog {
  const primaries = new Map<string, Set<string>>();
  for (const product of catalog.products) {
    for (const snapshot of product.snapshots) {
      let ids = primaries.get(snapshot.id);
      if (!ids) {
        ids = new Set();
        primaries.set(snapshot.id, ids);
      }
      for (const page of snapshot.pages) {
        if (!isForgeAlias(page)) ids.add(page.operationId);
      }
    }
  }

  const products = catalog.products.flatMap((product) => {
    const snapshots = product.snapshots.flatMap((snapshot) => {
      const ids = primaries.get(snapshot.id);
      const pages = snapshot.pages.filter((page) => !isForgeAlias(page) || !ids?.has(page.operationId));
      if (pages.length === 0 && snapshot.pages.length > 0) return [];
      return [pages.length === snapshot.pages.length ? snapshot : { ...snapshot, pages }];
    });
    if (snapshots.length === 0 && product.snapshots.length > 0) return [];
    return [{ ...product, snapshots }];
  });
  return { ...catalog, products };
}
