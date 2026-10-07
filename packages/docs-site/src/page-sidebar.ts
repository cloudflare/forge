import { stripBase } from '@cloudflare/nimbus-docs/runtime';
import type { SidebarItem } from '@cloudflare/nimbus-docs/types';
import { getApiRouter } from './api-server.ts';
import { getCommandRouter } from './command-reference/server.ts';
import { forgeRouteSidebar } from './sidebar.ts';

/** Nimbus sidebar components add the deployment base, so items carry unbased paths. */
function unbased(items: SidebarItem[]): SidebarItem[] {
  return items.map((item) =>
    item.type === 'group'
      ? { ...item, children: unbased(item.children) }
      : item.type === 'link'
        ? { ...item, href: stripBase(item.href, import.meta.env.BASE_URL) }
        : item,
  );
}

/** Builds the request-scoped sidebar for the API version and execution target selected by `url`. */
export async function getPageSidebar(url: URL): Promise<SidebarItem[]> {
  const [router, commandRouter] = await Promise.all([getApiRouter(), getCommandRouter()]);
  const selection = router.resolvePage(url);
  const siteSelection = router.resolveSiteSelection(url);
  return unbased(
    forgeRouteSidebar(
      router,
      commandRouter,
      selection?.snapshot.id ?? siteSelection?.snapshot.id ?? '',
      selection?.lang ?? siteSelection?.lang,
      url.pathname,
    ),
  );
}
