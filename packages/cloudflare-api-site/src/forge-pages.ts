/**
 * What `prepareForgeSpec` measured at build time, for pages that would otherwise
 * have to load the whole API index on each request.
 */
import endpointCounts from '../.forge/endpoint-counts.json';
import operationPages from '../.forge/operation-pages.json';

/** How many endpoints a product or resource page holds, its resources' included. */
export function endpointCount(href: string): number | undefined {
  return (endpointCounts as Record<string, number>)[href];
}

/** The page of the operation at `method` `path` (the spec's path template), collection-relative. */
export function operationPage(method: string, path: string): string | undefined {
  return (operationPages as Record<string, string>)[`${method.toUpperCase()} ${path}`];
}
