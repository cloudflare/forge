import type { FernAgentRoute, FernHumanRoute, FernProjectData } from './route-plan.ts';

export function getHumanStaticPaths(data: FernProjectData): Array<{
  params: { slug: string };
  props: { pageId: string; target?: string };
}> {
  return data.humanRoutes.map((route: FernHumanRoute) => ({
    params: { slug: route.slug },
    props: { pageId: route.pageId, ...(route.target ? { target: route.target } : {}) },
  }));
}

export function getMarkdownStaticPaths(data: FernProjectData): Array<{
  params: { document: string };
  props: { agentRouteId: string };
}> {
  return data.agentRoutes
    .filter((route) => route.kind === 'page-markdown')
    .map((route) => {
      if (!route.param) throw new Error(`astro-fern: Markdown route "${route.id}" is missing its route parameter`);
      return {
        params: { document: route.param },
        props: { agentRouteId: route.id },
      };
    });
}

export function getLlmsStaticPaths(data: FernProjectData): Array<{
  params: { scope: string };
  props: { agentRouteId: string };
}> {
  return data.agentRoutes
    .filter((route: FernAgentRoute) => route.kind === 'llms-index' && route.id !== 'llms:site')
    .map((route) => {
      if (!route.param) throw new Error(`astro-fern: llms.txt route "${route.id}" is missing its route parameter`);
      return {
        params: { scope: route.param },
        props: { agentRouteId: route.id },
      };
    });
}
