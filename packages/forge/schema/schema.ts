import type { FernAvailabilityStatus } from '../shared/fern-availability.js';

export namespace Schema {
  // Completion source types for shell tab completion
  export type completionSource =
    | { type: 'none' }
    | { type: 'choices' } // Use arg.values array (for enumArg)
    | { type: 'file'; extensions?: string[] }
    | {
        type: 'dynamic';
        listOperation: string; // OpenAPI operation ID to fetch completions
        displayField: string; // Field to show/insert in completions
      };

  export type base = primitiveString | primitiveNumber | primitiveBoolean | literalString | literalFalse | literalTrue;

  export type argBase = {
    name: string;
    alias?: string;
    /**
     * Human-readable description for this argument.
     *
     * Optional when the method has an `api.operation` and the OpenAPI spec
     * provides a description for this parameter (resolved via `$ref`).
     * The pipeline will fill it in automatically at generation time.
     *
     * Required when the argument is CLI-only (no OpenAPI counterpart).
     * The build will fail if no description can be resolved from either source.
     */
    description?: string;
    /** How to complete this argument in shell tab completion */
    completion?: completionSource;
  };

  export type literalString = { literal: string; description: string };
  export type primitiveString = 'string';
  export interface stringArg extends argBase {
    type: primitiveString;
    required: true | { default: string };
  }

  export type literalFalse = { literal: false };
  export type literalTrue = { literal: true };
  export type primitiveBoolean = 'boolean';
  export interface booleanArg extends argBase {
    type: primitiveBoolean;
    required: true | { default: boolean };
  }

  export type literalNumber = { literal: number };
  export type primitiveNumber = 'number';
  export interface numberArg extends argBase {
    type: primitiveNumber;
    required: true | { default: number };
  }

  export type primitiveArg =
    | primitiveString
    | primitiveBoolean
    | primitiveNumber
    | literalString
    | literalNumber
    | literalFalse
    | literalTrue;

  export interface enumArg extends argBase {
    type: 'enum';
    values: primitiveArg[];
    required: true | { default: string | number | boolean };
  }

  export type arg = stringArg | booleanArg | numberArg | enumArg;

  export type methodArg =
    | arg
    | {
        required?: arg[];
        oneOf?: arg[];
        options?: arg[];
      };

  /** @deprecated Use `operationId` directly on method instead */
  export type apiReference = { operationId: string };

  /** Example usage for a command */
  export type example = {
    /** Brief description of what this example demonstrates */
    description: string;
    /** The full command to run */
    command: string;
  };

  /**
   * Per-parameter overrides for OpenAPI-derived parameters.
   * Use this to tweak individual params without redefining the entire args array.
   */
  export type paramOverride = {
    /** Override or set the description (when OpenAPI description is missing or inadequate) */
    description?: string;
    /**
     * Override the default value, or pass `null` to clear a default declared in
     * the OpenAPI spec. Useful for partial-PUT/PATCH ops where the spec
     * mechanically inherits create-time defaults — passing `null` keeps the
     * field absent on the wire unless the user explicitly supplies it.
     */
    default?: string | number | boolean | null;
    /** Hide this parameter from the CLI (it's still sent to the API but not shown as a flag) */
    hidden?: boolean;
    /** Make an optional OpenAPI parameter required in the CLI */
    required?: boolean;
    /**
     * Replace (or add) the OpenAPI-derived enum choices for this parameter.
     * Use when upstream is too restrictive or omits the enum (e.g. hyperdrive
     * `sslmode` is typed as plain string but its description names three valid values).
     */
    choices?: readonly (string | number | boolean)[];
    /**
     * Force array shape regardless of the OpenAPI scalar type. Yargs emits
     * `array: true, string: true` so users can pass repeated or space-separated values.
     */
    array?: boolean;
    /**
     * Promote a top-level body field to a positional argument. The field is still
     * serialized into the body; only the CLI surface changes. Multiple fields with
     * `positional: true` appear in `params` insertion order.
     *
     * Top-level body properties only — nested fields, booleans, and explicit-`args`
     * methods are ineligible.
     */
    positional?: boolean;
    /**
     * Override the default `@file` resolution for this body field.
     *
     * Every string-typed body flag accepts `@path/to/file` (or `@-` for stdin) by
     * default, read as UTF-8 text. Set this only when the default does not fit:
     *
     *   - `false`                — disable `@`-resolution; pass the value verbatim.
     *   - `{ format: 'binary' }` — read raw bytes (e.g. octet-stream uploads).
     *   - `{ format: 'base64' }` — read and base64-encode (e.g. attachments).
     *   - `{ format: 'json' }`   — JSON-parse the file; parsed value replaces the flag.
     *
     * Flag-shaped string body fields only.
     */
    fromFile?: false | { format: 'binary' | 'base64' | 'json' };
  };

