import { renderPageMarkdownPathnameResponse } from 'astro-fern/server';

export const prerender = false;

export function GET({ locals, request, url }: { locals: App.Locals; request: Request; url: URL }): Promise<Response> {
  const fetcher = locals.fernArtifactFetcher;
  return renderPageMarkdownPathnameResponse(url.pathname, {
    ...(locals.fernRequestCache ? { cache: locals.fernRequestCache } : {}),
    ...(fetcher ? { request, fetcher } : {}),
  });
}
