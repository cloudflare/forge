import { defineLiveCollection } from 'astro:content';
import { apiPagesLoader } from '@cloudflare/nimbus-docs/live';

export const collections = {
  apiPages: defineLiveCollection({ loader: apiPagesLoader() }),
};
