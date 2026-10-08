import type { SidebarItem } from '@cloudflare/nimbus-docs/types';
import type { ApiCatalogResource, ApiRouter } from './api-routing.ts';
import { type CommandProductRoute, type CommandRouter, commandTitle } from './command-reference/routing.ts';
import type { CommandMetadata } from './command-reference/schema.ts';

export type ForgeSidebarItem =
  | { label: string; link: string }
  | { label: string; items: ForgeSidebarItem[]; collapsed: boolean };

interface ProductSidebarItem {
  product: CommandProductRoute;
  item: ForgeSidebarItem;
}

const sidebarCache = new WeakMap<ApiRouter, Map<string, ProductSidebarItem[]>>();

function operationSidebarItem(
  router: ApiRouter,
  productId: string,
  snapshotId: string,
  page: ApiRouter['plan']['catalog']['products'][number]['snapshots'][number]['pages'][number],
  lang?: string,
): ForgeSidebarItem | undefined {
  const projectionId = page.placement?.projectionId;
  const link =
    router.operationHref(productId, snapshotId, page.operationId, 'human', lang, projectionId) ??
    router.operationHref(productId, snapshotId, page.operationId, 'human', undefined, projectionId);
  return link ? { label: page.title, link } : undefined;
}

function productSidebar(router: ApiRouter, snapshotId: string, lang?: string): ProductSidebarItem[] {
  let routerCache = sidebarCache.get(router);
  if (!routerCache) {
    routerCache = new Map();
    sidebarCache.set(router, routerCache);
  }
  const cacheKey = JSON.stringify([snapshotId, lang]);
  const cached = routerCache.get(cacheKey);
  if (cached) return cached;

  const sidebar = router.plan.catalog.products.flatMap((product) => {
    const snapshot = product.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot) return [];
    const sections = new Map<string, { id: string; title: string; items: ForgeSidebarItem[] }>();
    for (const page of snapshot.pages) {
      if (page.placement) continue;
      let section = sections.get(page.section.id);
      if (!section) {
        section = { id: page.section.id, title: page.section.title, items: [] };
        sections.set(page.section.id, section);
      }
      const item = operationSidebarItem(router, product.id, snapshot.id, page, lang);
      if (item) section.items.push(item);
    }
    const productLink =
      router.productHref(product.id, snapshot.id, lang) ?? router.productHref(product.id, snapshot.id);
    const sectionGroups = [...sections.values()].flatMap((section) => {
      const sectionLink =
        router.sectionHref(product.id, snapshot.id, section.id, lang) ??
        router.sectionHref(product.id, snapshot.id, section.id);
      const items = [...(sectionLink ? [{ label: 'Overview', link: sectionLink }] : []), ...section.items];
      return items.length > 0 ? [{ label: section.title, collapsed: true, items }] : [];
    });
    const resourceRoots = resourceSidebar(router, product.id, snapshot, lang);
    const directOperations = snapshot.pages.flatMap((page): ForgeSidebarItem[] => {
      if (!page.placement || page.placement.resourcePath.length > 0) return [];
      const item = operationSidebarItem(router, product.id, snapshot.id, page, lang);
      return item ? [item] : [];
    });
    return [
      {
        product: { id: product.id, slug: product.slug },
        item: {
          label: product.title,
          collapsed: true,
          items: [
            ...(productLink ? [{ label: 'Overview', link: productLink }] : []),
            ...directOperations,
            ...resourceRoots,
            ...sectionGroups,
          ],
        },
      },
    ];
  });
  routerCache.set(cacheKey, sidebar);
  return sidebar;
}

export function forgeSidebar(router: ApiRouter, snapshotId: string, lang?: string): ForgeSidebarItem[] {
  return productSidebar(router, snapshotId, lang).map(({ item }) => item);
}

function resourceSidebar(
  router: ApiRouter,
  productId: string,
  snapshot: ApiRouter['plan']['catalog']['products'][number]['snapshots'][number],
  lang?: string,
): ForgeSidebarItem[] {
  const roots = new Map<string, ApiCatalogResource>();
  for (const page of snapshot.pages) {
    const placement = page.placement;
    const first = placement?.resourcePath[0];
    if (!placement || !first) continue;
    let resource = roots.get(first.id);
    if (!resource) {
      resource = { ...first, key: '', path: [first], resources: [], operations: [] };
      roots.set(first.id, resource);
    }
    let current = resource;
    for (const segment of placement.resourcePath.slice(1)) {
      let child = current.resources.find((candidate) => candidate.id === segment.id);
      if (!child) {
        child = { ...segment, key: '', path: [...current.path, segment], resources: [], operations: [] };
        current.resources.push(child);
      }
      current = child;
    }
    current.operations.push(page);
  }

  function render(resource: ApiCatalogResource): ForgeSidebarItem {
    const overview =
      router.resourceHref(productId, snapshot.id, resource.path, lang) ??
      router.resourceHref(productId, snapshot.id, resource.path);
    const operations = resource.operations.flatMap((page): ForgeSidebarItem[] => {
      const item = operationSidebarItem(router, productId, snapshot.id, page, lang);
      return item ? [item] : [];
    });
    return {
      label: resource.title,
      collapsed: true,
      items: [
        ...(overview ? [{ label: 'Overview', link: overview }] : []),
        ...operations,
        ...resource.resources.map(render),
      ],
    };
  }

  return [...roots.values()].map(render);
}

