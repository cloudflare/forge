import { defineCollection } from 'astro:content';
import { fernContentLoader } from './content-collections.ts';
import type { FernContentOptions } from './project.ts';

/**
 * Defines the compact build-time catalog collection required by `astro-fern/server`.
 * Register it in `content.config.ts` under the name passed to `astroFern({ collection })`
 * (default `apiReference`), and separately register the package Live Loader in `live.config.ts`.
 */
export function fernCollection(options: FernContentOptions) {
  return defineCollection({ loader: fernContentLoader(options) });
}
