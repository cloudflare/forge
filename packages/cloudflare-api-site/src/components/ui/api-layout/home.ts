import release from "../../../../.forge/release.json";

/**
 * Endpoints per part of the API home's list. The API route passes it to
 * `getApiStaticPaths` and `getApiRoute`, which split the list by it.
 */
export const API_HOME_CHUNK_SIZE = 150;

/** When the Forge spec last changed, when its source said so. */
export const API_HOME_LAST_MODIFIED = release.lastModified ? new Date(release.lastModified) : undefined;
