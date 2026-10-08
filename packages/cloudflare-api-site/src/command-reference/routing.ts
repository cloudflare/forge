import type { CommandCatalog, CommandMetadata } from './schema.ts';

export const TOOLING_PRODUCT_ID = 'tooling';
const TOOLING_SEGMENT = 'tooling';

export interface CommandProductRoute {
  id: string;
  slug: string;
}

export interface CommandRoutingOptions {
  base: string;
}

function commandKey(fullPath: readonly string[]): string {
  return fullPath.join('\0');
}

function normalizePathname(pathname: string): string {
  const clean = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean || '/';
}

function toolingPath(base: string): string {
  const normalized = normalizePathname(base);
  return `${normalized === '/' ? '' : normalized}/${TOOLING_SEGMENT}`;
}

function decodeCommandPath(pathname: string, basePath: string): string[] | undefined {
  const normalized = normalizePathname(pathname);
  if (!normalized.startsWith(`${basePath}/`)) return undefined;
  const encodedPath = normalized.slice(basePath.length + 1);
  try {
    const fullPath = encodedPath.split('/').map((segment) => decodeURIComponent(segment));
    return commandPath({ fullPath }) === encodedPath ? fullPath : undefined;
  } catch {
    return undefined;
  }
}

export function commandPath(command: Pick<CommandMetadata, 'fullPath'>): string {
  return command.fullPath.map(encodeURIComponent).join('/');
}

export function assertToolingRouteNamespace(
  products: readonly {
    id: string;
    slug: string;
    snapshots?: readonly { pages: readonly { pathname: string }[] }[];
  }[],
  apiBase: string,
  commandBase: string,
): void {
  const toolingNamespace = toolingPath(commandBase);
  const conflict = products.find((product) => product.slug === TOOLING_SEGMENT);
  if (toolingPath(apiBase) === toolingNamespace && conflict) {
    throw new Error(`API product "${conflict.id}" conflicts with the ${toolingNamespace}/ route`);
  }
  if (normalizePathname(apiBase) !== normalizePathname(commandBase)) return;

  for (const product of products) {
    const productToolingPath = `${normalizePathname(apiBase)}/${product.slug}/${TOOLING_SEGMENT}`.replace('//', '/');
    const route = product.snapshots
      ?.flatMap((snapshot) => snapshot.pages)
      .find((page) => {
        const pathname = normalizePathname(page.pathname);
        return pathname === productToolingPath || pathname.startsWith(`${productToolingPath}/`);
      });
    if (route) throw new Error(`API route "${route.pathname}" conflicts with the ${productToolingPath}/ route`);
  }
}

export function commandTitle(command: Pick<CommandMetadata, 'name'>): string {
  return command.name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export class CommandRouter {
  readonly base: string;
  readonly commands: readonly CommandMetadata[];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly directoryHref: string;
  readonly #basePath: string;
  readonly #commandsByPath: Map<string, CommandMetadata>;

  constructor(catalog: CommandCatalog, routing: CommandRoutingOptions) {
    this.base = normalizePathname(routing.base);
    this.#basePath = toolingPath(this.base);
    this.directoryHref = `${this.#basePath}/`;
    this.commands = catalog.commands.filter((command) => command.hideCommand !== true);
    this.descriptions = catalog.descriptions;
    this.#commandsByPath = new Map(this.commands.map((command) => [commandKey(command.fullPath), command]));
  }

  commandHref(command: Pick<CommandMetadata, 'fullPath'>, product?: CommandProductRoute): string {
    if (product && command.fullPath[0] === product.id) {
      const productPath = `${this.base === '/' ? '' : this.base}/${product.slug}/${TOOLING_SEGMENT}`;
      const nestedPath = commandPath({ fullPath: command.fullPath.slice(1) });
      return `${productPath}${nestedPath ? `/${nestedPath}` : ''}/`;
    }
    return `${this.#basePath}/${commandPath(command)}/`;
  }

  commandsForProduct(productId: string): readonly CommandMetadata[] {
    return this.commands.filter((command) => command.fullPath[0] === productId);
  }

  resolve(url: URL | string, products: readonly CommandProductRoute[] = []): CommandMetadata | undefined {
    const pathname = typeof url === 'string' ? url : url.pathname;
    const normalizedPathname = normalizePathname(pathname);
    const fullPath = decodeCommandPath(pathname, this.#basePath);
    if (fullPath) {
      if (products.some((product) => product.id === fullPath[0])) return undefined;
      return this.#commandsByPath.get(commandKey(fullPath));
    }

    for (const product of products) {
      const productPath = `${this.base === '/' ? '' : this.base}/${product.slug}/${TOOLING_SEGMENT}`;
      if (normalizedPathname === productPath) return this.#commandsByPath.get(commandKey([product.id]));
      const nestedPath = decodeCommandPath(pathname, productPath);
      if (nestedPath) return this.#commandsByPath.get(commandKey([product.id, ...nestedPath]));
    }
    return undefined;
  }
}
