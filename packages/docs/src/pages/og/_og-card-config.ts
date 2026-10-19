/**
 * Shared visual config for build-time OG cards.
 *
 * Both the per-page endpoint (`og/[...slug].ts`) and the homepage fallback (`og.png.ts`) spread
 * this object into `astro-og-canvas`.
 *
 * Leading underscore tells Astro to skip routing for this file -- it sits inside `src/pages/` to be
 * next to its consumers, but it's not a route.
 */

import type { OGImageOptions } from 'astro-og-canvas';

// The site's dark scheme, since a social card has no scheme to follow, with a Cloudflare orange
// edge on the leading side: the one thing that makes a card recognisable at thumbnail size.
export const ogCardConfig = {
  bgGradient: [
    [13, 13, 13],
    [26, 20, 16],
  ],
  // The Cloudflare cloud, rasterized from `og-assets/og-mark.svg`. Build-time only, like the font:
  // these paths are resolved from the project root when the cards are rasterized, and nothing
  // requests them over HTTP, so they stay out of `public/`.
  logo: { path: './og-assets/og-mark.png', size: [132] },
  border: { color: [246, 130, 31], width: 12, side: 'inline-start' },
  padding: 88,
  fonts: ['./fonts/Inter-Bold.ttf'],
  font: {
    title: {
      color: [242, 242, 242],
      size: 68,
      weight: 'Bold',
      families: ['Inter'],
      lineHeight: 1.1,
    },
    description: {
      color: [168, 168, 168],
      size: 32,
      weight: 'Bold',
      families: ['Inter'],
      lineHeight: 1.35,
    },
  },
  format: 'PNG',
} satisfies Partial<OGImageOptions>;
