import { z } from 'astro/zod';
import type { StainlessSnapshot } from './stainless-redirects.ts';

/**
 * The retired Stainless site's SDK snippets, `stainless-snippets.json`, which the repository
 * root's `pnpm generate:stainless-snippets` writes (the generator is the
 * `cloudflare-stainless-snippets` package). `format` has to match the generator's.
 */

/** The SDKs the old site had samples for, as this site's target ids. */
export const STAINLESS_LANGUAGES = ['typescript', 'python', 'go'] as const;
export type StainlessLanguage = (typeof STAINLESS_LANGUAGES)[number];

const snippetsSchema = z.object({
  typescript: z.string().min(1).optional(),
  python: z.string().min(1).optional(),
  go: z.string().min(1).optional(),
});
export type SdkSnippets = z.infer<typeof snippetsSchema>;

export const stainlessSnippetsFileSchema = z.object({
  format: z.literal(1),
  source: z.object({ apiSchemasSha: z.string(), generatedAt: z.string() }),
  /** Old method page, as in the redirects snapshot → its snippet per language. */
  snippets: z.record(z.string(), snippetsSchema),
});
export type StainlessSnippetsFile = z.infer<typeof stainlessSnippetsFileSchema>;

export interface OperationSnippets {
  /** `operationId` → the snippets of the old method page that redirects to its page. */
  byOperation: Map<string, SdkSnippets>;
  /** Operations more than one old method page redirects to, which use the first page's snippets. */
  shared: string[];
}

/**
 * Gives each operation the snippets of its old method page: the one the redirects snapshot maps to
 * its `operationId`, so it redirects to the operation's page. Several old pages can share an
 * operation (aliases, or account and zone variants); the first by path wins.
 */
export function snippetsByOperation(
  snapshot: Pick<StainlessSnapshot, 'methods'>,
  file: StainlessSnippetsFile,
): OperationSnippets {
  const byOperation = new Map<string, SdkSnippets>();
  const shared = new Set<string>();
  for (const [page, snippets] of Object.entries(file.snippets).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const operationId = snapshot.methods[page];
    if (!operationId) continue;
    if (byOperation.has(operationId)) {
      shared.add(operationId);
      continue;
    }
    byOperation.set(operationId, snippets);
  }
  return { byOperation, shared: [...shared] };
}
