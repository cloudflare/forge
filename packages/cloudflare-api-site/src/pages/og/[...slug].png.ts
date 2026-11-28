import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ImageResponse } from 'workers-og';
import { OG_CARD_META, OG_CARD_SIZE, ogCardVersion, pagePathFor, parseOgCard } from '../../og/card.ts';
import { type FontBucket, inter, loadTitleFont, measureWith, satoriFonts } from '../../og/fonts.ts';
import { cardElement } from '../../og/layout.ts';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=300';

const META = new RegExp(`<meta\\s+name="${OG_CARD_META}"\\s+content="([^"]*)"`);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (value: string) =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) =>
    entity[0] !== '#'
      ? (ENTITIES[entity.toLowerCase()] ?? match)
      : String.fromCodePoint(
          entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
        ),
  );

const png = (body: ArrayBuffer, cacheControl: string, diagnostic: string) =>
  new Response(body, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(body.byteLength),
      'Cache-Control': cacheControl,
      'X-OG-Image': diagnostic,
    },
  });

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async ({ params, url, rewrite }) => {
  const slug = params.slug;
  if (!slug) return notFound();

  const cache = (globalThis.caches as { default?: Cache } | undefined)?.default;
  const cacheKey = new Request(url);
  const cached = await cache?.match(cacheKey).catch((error) => console.error('[og] Could not read the cache', error));
  if (cached) return cached;

  const page = await rewrite(pagePathFor(slug));
  if (page.status === 404) return notFound();
  if (!page.ok) throw new Error(`[og] ${pagePathFor(slug)} returned ${page.status}`);
  const tag = (await page.text()).match(META)?.[1];
  const card = tag === undefined ? undefined : parseOgCard(decodeEntities(tag));
  if (!card) return notFound();

  const bucket = (env as { PRIVATE_ASSETS?: FontBucket }).PRIVATE_ASSETS;
  const titleFont = await loadTitleFont(bucket);
  const image = await new ImageResponse(cardElement(card, measureWith(titleFont)) as never, {
    ...OG_CARD_SIZE,
    fonts: satoriFonts(titleFont),
  }).arrayBuffer();

  const font = titleFont !== inter ? 'kunst' : bucket ? 'inter' : 'inter; bucket=unbound';
  const current = font === 'kunst' && url.searchParams.get('v') === ogCardVersion(card);
  if (current && cache) {
    await cache
      .put(cacheKey, png(image, IMMUTABLE, `cached; font=${font}`))
      .catch((error) => console.error('[og] Could not store the card', error));
  }
  return png(image, current ? IMMUTABLE : REVALIDATE, `rendered; font=${font}`);
};
