import { base } from 'astro:config/server';

/** The site's home, under the configured base. */
export const homeHref = base === '/' ? '/' : `${base.replace(/\/+$/, '')}/`;

/** Cloudflare's developer resources: in the header, and in the phone menu where the header has no room. */
export const siteLinks = [
  { label: 'Directory', href: 'https://developers.cloudflare.com/directory/' },
  { label: 'API', href: homeHref, active: true },
  { label: 'SDKs', href: 'https://developers.cloudflare.com/fundamentals/api/reference/sdks/' },
  { label: 'Changelog', href: 'https://developers.cloudflare.com/changelog/' },
];
