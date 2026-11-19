import { markdownRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';
import { commandMarkdown } from '../../command-markdown.ts';
import { commandProducts } from '../../command-sidebar.ts';
import { getCommandRouter } from '../../command-reference/server.ts';

const markdown = markdownRoute();

/** Serves Nimbus's `/<page>/index.md`, and a cf command page's Markdown at the same shape of URL. */
export const GET: APIRoute = async (context) => {
  const command = (await getCommandRouter()).resolve(context.url.pathname.replace(/index\.md$/, ''), commandProducts);
  if (command) {
    const llmsUrl = new URL(`${import.meta.env.BASE_URL}llms.txt`, context.site ?? context.url).href;
    return new Response(commandMarkdown(command, llmsUrl), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  }
  return markdown.GET(context);
};
