/**
 * Cloudflare's API versioning policy for the Fern docs site.
 *
 * This is **Cloudflare-specific, end-user-facing information** and deliberately lives in
 * the docs site rather than in the product-agnostic astro-fern engine, which ships no
 * version vocabulary of its own.
 *
 * Wire format — the value of the `api-version` request header:
 *   - `legacy`                — the pre-versioning epoch (equivalently, no header sent)
 *   - `YYYY-MM-DD.preview`    — the rolling preview channel keyed to the upcoming minor
 *   - `YYYY-MM-DD.<codename>` — a dated release; `<codename>` is one of the cloud codenames
 *
 * Codenames advance alphabetically, one per major (~every six months; breaking changes
 * allowed at a major boundary). Minor releases within a major reuse the major's codename
 * and are additive only. There is no `latest` value on the wire.
 *
 * Behaviour is unit-tested with `node --experimental-strip-types --test` (see
 * `version.test.ts`).
 */
/** The major codenames, in release order (alphabetical). One codename per major. */
export const CLOUDFLARE_API_VERSION_CODENAMES = [
  'air',
  'breeze',
  'cirrus',
  'dew',
  'eddy',
  'fog',
  'gust',
  'halo',
  'isobar',
  'jet',
  'knot',
  'lunar',
  'mist',
  'nimbus',
  'ozone',
  'plume',
  'quell',
  'rain',
  'stratus',
  'thermal',
  'updraft',
  'vapor',
  'wind',
  'xeric',
  'yaw',
  'zephyr',
] as const;

export type CloudflareApiVersionCodename = (typeof CLOUDFLARE_API_VERSION_CODENAMES)[number];

/** The literal wire token for the pre-versioning epoch. */
export const LEGACY_API_VERSION = 'legacy';

/** The channel suffix used by the rolling preview version. */
export const PREVIEW_API_VERSION_SUFFIX = 'preview';

/** A parsed, validated Cloudflare API version identity. Discriminated on `channel`. */
export type CloudflareApiVersion =
  | { readonly channel: 'legacy'; readonly wire: 'legacy' }
  | {
      readonly channel: 'preview';
      readonly wire: string;
      readonly date: string;
      readonly year: number;
      readonly month: number;
      readonly day: number;
    }
  | {
      readonly channel: 'dated';
      readonly wire: string;
      readonly date: string;
      readonly year: number;
      readonly month: number;
      readonly day: number;
      readonly codename: CloudflareApiVersionCodename;
    };

const CODENAME_SET: ReadonlySet<string> = new Set(CLOUDFLARE_API_VERSION_CODENAMES);

const WIRE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.([a-z]+)$/;

/** True when (year, month, day) is a real calendar date (leap-year aware). */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * Parse a wire API-version string into a validated {@link CloudflareApiVersion}.
 *
 * Input is matched case-insensitively and canonicalized to lowercase; the returned `wire`
 * is always the canonical form, so `parseCloudflareApiVersion(v.wire).wire === v.wire`.
 * Throws with a descriptive message when the input is not a valid Cloudflare API version.
 */
