import type {
  FernCatalogPage,
  FernCatalogProduct,
  FernCatalogSiteSnapshot,
  FernCatalogSnapshot,
  FernRoutePlan,
} from 'astro-fern';
import type { SemanticHrefRequest, SemanticHrefResolver, SemanticLlmsHrefRequest } from 'astro-fern/agents';

type RoutePlan = Pick<FernRoutePlan, 'catalog' | 'routing' | 'agents'>;

export interface ApiOperationSelection {
  kind: 'operation';
  pageId: string;
  pathname: string;
  product: FernCatalogProduct;
  snapshot: FernCatalogSnapshot;
  operation: FernCatalogPage;
  lang?: string;
}

export interface ApiCatalogSection {
  id: string;
  tag: string;
  title: string;
  operations: FernCatalogPage[];
}

type ApiResourceSegment = NonNullable<FernCatalogPage['placement']>['resourcePath'][number];

export interface ApiCatalogResource extends ApiResourceSegment {
  key: string;
  path: ApiResourceSegment[];
  resources: ApiCatalogResource[];
  operations: FernCatalogPage[];
}

export interface ApiProductSelection {
  kind: 'product';
  pathname: string;
  product: FernCatalogProduct;
  snapshot: FernCatalogSnapshot;
  sections: ApiCatalogSection[];
  resources: ApiCatalogResource[];
  operations: FernCatalogPage[];
  lang?: string;
}

export interface ApiSectionSelection {
  kind: 'section';
  pathname: string;
  product: FernCatalogProduct;
  snapshot: FernCatalogSnapshot;
  section: ApiCatalogSection;
  lang?: string;
}

export interface ApiResourceSelection {
  kind: 'resource';
  pathname: string;
  product: FernCatalogProduct;
  snapshot: FernCatalogSnapshot;
  resource: ApiCatalogResource;
  lang?: string;
}

export type ApiPageSelection = ApiProductSelection | ApiSectionSelection | ApiResourceSelection | ApiOperationSelection;

export interface ApiBreadcrumb {
  label: string;
  href?: string;
}

export interface ApiVersionOption {
  label: string;
  value: string;
  selected: boolean;
}

interface OperationLocation {
  pathname: string;
  product: FernCatalogProduct;
  snapshot: FernCatalogSnapshot;
  operation: FernCatalogPage;
}

interface SectionLocation {
  pathname: string;
  product: FernCatalogProduct;
  sectionId: string;
}

interface ResourceLocation {
  pathname: string;
  product: FernCatalogProduct;
  snapshots: Map<string, ApiCatalogResource>;
}

const INVALID = Symbol('invalid-query-parameter');

function normalizePath(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

function baseHref(base: string): string {
  const normalized = normalizePath(base);
  return normalized === '/' ? '/' : `${normalized}/`;
}

function parseSingleQueryValue(searchParams: URLSearchParams, name: string): string | undefined | typeof INVALID {
  const values = searchParams.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0] === '') return INVALID;
  return values[0];
}

function markdownPath(pathname: string): string {
  return `${pathname.replace(/\/$/, '')}.md`;
}