function normalizePath(pathname: string): string {
  const clean = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

function toRouteEntry(item: ForgeSidebarItem, currentPath: string, order: number): SidebarItem {
  if ('link' in item) {
    return {
      type: 'link',
      label: item.label,
      href: item.link,
      isCurrent: normalizePath(item.link) === currentPath,
      order,
    };
  }

  return {
    type: 'group',
    label: item.label,
    children: item.items.map((entry, index) => toRouteEntry(entry, currentPath, index)),
    collapsed: item.collapsed,
    order,
  };
}

export function forgeRouteSidebar(
  router: ApiRouter,
  commandRouter: CommandRouter,
  snapshotId: string,
  lang: string | undefined,
  pathname: string,
): SidebarItem[] {
  const selectedSnapshotId = router.plan.catalog.snapshots.some((snapshot) => snapshot.id === snapshotId)
    ? snapshotId
    : (router.plan.catalog.snapshots.find((snapshot) => snapshot.default)?.id ?? snapshotId);
  const currentPath = normalizePath(pathname);
  const overviewLink =
    router.siteSnapshotHref(selectedSnapshotId, lang) ?? router.siteSnapshotHref(selectedSnapshotId) ?? router.siteHref;
  const products = productSidebar(router, selectedSnapshotId, lang);
  const allProducts = new Map(
    router.plan.catalog.products.map((product) => [product.id, { id: product.id, slug: product.slug }]),
  );
  const commands = commandSidebar(commandRouter, allProducts, new Set(products.map(({ product }) => product.id)));
  return [
    { label: 'Overview', link: overviewLink },
    { label: 'Developer Tooling', collapsed: true, items: commands.globalItems },
    ...products.map(({ product, item }) => {
      const productCommands = commands.productItems.get(product.id);
      if (!productCommands || !('items' in item)) return item;

      const overviewIndex = item.items.findIndex((entry) => 'link' in entry && entry.label === 'Overview');
      const insertIndex = overviewIndex + 1;
      return {
        ...item,
        items: [
          ...item.items.slice(0, insertIndex),
          { label: 'Developer Tooling', collapsed: true, items: productCommands },
          ...item.items.slice(insertIndex),
        ],
      };
    }),
  ].map((entry, index) => toRouteEntry(entry, currentPath, index));
}

interface CommandSidebarNode {
  name: string;
  command?: CommandMetadata;
  children: Map<string, CommandSidebarNode>;
}

interface CommandSidebarItems {
  globalItems: ForgeSidebarItem[];
  productItems: Map<string, ForgeSidebarItem[]>;
}

function commandSidebar(
  router: CommandRouter,
  products: ReadonlyMap<string, CommandProductRoute>,
  availableProductIds: ReadonlySet<string>,
): CommandSidebarItems {
  const roots = new Map<string, CommandSidebarNode>();

  for (const command of router.commands) {
    let siblings = roots;
    command.fullPath.forEach((name, index) => {
      let node = siblings.get(name);
      if (!node) {
        node = { name, children: new Map() };
        siblings.set(name, node);
      }
      if (index === command.fullPath.length - 1) node.command = command;
      siblings = node.children;
    });
  }

  function renderNode(node: CommandSidebarNode, product?: CommandProductRoute): ForgeSidebarItem {
    const children = [...node.children.values()].map((child) => renderNode(child, product));
    if (node.command && children.length === 0) {
      return { label: commandTitle(node.command), link: router.commandHref(node.command, product) };
    }

    return {
      label: commandTitle(node),
      collapsed: true,
      items: [
        ...(node.command ? [{ label: 'Overview', link: router.commandHref(node.command, product) }] : []),
        ...children,
      ],
    };
  }

  const globalItems: ForgeSidebarItem[] = [{ label: 'Overview', link: router.directoryHref }];
  const productItems = new Map<string, ForgeSidebarItem[]>();
  for (const root of roots.values()) {
    const product = products.get(root.name);
    if (!product || !availableProductIds.has(root.name)) {
      globalItems.push(renderNode(root, product));
      continue;
    }

    productItems.set(root.name, [
      ...(root.command ? [{ label: 'Overview', link: router.commandHref(root.command, product) }] : []),
      ...[...root.children.values()].map((child) => renderNode(child, product)),
    ]);
  }
  return { globalItems, productItems };
}
