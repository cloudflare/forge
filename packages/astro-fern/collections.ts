import { defineCollection } from 'astro:content';
import { fernContentLoader } from './content-collections.ts';
import { FERN_CONTENT_COLLECTION } from './content-contract.ts';
import type { FernContentOptions } from './project.ts';

/**
 * Defines the compact build-time catalog required by `astro-fern/server`.
 * Consumers should spread this result into their `content.config.ts` export
 * and separately register the package Live Loader in `live.config.ts`.
 */
export function defineFernCollections(options: FernContentOptions) {
  return {
    [FERN_CONTENT_COLLECTION]: defineCollection({ loader: fernContentLoader(options) }),
  };
}
