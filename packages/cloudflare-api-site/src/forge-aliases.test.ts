import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FernCatalogPage, FernCatalogProduct, FernRoutePlan } from 'astro-fern';
import { withoutForgeAliases } from './forge-aliases.ts';

function page(product: string, method: string, projectionId: string): FernCatalogPage {
  return {
    id: `page:${product}:${method}`,
    entryId: `operation:shared.query.${method}:${projectionId}`,
    operationId: `shared.query.${method}`,
    slug: `shared-queries/methods/${method}`,
    pathname: `/api/${product}/shared-queries/methods/${method}/`,
    placement: {
      projectionId,
      resourcePath: [{ id: 'shared-queries', slug: 'shared-queries', title: 'Shared Queries' }],
      method: { id: method, slug: method },
    },
    section: { id: 'shared', tag: 'Shared', title: 'Shared' },
    title: `${method} shared query`,
    description: '',
    httpMethod: 'get',
  };
}

function product(id: string, pages: FernCatalogPage[]): FernCatalogProduct {
  return {
    id,
    slug: id,
    title: id,
    description: '',
    snapshots: [{ id: 'current', slug: 'current', label: 'Current', default: true, targets: [], pages }],
  };
}

function catalog(products: FernCatalogProduct[]): FernRoutePlan['catalog'] {
  return {
    snapshots: [{ id: 'current', slug: 'current', label: 'Current', default: true, targets: [] }],
    products,
  };
}

function pageIds(result: FernRoutePlan['catalog']): Record<string, string[]> {
  return Object.fromEntries(
    result.products.map((item) => [item.id, item.snapshots.flatMap((snapshot) => snapshot.pages.map((p) => p.id))]),
  );
}

test('removes alias pages and products left without pages', () => {
  const result = withoutForgeAliases(
    catalog([
      product('observability', [page('observability', 'get', 'primary')]),
      product('o11y', [page('o11y', 'get', 'forge:alias:o11y.shared-queries/get')]),
    ]),
  );
  assert.deepEqual(pageIds(result), { observability: ['page:observability:get'] });
});

test('keeps a product that still has primary pages after its aliases are removed', () => {
  const result = withoutForgeAliases(
    catalog([
      product('observability', [page('observability', 'get', 'primary')]),
      product('o11y', [page('o11y', 'get', 'forge:alias:o11y.shared-queries/get'), page('o11y', 'list', 'primary')]),
    ]),
  );
  assert.deepEqual(pageIds(result), {
    observability: ['page:observability:get'],
    o11y: ['page:o11y:list'],
  });
});

test('keeps an alias page when its operation has no primary page', () => {
  const result = withoutForgeAliases(
    catalog([product('o11y', [page('o11y', 'get', 'forge:alias:o11y.shared-queries/get')])]),
  );
  assert.deepEqual(pageIds(result), { o11y: ['page:o11y:get'] });
});
