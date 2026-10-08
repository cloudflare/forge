import { defineLiveCollection } from 'astro:content';
import { fernOperationLiveLoader } from 'astro-fern/live';

export const collections = {
  apiOperations: defineLiveCollection({
    loader: fernOperationLiveLoader(),
  }),
};
