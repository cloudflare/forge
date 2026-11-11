import { llmsRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIContext, APIRoute } from 'astro';
import { commandProducts } from '../command-sidebar.ts';
import { getCommandRouter } from '../command-reference/server.ts';

const llms = llmsRoute();

/** Nimbus's `llms.txt`, followed by the cf command pages, which aren't in the API spec. */
export const GET: APIRoute = async (context) => {
  // Nimbus's tag covers its own bytes only, so ask it for the whole index and tag this one.
  const response = await llms.GET(unconditional(context));
  if (!response.ok) return response;
  const router = await getCommandRouter();
  const products = new Map(commandProducts.map((product) => [product.id, product]));
  const origin = context.site ?? context.url;
  const lines = router.commands.map((command) => {
    const href = new URL(`${router.commandHref(command, products.get(command.fullPath[0]!))}index.md`, origin).href;
    return `- [${command.command}](${href}) — ${command.description.split('\n')[0]}`;
  });
  const body = `${(await response.text()).trimEnd()}\n\n## Developer tooling\n\n${lines.join('\n')}\n`;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  const etag = `"sha256:${await sha256(body)}"`;
  headers.set('ETag', etag);
  if (matches(context.request.headers.get('If-None-Match'), etag)) {
    headers.delete('Content-Type');
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: response.status, headers });
};

function unconditional(context: APIContext): APIContext {
  const headers = new Headers(context.request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  return Object.create(context, { request: { value: new Request(context.request, { headers }) } });
}

/** RFC 9110 weak comparison: `*`, or any listed entity tag with the same opaque value. */
function matches(field: string | null, etag: string): boolean {
  if (field === null) return false;
  if (field.trim() === '*') return true;
  return [...field.matchAll(/(?:W\/)?("[^"]*")/g)].some(([, tag]) => tag === etag);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