export function parseCloudflareApiVersion(input: string): CloudflareApiVersion {
  if (typeof input !== 'string') {
    throw new Error(`cloudflare: API version must be a string, received ${typeof input}`);
  }

  const wire = input.trim().toLowerCase();

  if (wire === '') {
    throw new Error('cloudflare: API version must not be empty');
  }

  if (wire === LEGACY_API_VERSION) {
    return { channel: 'legacy', wire: LEGACY_API_VERSION };
  }

  if (wire === 'latest') {
    throw new Error(
      'cloudflare: "latest" is not a valid API version on the wire — request an explicit dated version (e.g. "2027-01-01.air") or "legacy"',
    );
  }

  const match = WIRE_PATTERN.exec(wire);
  if (!match) {
    throw new Error(
      `cloudflare: invalid API version "${input}" — expected "legacy" or "YYYY-MM-DD.<codename>" (e.g. "2027-01-01.air" or "2027-02-01.preview")`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const suffix = match[4] as string;
  const date = `${match[1]}-${match[2]}-${match[3]}`;

  if (!isRealCalendarDate(year, month, day)) {
    throw new Error(`cloudflare: invalid API version "${input}" — "${date}" is not a real calendar date`);
  }

  if (suffix === PREVIEW_API_VERSION_SUFFIX) {
    return { channel: 'preview', wire: `${date}.${PREVIEW_API_VERSION_SUFFIX}`, date, year, month, day };
  }

  if (CODENAME_SET.has(suffix)) {
    return {
      channel: 'dated',
      wire: `${date}.${suffix}`,
      date,
      year,
      month,
      day,
      codename: suffix as CloudflareApiVersionCodename,
    };
  }

  throw new Error(
    `cloudflare: invalid API version "${input}" — "${suffix}" is not a known codename or "${PREVIEW_API_VERSION_SUFFIX}"`,
  );
}

/** Non-throwing variant of {@link parseCloudflareApiVersion}; returns `null` on invalid input. */
export function tryParseCloudflareApiVersion(input: string): CloudflareApiVersion | null {
  try {
    return parseCloudflareApiVersion(input);
  } catch {
    return null;
  }
}

/**
 * Ascending, lexicographically-comparable sort key. `legacy` sorts first, then dated /
 * preview by calendar date; when a dated release and a preview share a date the stable
 * dated release sorts before the preview.
 */
export function cloudflareApiVersionSortKey(version: CloudflareApiVersion): string {
  if (version.channel === 'legacy') return '0';
  const channelRank = version.channel === 'dated' ? '0' : '1';
  return `1:${version.date}:${channelRank}`;
}

/** Total ordering over Cloudflare API versions, oldest first. */
export function compareCloudflareApiVersions(a: CloudflareApiVersion, b: CloudflareApiVersion): number {
  const keyA = cloudflareApiVersionSortKey(a);
  const keyB = cloudflareApiVersionSortKey(b);
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}

/** Human-facing display label, e.g. "Legacy", "2027-01-01 (Air)", "2027-02-01 (Preview)". */
export function cloudflareApiVersionLabel(version: CloudflareApiVersion): string {
  if (version.channel === 'legacy') return 'Legacy';
  const suffix = version.channel === 'preview' ? 'Preview' : capitalize(version.codename);
  return `${version.date} (${suffix})`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * URL path segment for a version: only the date appears in the URL. Both dated releases
 * and previews collapse to their bare date (e.g. `2027-01-01.air` → `"2027-01-01"`,
 * `2028-01-01.preview` → `"2028-01-01"`); the codename / `preview` suffix survives only in
 * the wire `id` and the display label. `legacy` has no date, so it keeps its literal token.
 *
 * Because the suffix is dropped, a preview and a stable release sharing a date resolve to
 * the same slug; the engine rejects that at build time (duplicate slug), so a promoted
 * release and its retired preview must not be configured simultaneously.
 */
export function cloudflareApiVersionSlug(version: CloudflareApiVersion): string {
  return version.channel === 'legacy' ? version.wire : version.date;
}

export function isLegacy(
  version: CloudflareApiVersion,
): version is Extract<CloudflareApiVersion, { channel: 'legacy' }> {
  return version.channel === 'legacy';
}

export function isPreview(
  version: CloudflareApiVersion,
): version is Extract<CloudflareApiVersion, { channel: 'preview' }> {
  return version.channel === 'preview';
}

export function isDated(version: CloudflareApiVersion): version is Extract<CloudflareApiVersion, { channel: 'dated' }> {
  return version.channel === 'dated';
}

/** True for versions that are not prereleases (i.e. `legacy` and dated releases, not `preview`). */
export function isStable(version: CloudflareApiVersion): boolean {
  return version.channel !== 'preview';
}