  /**
   * Base method properties shared by all lifecycle statuses
   */
  type methodBase = {
    name: string;
    /**
     * Short, single-line, plain-text label for this method (OpenAPI `summary`).
     *
     * Intended for compact contexts — CLI command listings, usage headers.
     * Resolved from the OpenAPI operation's `summary` at generation time when
     * the method has an `operationId`; left unset if upstream has none.
     */
    summary?: string;
    /**
     * Human-readable description for this method.
     *
     * The longer, potentially multi-line/markdown body (OpenAPI `description`),
     * suited to full `--help` output and SDK doc comments.
     *
     * Optional when the method has an `api.operation` — the pipeline will
     * resolve the description from the OpenAPI spec (or its `updates` map)
     * at generation time.  If the OpenAPI already provides a description,
     * specifying one here is a build error (single source of truth).
     *
     * If omitted, resolved from the OpenAPI spec via `api.operationId`.
     */
    description?: string;
    epilogue?: string;
    /**
     * Explicit CLI arguments for this method.
     *
     * When omitted, ALL parameters (path, query, body) are automatically
     * derived from the OpenAPI spec. This is the preferred approach — let
     * the OpenAPI be the single source of truth.
     *
     * When provided, these args REPLACE the auto-derived params entirely.
     * Use `params` for surgical overrides to individual OpenAPI params instead.
     */
    args?: methodArg[];
    /**
     * Per-parameter overrides applied on top of OpenAPI-derived parameters.
     * Keyed by the OpenAPI parameter name (e.g. 'zone_id', 'per_page').
     *
     * Only used when `args` is omitted (auto-derived mode). If `args` is
     * explicitly provided, `params` is ignored.
     */
    params?: Record<string, paramOverride>;
    /** OpenAPI operationId — must match an operationId in the Cloudflare OpenAPI spec */
    operationId: string;
    /**
     * Force a confirmation prompt for this operation, showing the user this message.
     */
    requireConfirmation?: `This operation ${string}.`;
  };

  /**
   * API method definition with lifecycle status.
   *
   * `status` uses Fern's endpoint vocabulary:
   *   alpha               — early experimental stage
   *   beta                — stable enough for early adopters
   *   preview             — feature-complete but subject to change
   *   generally-available — stable and ready for production
   *   deprecated          — no longer recommended for new use
   *   legacy              — superseded but still supported
   */
  export type method = methodBase & {
    status: FernAvailabilityStatus;
    /**
     * Human note from `x-fern-availability.message`.
     * Present only when the source used the object form.
     */
    availabilityMessage?: string;
  };

  export type methodGroup = {
    name: string;
    epilogue?: string;
    /** Human-readable description for this method group */
    description: string;
    /** Methods or nested sub-groups in this group */
    methods: (method | methodGroup)[];
  };

  export type command = {
    name: string;
    /** Human-readable description for this command */
    description: string;
    /** Methods in this group */
    methods: (method | methodGroup)[];
    /** Global CLI arguments for this command */
    globalCliArgs: arg[];
    /**
     * Whether this command family is hidden by default.
     *
     * Set to `true` for products not yet ready to be used in any surface.
     * Set to `false` for products that should always be visible.
     *
     * Note that hidden commands become visible when CF_HIDE_COMMANDS=false.
     */
    hideCommand: boolean;
  };
}

export const modifyDescription = (arg: Schema.arg, fn: (original: Schema.arg['description']) => string) => {
  return {
    ...arg,
    description: fn(arg.description),
  };
};

/**
 * Extract the literal value from a {@link Schema.primitiveArg}.
 *
 * - `{ literal: 'foo', description: '…' }` → `'foo'`
 * - `{ literal: 5 }`                       → `5`
 * - `{ literal: false }`                   → `false`
 * - Primitive type names (`'string'` etc.)  → `never`
 */
type LiteralValue<T> = T extends { literal: infer L } ? L : never;

/**
 * Type-safe factory for enum args.
 *
 * Constrains `required.default` (when provided) to be one of the
 * literal values in the `values` array — a typo is a compile error.
 *
 * The `type: 'enum'` field is set automatically.
 *
 * @example
 * ```ts
 * const locationArg = enumArg({
 *   name: 'location',
 *   values: [
 *     { literal: 'weur', description: 'Western Europe' },
 *     { literal: 'eeur', description: 'Eastern Europe' },
 *   ],
 *   required: { default: 'weur' },   // ✅ compiles
 *   // required: { default: 'typo' }, // ❌ compile error
 * });
 * ```
 */
export function enumArg<const V extends readonly Schema.primitiveArg[]>(
  arg: Omit<Schema.enumArg, 'type' | 'values' | 'required'> & {
    values: V;
    required: true | { default: LiteralValue<V[number]> };
  },
): Schema.enumArg {
  return { ...arg, type: 'enum' } as unknown as Schema.enumArg;
}

// note that the intersection is required to preserve the metadata of the jsdoc all the way through to the callsites
export const command = <const C extends Schema.command>(command: C & Schema.command) => {
  return command;
};

// note that the intersection is required to preserve the metadata of the jsdoc all the way through to the callsites
export const method = <const M extends Schema.method>(method: M & Schema.method) => {
  return method;
};

// note that the intersection is required to preserve the metadata of the jsdoc all the way through to the callsites
export const methodGroup = <const MG extends Schema.methodGroup>(methodGroup: MG & Schema.methodGroup) => {
  return methodGroup;
};

// note that the intersection is required to preserve the metadata of the jsdoc all the way through to the callsites
export const methodArg = <const A extends Schema.arg>(arg: A & Schema.arg) => {
  return arg;
};
