/**
 * Fern `x-fern-availability` values.
 *
 * Endpoint statuses and the `{ status, message }` object form follow
 * https://buildwithfern.com/learn/api-definition/openapi/extensions/availability
 */

export const FERN_AVAILABILITY_STATUSES = [
  'alpha',
  'beta',
  'preview',
  'generally-available',
  'deprecated',
  'legacy',
] as const;

/** Lifecycle status Fern accepts on an endpoint. */
export type FernAvailabilityStatus = (typeof FERN_AVAILABILITY_STATUSES)[number];

/** Parsed availability. `message` is set only when the source object included one. */
export type FernAvailability = {
  status: FernAvailabilityStatus;
  message?: string;
};

/**
 * Value as it appears on an OpenAPI operation or overlay method.
 * A bare status string is equivalent to `{ status }` with no message.
 */
export type FernAvailabilityWire = FernAvailabilityStatus | { status: FernAvailabilityStatus; message?: string };

const STATUS_SET: ReadonlySet<string> = new Set(FERN_AVAILABILITY_STATUSES);

const PRE_RELEASE_STATUSES: ReadonlySet<FernAvailabilityStatus> = new Set(['alpha', 'beta', 'preview']);

/** Message Fern's TypeScript SDK attaches to pre-release methods when the spec has none. */
export const FERN_PRERELEASE_JSDOC = 'This endpoint is in pre-release and may change.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFernAvailabilityStatus(value: string): value is FernAvailabilityStatus {
  return STATUS_SET.has(value);
}

/**
 * Parse a Fern availability value.
 *
 * Missing values are not defaulted here. Callers that treat omission as `alpha`
 * should do that before calling.
 *
 * @throws When the status is outside Fern's endpoint vocabulary, the object
 *   has unexpected properties, or `message` is not a non-empty string.
 */
export function parseFernAvailability(value: unknown, operationId: string): FernAvailability {
  const prefix = `${operationId}: invalid x-fern-availability`;

  if (typeof value === 'string') {
    if (!isFernAvailabilityStatus(value)) throw new Error(`${prefix} ${value}`);
    return { status: value };
  }

  if (!isRecord(value)) throw new Error(`${prefix} ${String(value)}`);

  for (const key of Object.keys(value)) {
    if (key !== 'status' && key !== 'message') {
      throw new Error(`${prefix} property ${JSON.stringify(key)}`);
    }
  }

  const status = value.status;
  if (typeof status !== 'string' || !isFernAvailabilityStatus(status)) {
    throw new Error(`${prefix} ${typeof status === 'string' ? status : String(status)}`);
  }

  if (value.message === undefined) return { status };

  if (typeof value.message !== 'string' || value.message.trim() === '') {
    throw new Error(`${prefix} message`);
  }

  return { status, message: value.message.trim() };
}

/**
 * JSDoc tag Fern's TypeScript generator emits for this availability.
 *
 * `deprecated` becomes `@deprecated`. `alpha`, `beta`, and `preview` become
 * `@beta`. `generally-available` and `legacy` do not emit a tag; legacy stays
 * supported, so it is not marked deprecated.
 */
export function fernAvailabilityJsDocLine(availability: FernAvailability): string | undefined {
  if (availability.status === 'deprecated') {
    return availability.message ? `@deprecated ${availability.message}` : '@deprecated';
  }

  if (PRE_RELEASE_STATUSES.has(availability.status)) {
    return `@beta ${availability.message ?? FERN_PRERELEASE_JSDOC}`;
  }

  return undefined;
}
