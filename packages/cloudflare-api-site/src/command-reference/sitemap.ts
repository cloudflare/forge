import { cfCommandCatalog } from './cf-commands.ts';
import { type CommandProductRoute, CommandRouter } from './routing.ts';

/** Absolute URLs of the command pages. They render on request, so the sitemap can't find them itself. */
export function commandPageUrls(site: string, base: string, products: readonly CommandProductRoute[]): string[] {
  const router = new CommandRouter(cfCommandCatalog, { base });
  const byId = new Map(products.map((product) => [product.id, product]));
  return router.commands.map(
    (command) => new URL(router.commandHref(command, byId.get(command.fullPath[0])), site).href,
  );
}
