import { markdownRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';
import { commandMarkdown } from '../command-markdown.ts';
import { commandProducts } from '../command-sidebar.ts';
import { getCommandRouter } from '../command-reference/server.ts';

const markdown = markdownRoute();

/** Serves Nimbus's `/<page>/index.md`, a cf command page's Markdown, and 301s this site's old `/<page>.md` URLs. */
export const GET: APIRoute = async (context) => {
  const slug = context.params.slug ?? '';
  // The site's own root, `/api.md`, reaches this route with the base as its slug.
  if (context.url.pathname === `${import.meta.env.BASE_URL.replace(/\/$/, '')}.md`) {
    return context.redirect(`${import.meta.env.BASE_URL}index.md${context.url.search}`, 301);
  }
  if (slug.split('/').at(-1) !== 'index') {
    return context.redirect(`${import.meta.env.BASE_URL}${slug}/index.md${context.url.search}`, 301);
  }
  // A cf command page's URL, without `index.md`.
  const command = (await getCommandRouter()).resolve(context.url.pathname.replace(/index\.md$/, ''), commandProducts);
  if (command) {
    const llmsUrl = new URL(`${import.meta.env.BASE_URL}llms.txt`, context.site ?? context.url).href;
    return new Response(commandMarkdown(command, llmsUrl), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  }
  return markdown.GET(context);
};
