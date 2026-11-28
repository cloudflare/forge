import type { ApiOperationPage, ApiPageProps, ApiRootPage, ApiSectionPage } from '@cloudflare/nimbus-docs/api';
import type { CommandMetadata } from '../command-reference/schema.ts';

export const OG_CARD_META = 'og-card';
export const OG_CARD_SIZE = { width: 1200, height: 630 } as const;

const DRAWING = 1;

export interface OgCard {
  title: string;
  method?: string;
  code?: string;
  pills?: string[];
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function apiPageCard(page: ApiPageProps['page']): OgCard | undefined {
  switch (page.kind) {
    case 'operation': {
      const { title, method, path } = page as ApiOperationPage;
      return { title, method: method.toUpperCase(), code: path };
    }
    case 'api': {
      const server = (page as ApiRootPage).servers[0]?.replace(/\/+$/, '');
      return server ? { title: page.title, code: server } : { title: page.title };
    }
    case 'section': {
      const { title, breadcrumbs, operations, sections = [] } = page as ApiSectionPage;
      const product = breadcrumbs.length > 1 ? breadcrumbs[1]!.label : undefined;
      const pills = [
        ...(product && product !== title ? [product] : []),
        ...(operations.length ? [count(operations.length, 'operation', 'operations')] : []),
        ...(sections.length ? [count(sections.length, 'section', 'sections')] : []),
      ];
      return { title, pills };
    }
    default:
      return undefined;
  }
}

export const commandCard = (title: string, command: Pick<CommandMetadata, 'usage'>): OgCard => ({
  title,
  code: command.usage,
});

export function ogCardVersion(card: OgCard): string {
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify([DRAWING, card])) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function ogCardPath(pagePath: string): string {
  const route = pagePath.replace(/^\/+|\/+$/g, '');
  return `/og/${route || 'index'}.png`;
}

export const pagePathFor = (slug: string) => (slug === 'index' ? '/' : `/${slug}/`);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

export function parseOgCard(json: string): OgCard | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { title, method, code, pills } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) return undefined;
  if (method !== undefined && typeof method !== 'string') return undefined;
  if (code !== undefined && typeof code !== 'string') return undefined;
  if (pills !== undefined && !isStrings(pills)) return undefined;
  return {
    title,
    ...(method !== undefined && { method }),
    ...(code !== undefined && { code }),
    ...(pills && { pills }),
  };
}
