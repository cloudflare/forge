import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { getApiRouter } from './api-server.ts';
import { getCommandRouter } from './command-reference/server.ts';
import { forgeRouteSidebar } from './sidebar.ts';

export const onRequest = defineRouteMiddleware(async (context) => {
  const [router, commandRouter] = await Promise.all([getApiRouter(), getCommandRouter()]);
  const selection = router.resolvePage(context.url);
  const siteSelection = router.resolveSiteSelection(context.url);
  const sidebar = forgeRouteSidebar(
    router,
    commandRouter,
    selection?.snapshot.id ?? siteSelection?.snapshot.id ?? '',
    selection?.lang ?? siteSelection?.lang,
    context.url.pathname,
  );
  context.locals.starlightRoute.sidebar = sidebar;
});