function withSelection(pathname: string, defaultSnapshotId: string, snapshotId: string, lang?: string): string {
  const search = new URLSearchParams();
  if (lang !== undefined) search.set('lang', lang);
  if (snapshotId !== defaultSnapshotId) search.set('version', snapshotId);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function hierarchyPath(base: string, ...segments: string[]): string {
  const prefix = normalizePath(base);
  return `${prefix === '/' ? '' : prefix}/${segments.map(encodeURIComponent).join('/')}/`;
}

function operationPath(base: string, productSlug: string, operationSlug: string): string {
  return hierarchyPath(base, productSlug, ...operationSlug.split('/').filter(Boolean));
}

function resourcePathname(base: string, productSlug: string, resourcePath: readonly ApiResourceSegment[]): string {
  return hierarchyPath(base, productSlug, ...resourcePath.map((resource) => resource.slug));
}

function resourceKey(path: readonly ApiResourceSegment[]): string {
  return path.map((segment) => `${segment.id.length}:${segment.id}`).join('');
}

function operationKey(operationId: string, projectionId = 'primary'): string {
  return `${operationId.length}:${operationId}${projectionId.length}:${projectionId}`;
}

function sectionsForSnapshot(snapshot: FernCatalogSnapshot): ApiCatalogSection[] {
  const sections = new Map<string, ApiCatalogSection>();
  for (const operation of snapshot.pages) {
    if (operation.placement) continue;
    let section = sections.get(operation.section.id);
    if (!section) {
      section = { ...operation.section, operations: [] };
      sections.set(section.id, section);
    }
    section.operations.push(operation);
  }
  return [...sections.values()];
}

function resourcesForSnapshot(snapshot: FernCatalogSnapshot): ApiCatalogResource[] {
  const roots: ApiCatalogResource[] = [];
  for (const operation of snapshot.pages) {
    const placement = operation.placement;
    if (!placement) continue;
    let siblings = roots;
    const path: ApiResourceSegment[] = [];
    let resource: ApiCatalogResource | undefined;
    for (const segment of placement.resourcePath) {
      path.push(segment);
      resource = siblings.find((candidate) => candidate.id === segment.id);
      if (!resource) {
        resource = { ...segment, key: resourceKey(path), path: [...path], resources: [], operations: [] };
        siblings.push(resource);
      }
      siblings = resource.resources;
    }
    resource?.operations.push(operation);
  }
  return roots;
}

function visitResources(resources: ApiCatalogResource[], visit: (resource: ApiCatalogResource) => void): void {
  for (const resource of resources) {
    visit(resource);
    visitResources(resource.resources, visit);
  }
}

function findResource(resources: ApiCatalogResource[], key: string): ApiCatalogResource | undefined {
  for (const resource of resources) {
    if (resource.key === key) return resource;
    const child = findResource(resource.resources, key);
    if (child) return child;
  }
  return undefined;
}

function resolveSelection(
  product: FernCatalogProduct,
  searchParams: URLSearchParams,
  defaultSnapshotId: string,
): { snapshot: FernCatalogSnapshot; lang?: string } | undefined {
  const snapshotValue = parseSingleQueryValue(searchParams, 'version');
  const langValue = parseSingleQueryValue(searchParams, 'lang');
  if (snapshotValue === INVALID || langValue === INVALID) return undefined;

  const snapshot =
    snapshotValue === undefined
      ? product.snapshots.find((candidate) => candidate.id === defaultSnapshotId)
      : product.snapshots.find((candidate) => candidate.id === snapshotValue);
  if (!snapshot) return undefined;
  if (langValue !== undefined && !snapshot.targets.some((target) => target.id === langValue)) return undefined;
  return { snapshot, ...(langValue !== undefined ? { lang: langValue } : {}) };
}

/** Resolves the docs site's query-selected global snapshot against sparse product catalogs. */
export class ApiRouter {
  readonly plan: RoutePlan;
  readonly resolveHref: SemanticHrefResolver;
  readonly siteHref: string;
  readonly #defaultSnapshotId: string;
  readonly #operationsByPath = new Map<string, Map<string, OperationLocation>>();
  readonly #operationsBySnapshot = new Map<FernCatalogSnapshot, Map<string, FernCatalogPage>>();
  readonly #productsByPath = new Map<string, FernCatalogProduct>();
  readonly #sectionsByPath = new Map<string, SectionLocation>();
  readonly #sectionsBySnapshot = new Map<FernCatalogSnapshot, ApiCatalogSection[]>();
  readonly #resourcesByPath = new Map<string, ResourceLocation>();
  readonly #resourcesBySnapshot = new Map<FernCatalogSnapshot, ApiCatalogResource[]>();
  readonly #products = new Map<string, FernCatalogProduct>();
  readonly #productsBySlug = new Map<string, FernCatalogProduct>();

  constructor(plan: RoutePlan, siteBase = '/') {
    this.plan = plan;
    this.siteHref = baseHref(siteBase);
    this.resolveHref = (request) => this.href(request);
    const defaultSnapshots = plan.catalog.snapshots.filter((snapshot) => snapshot.default);
    const defaultSnapshot = defaultSnapshots[0];
    if (defaultSnapshots.length !== 1 || !defaultSnapshot) {
      throw new Error(
        `docs-site: the global catalog has ${defaultSnapshots.length} default snapshots; configure exactly one default snapshot in the source config`,
      );
    }
    this.#defaultSnapshotId = defaultSnapshot.id;

    for (const product of plan.catalog.products) {
      this.#products.set(product.id, product);
      this.#productsBySlug.set(product.slug, product);
      for (const snapshot of product.snapshots) {
        this.#operationsBySnapshot.set(
          snapshot,
          new Map(snapshot.pages.map((page) => [operationKey(page.operationId, page.placement?.projectionId), page])),
        );
        this.#sectionsBySnapshot.set(snapshot, sectionsForSnapshot(snapshot));
        const resources = resourcesForSnapshot(snapshot);
        this.#resourcesBySnapshot.set(snapshot, resources);
        for (const section of this.#sectionsBySnapshot.get(snapshot) ?? []) {
          const pathname = hierarchyPath(plan.routing.base, product.slug, 'sections', section.id);
          this.#sectionsByPath.set(normalizePath(pathname), { pathname, product, sectionId: section.id });
        }
        visitResources(resources, (resource) => {
          const pathname = resourcePathname(plan.routing.base, product.slug, resource.path);
          const normalized = normalizePath(pathname);
          let location = this.#resourcesByPath.get(normalized);
          if (!location) {
            location = { pathname, product, snapshots: new Map() };
            this.#resourcesByPath.set(normalized, location);
          }
          location.snapshots.set(snapshot.id, resource);
        });
        for (const operation of snapshot.pages) {
          const pathname = operationPath(plan.routing.base, product.slug, operation.slug);
          const normalized = normalizePath(pathname);
          const resource = this.#resourcesByPath.get(normalized)?.snapshots.get(snapshot.id);
          if (resource) {
            throw new Error(
              `docs-site: snapshot "${snapshot.id}" maps SDK resource "${resource.path.map((segment) => segment.id).join('.')}" and operation "${operation.operationId}" to "${pathname}"; rename the resource because "methods" is reserved between SDK resources and method names`,
            );
          }
          let snapshots = this.#operationsByPath.get(normalized);
          if (!snapshots) {
            snapshots = new Map();
            this.#operationsByPath.set(normalized, snapshots);
          }
          if (snapshots.has(snapshot.id)) {
            throw new Error(
              `docs-site: snapshot "${snapshot.id}" maps more than one operation to "${pathname}"; give the operations distinct OpenAPI operationIds or source config section IDs so their slugs differ`,
            );
          }
          snapshots.set(snapshot.id, { pathname, product, snapshot, operation });
        }
      }
      const productPathname = hierarchyPath(plan.routing.base, product.slug);
      this.#productsByPath.set(normalizePath(productPathname), product);
    }
  }

  /** Resolves an operation only when the requested path is its selected snapshot's own slug. */
  resolveOperation(url: URL, representation: 'human' | 'markdown' = 'human'): ApiOperationSelection | undefined {
    if (representation === 'markdown' && !url.pathname.endsWith('.md')) return undefined;
    const requestPath = representation === 'markdown' ? url.pathname.slice(0, -3) : url.pathname;
    const snapshotValue = parseSingleQueryValue(url.searchParams, 'version');
    if (snapshotValue === INVALID) return undefined;
    const snapshotId = snapshotValue ?? this.#defaultSnapshotId;
    const location = this.#operationsByPath.get(normalizePath(requestPath))?.get(snapshotId);
    if (!location) return undefined;

    const selection = resolveSelection(location.product, url.searchParams, this.#defaultSnapshotId);
    if (!selection) return undefined;
    return {
      kind: 'operation',
      pageId: location.operation.id,
      pathname: location.pathname,
      product: location.product,
      snapshot: selection.snapshot,
      operation: location.operation,
      ...(selection.lang !== undefined ? { lang: selection.lang } : {}),
    };
  }

  resolvePage(url: URL): ApiPageSelection | undefined {
    const operation = this.resolveOperation(url);
    if (operation) return operation;

    const pathname = normalizePath(url.pathname);
    const product = this.#productsByPath.get(pathname);
    if (product) {
      const selection = resolveSelection(product, url.searchParams, this.#defaultSnapshotId);
      if (!selection) return undefined;
      return {
        kind: 'product',
        pathname: hierarchyPath(this.plan.routing.base, product.slug),
        product,
        snapshot: selection.snapshot,
        sections: this.pageSections(selection.snapshot),
        resources: this.pageResources(selection.snapshot),
        operations: selection.snapshot.pages.filter(
          (page) => page.placement !== undefined && page.placement.resourcePath.length === 0,
        ),
        ...(selection.lang !== undefined ? { lang: selection.lang } : {}),
      };
    }

    const sectionLocation = this.#sectionsByPath.get(pathname);
    if (sectionLocation) {
      const selection = resolveSelection(sectionLocation.product, url.searchParams, this.#defaultSnapshotId);
      if (!selection) return undefined;
      const section = this.pageSections(selection.snapshot).find(
        (candidate) => candidate.id === sectionLocation.sectionId,
      );
      if (!section) return undefined;
      return {
        kind: 'section',
        pathname: sectionLocation.pathname,
        product: sectionLocation.product,
        snapshot: selection.snapshot,
        section,
        ...(selection.lang !== undefined ? { lang: selection.lang } : {}),
      };
    }

    const resourceLocation = this.#resourcesByPath.get(pathname);
    if (!resourceLocation) return undefined;
    const selection = resolveSelection(resourceLocation.product, url.searchParams, this.#defaultSnapshotId);
    if (!selection) return undefined;
    const resource = resourceLocation.snapshots.get(selection.snapshot.id);
    if (!resource) return undefined;
    return {
      kind: 'resource',
      pathname: resourceLocation.pathname,
      product: resourceLocation.product,
      snapshot: selection.snapshot,
      resource,
      ...(selection.lang !== undefined ? { lang: selection.lang } : {}),
    };
  }

  resolveSiteSelection(url: URL): { snapshot: FernCatalogSiteSnapshot; lang?: string } | undefined {
    const snapshotValue = parseSingleQueryValue(url.searchParams, 'version');
    const langValue = parseSingleQueryValue(url.searchParams, 'lang');
    if (snapshotValue === INVALID || langValue === INVALID) return undefined;
    const snapshot = this.plan.catalog.snapshots.find(
      (candidate) => candidate.id === (snapshotValue ?? this.#defaultSnapshotId),
    );
    if (!snapshot) return undefined;
    if (langValue !== undefined && !snapshot.targets.some((target) => target.id === langValue)) return undefined;
    return { snapshot, ...(langValue !== undefined ? { lang: langValue } : {}) };
  }

  isSitePath(pathname: string): boolean {
    return normalizePath(pathname) === normalizePath(this.siteHref);
  }

  resolveSiteSnapshot(url: URL): FernCatalogSiteSnapshot | undefined {
    return this.resolveSiteSelection(url)?.snapshot;
  }

  siteSnapshotHref(snapshotId: string, lang?: string): string | undefined {
    const snapshot = this.plan.catalog.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot || (lang !== undefined && !snapshot.targets.some((target) => target.id === lang))) {
      return undefined;
    }
    return withSelection(this.siteHref, this.#defaultSnapshotId, snapshotId, lang);
  }

  siteSnapshotOptions(url: URL): ApiVersionOption[] {
    const selected = this.resolveSiteSelection(url);
    if (!selected) return [];
    return this.plan.catalog.snapshots.map((snapshot) => ({
      label: snapshot.label,
      value:
        this.siteSnapshotHref(snapshot.id, selected.lang) ??
        withSelection(this.siteHref, this.#defaultSnapshotId, snapshot.id),
      selected: snapshot.id === selected.snapshot.id,
    }));
  }

  resolveLlms(productSlug: string, searchParams: URLSearchParams): SemanticLlmsHrefRequest | undefined {
    const product = this.#productsBySlug.get(productSlug);
    if (!product) return undefined;
    const snapshotValue = parseSingleQueryValue(searchParams, 'version');
    const langValue = parseSingleQueryValue(searchParams, 'lang');
    if (snapshotValue === INVALID || langValue === INVALID) return undefined;

    const snapshot =
      snapshotValue === undefined
        ? product.snapshots.find((candidate) => candidate.id === this.#defaultSnapshotId)
        : product.snapshots.find((candidate) => candidate.id === snapshotValue);
    if (!snapshot) return undefined;
    if (langValue !== undefined) {
      if (!snapshot.targets.some((target) => target.id === langValue)) return undefined;
      return {
        kind: 'llms',
        scope: 'target',
        productId: product.id,
        snapshotId: snapshot.id,
        targetId: langValue,
      };
    }
    return snapshot.id === this.#defaultSnapshotId
      ? { kind: 'llms', scope: 'product', productId: product.id }
      : { kind: 'llms', scope: 'snapshot', productId: product.id, snapshotId: snapshot.id };
  }

  /** Returns only snapshots containing the selected product, section, or semantic operation. */
  snapshotOptions(selection: ApiPageSelection): ApiVersionOption[] {
    return selection.product.snapshots.flatMap((snapshot) => {
      const value = this.pageHref(selection, snapshot.id, selection.lang) ?? this.pageHref(selection, snapshot.id);
      return value ? [{ label: snapshot.label, value, selected: snapshot.id === selection.snapshot.id }] : [];
    });
  }

  productHref(productId: string, snapshotId: string, lang?: string): string | undefined {
    const product = this.#products.get(productId);
    if (!product) return undefined;
    const snapshot = product.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot || (lang !== undefined && !snapshot.targets.some((target) => target.id === lang))) return undefined;
    return withSelection(
      hierarchyPath(this.plan.routing.base, product.slug),
      this.#defaultSnapshotId,
      snapshot.id,
      lang,
    );
  }

  sectionHref(productId: string, snapshotId: string, sectionId: string, lang?: string): string | undefined {
    const product = this.#products.get(productId);
    if (!product) return undefined;
    const snapshot = product.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot || (lang !== undefined && !snapshot.targets.some((target) => target.id === lang))) return undefined;
    if (!this.pageSections(snapshot).some((candidate) => candidate.id === sectionId)) return undefined;
    const pathname = hierarchyPath(this.plan.routing.base, product.slug, 'sections', sectionId);
    return withSelection(pathname, this.#defaultSnapshotId, snapshot.id, lang);
  }

  resourceHref(
    productId: string,
    snapshotId: string,
    path: readonly ApiResourceSegment[],
    lang?: string,
  ): string | undefined {
    const product = this.#products.get(productId);
    if (!product) return undefined;
    const snapshot = product.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot || (lang !== undefined && !snapshot.targets.some((target) => target.id === lang))) return undefined;
    if (!findResource(this.pageResources(snapshot), resourceKey(path))) return undefined;
    return withSelection(
      resourcePathname(this.plan.routing.base, product.slug, path),
      this.#defaultSnapshotId,
      snapshot.id,
      lang,
    );
  }

  operationHref(
    productId: string,
    snapshotId: string,
    operationId: string,
    representation: 'human' | 'markdown',
    lang?: string,
    projectionId = 'primary',
  ): string | undefined {
    const product = this.#products.get(productId);
    if (!product) return undefined;
    const snapshot = product.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot || (lang !== undefined && !snapshot.targets.some((target) => target.id === lang))) return undefined;
    const operation = this.#operationsBySnapshot.get(snapshot)?.get(operationKey(operationId, projectionId));
    if (!operation) return undefined;
    const pathname = operationPath(this.plan.routing.base, product.slug, operation.slug);
    return withSelection(
      representation === 'markdown' ? markdownPath(pathname) : pathname,
      this.#defaultSnapshotId,
      snapshot.id,
      lang,
    );
  }

  breadcrumbs(selection: ApiPageSelection): ApiBreadcrumb[] {
    const productHref = this.productHref(selection.product.id, selection.snapshot.id, selection.lang);
    const siteHref =
      this.siteSnapshotHref(selection.snapshot.id, selection.lang) ??
      this.siteSnapshotHref(selection.snapshot.id) ??
      this.siteHref;
    const breadcrumbs: ApiBreadcrumb[] = [
      { label: 'API Reference', href: siteHref },
      { label: selection.product.title, ...(productHref ? { href: productHref } : {}) },
    ];
    if (selection.kind === 'product')
      return breadcrumbs.map((item, index) => (index === breadcrumbs.length - 1 ? { label: item.label } : item));

    const resourcePath =
      selection.kind === 'resource'
        ? selection.resource.path
        : selection.kind === 'operation'
          ? selection.operation.placement?.resourcePath
          : undefined;
    if (resourcePath) {
      resourcePath.forEach((resource, index) => {
        const path = resourcePath.slice(0, index + 1);
        const href = this.resourceHref(selection.product.id, selection.snapshot.id, path, selection.lang);
        const current = selection.kind === 'resource' && index === resourcePath.length - 1;
        breadcrumbs.push({ label: resource.title, ...(!current && href ? { href } : {}) });
      });
      if (selection.kind === 'operation') breadcrumbs.push({ label: selection.operation.title });
      return breadcrumbs;
    }
    if (selection.kind === 'resource') return breadcrumbs;

    const section = selection.kind === 'section' ? selection.section : selection.operation.section;
    const sectionHref = this.sectionHref(selection.product.id, selection.snapshot.id, section.id, selection.lang);
    breadcrumbs.push({ label: section.title, ...(sectionHref ? { href: sectionHref } : {}) });
    if (selection.kind === 'operation') breadcrumbs.push({ label: selection.operation.title });
    else breadcrumbs[breadcrumbs.length - 1] = { label: section.title };
    return breadcrumbs;
  }

  private pageHref(selection: ApiPageSelection, snapshotId: string, lang?: string): string | undefined {
    if (selection.kind === 'product') return this.productHref(selection.product.id, snapshotId, lang);
    if (selection.kind === 'section') {
      return this.sectionHref(selection.product.id, snapshotId, selection.section.id, lang);
    }
    if (selection.kind === 'resource') {
      return this.resourceHref(selection.product.id, snapshotId, selection.resource.path, lang);
    }
    return this.operationHref(
      selection.product.id,
      snapshotId,
      selection.operation.operationId,
      'human',
      lang,
      selection.operation.placement?.projectionId,
    );
  }

  private pageSections(snapshot: FernCatalogSnapshot): ApiCatalogSection[] {
    return this.#sectionsBySnapshot.get(snapshot) ?? [];
  }

  private pageResources(snapshot: FernCatalogSnapshot): ApiCatalogResource[] {
    return this.#resourcesBySnapshot.get(snapshot) ?? [];
  }

  href(request: SemanticHrefRequest): string | undefined {
    if (request.kind === 'operation') {
      return this.operationHref(
        request.productId,
        request.snapshotId,
        request.operationId,
        request.representation,
        request.targetId,
        request.projectionId,
      );
    }
    if (request.scope === 'site') return `${this.siteHref}llms.txt`;
    const product = this.#products.get(request.productId);
    if (!product) return undefined;
    const pathname = `${hierarchyPath(this.plan.routing.base, product.slug)}llms.txt`;
    if (request.scope === 'product') {
      return product.snapshots.some((snapshot) => snapshot.id === this.#defaultSnapshotId) ? pathname : undefined;
    }
    const snapshot = product.snapshots.find((candidate) => candidate.id === request.snapshotId);
    if (!snapshot) return undefined;
    if (request.scope === 'snapshot') {
      return withSelection(pathname, this.#defaultSnapshotId, request.snapshotId);
    }
    if (!snapshot.targets.some((target) => target.id === request.targetId)) return undefined;
    return withSelection(pathname, this.#defaultSnapshotId, request.snapshotId, request.targetId);
  }
}
