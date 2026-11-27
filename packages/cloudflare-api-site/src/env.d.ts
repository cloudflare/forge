/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Full URL of the API search Worker's `/api/search` endpoint. Search is hidden when unset. */
  readonly PUBLIC_API_SEARCH_URL?: string;
}
