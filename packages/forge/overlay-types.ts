import type { Schema } from './schema/schema.js';

export type FernExtensions = {
  /** @see https://buildwithfern.com/learn/api-definitions/openapi/extensions/availability */
  'x-fern-availability': Schema.method['status'];
  /** @see https://buildwithfern.com/learn/api-definitions/openapi/extensions/ignoring-elements */
  'x-fern-ignore'?: boolean;
  /** @see https://buildwithfern.com/learn/api-definitions/openapi/extensions/method-names */
  'x-fern-sdk-group-name'?: string;
  /** @see https://buildwithfern.com/learn/api-definitions/openapi/extensions/method-names */
  'x-fern-sdk-method-name': string;
};

export type ForgeExtensions = {
  /** Generate code but hide from CLI help unless CF_HIDE_COMMANDS is set. */
  'x-forge-hidden'?: boolean;
  /**
   * Temporary first-party opt-in for an operation that upstream marks internal.
   * Keep the operation in generated Forge SDKs until the service-owned OpenAPI
   * is fixed, then remove this field from the overlay.
   */
  'x-forge-internal'?: boolean;
  'x-forge-epilogue'?: string;
  'x-forge-args'?: Schema.methodArg[];
  'x-forge-params'?: Record<string, Schema.paramOverride>;
  /** See {@link Schema.method.requireConfirmation}. */
  'x-forge-require-confirmation'?: `This operation ${string}.`;
};

export type ExtensionMethods = FernExtensions &
  ForgeExtensions & {
    operationId: string;
    description?: string;
  };

export type ForgeMethod = ExtensionMethods;

export type ForgeMethodGroup = {
  'x-fern-sdk-group-name': string;
  description: string;
  'x-forge-epilogue'?: string;
  methods: ExtensionMethods[];
};

export type ForgeCommand = {
  description: string;
  methods: (ExtensionMethods | ForgeMethodGroup)[];
};

export type ForgeCommandMap = Record<string, ForgeCommand>;

export type ForgeCommandConfig = Omit<ForgeCommand, 'methods'>;
export type ForgeCommandConfigMap = Record<string, ForgeCommandConfig>;

export type ForgeGroupInfo = {
  description?: string;
  'x-forge-epilogue'?: string;
};

export type ForgeGroupInfoMap = Record<string, Record<string, ForgeGroupInfo>>;

/**
 * Command or group metadata in the root `x-forge-commands` catalogue. Group
 * keys may nest through `groups` or use dotted paths directly.
 */
export type ForgeCommandMetadata = {
  description: string;
  'x-forge-epilogue'?: string;
  groups?: Record<string, ForgeCommandMetadata>;
};

export type ForgeCommandMetadataMap = Record<string, ForgeCommandMetadata>;

export type OverlayAction = {
  target: string;
  description?: string;
  update?: unknown;
  remove?: boolean;
};

/**
 * An OpenAPI Overlay document per the Overlay Specification v1.0.0.
 * @see https://spec.openapis.org/overlay/v1.0.0
 */
export type ApiOverlay = {
  /** REQUIRED. Overlay specification version (e.g. '1.0.0'). */
  overlay: string;
  /** REQUIRED. Metadata about this overlay. */
  info: {
    /** REQUIRED. Human-readable description of the overlay's purpose. */
    title: string;
    /** REQUIRED. Version identifier for changes to this overlay. */
    version: string;
  };
  /** URI reference to the target document this overlay applies to. */
  extends?: string;
  /** REQUIRED. Ordered list of actions to apply to the target document. */
  actions: OverlayAction[];
};

export type ApiOverlayFile = {
  name: string;
  overlay: ApiOverlay;
};

// ---------------------------------------------------------------------------
// Types for the final overlaid OpenAPI document
// ---------------------------------------------------------------------------

/**
 * Per-operation forge metadata applied to the overlaid OpenAPI spec.
 * These fields are injected into each operation object in the final openapi.overlaid.json.
 *
 * Follows the same namespacing pattern as Speakeasy's x-speakeasy-group:
 * the group path is dot-separated and the first segment is the command name.
 * @see https://www.speakeasy.com/docs/sdks/customize/structure/namespaces
 */
export type OverlaidOperationForgeFields = {
  /**
   * Full dot-separated namespace path. The first segment is the command name,
   * subsequent segments form the sub-group hierarchy.
   * E.g. 'zero-trust.devices.policies.custom.includes'
   */
  'x-fern-sdk-group-name': string;
  /** Resolved method name within the group (e.g. 'create') */
  'x-fern-sdk-method-name': string;
  /** Lifecycle status */
  'x-fern-availability': Schema.method['status'];
  /** Do not generate any code for this operation in any surface. */
  'x-fern-ignore': boolean;
  /** Generate code but hide from CLI help unless CF_HIDE_COMMANDS is set. */
  'x-forge-hidden': boolean;
  /** Generate this explicitly selected internal operation for first-party SDK consumers. */
  'x-forge-internal'?: boolean;
  /** Epilogue text appended to CLI help output */
  'x-forge-epilogue'?: string;
  /** Explicit CLI argument overrides */
  'x-forge-args'?: Schema.methodArg[];
  /** Per-parameter overrides */
  'x-forge-params'?: Record<string, Schema.paramOverride>;
  /** Force destructive-confirmation prompt regardless of HTTP verb */
  'x-forge-require-confirmation'?: `This operation ${string}.`;
};

/**
 * An operation in the overlaid OpenAPI spec that maps to multiple commands (aliases).
 */
export type OverlaidOperationForgeAliases = {
  'x-forge-aliases': Omit<OverlaidOperationForgeFields, 'x-fern-ignore'>[];
};

/**
 * An OpenAPI operation object in the overlaid spec, with required description
 * and forge extension fields.
 */
export type OverlaidOperation = {
  operationId: string;
  /** Description is mandatory after overlay application (upstream or overlay-provided) */
  description: string;
  summary?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
} & (OverlaidOperationForgeFields | OverlaidOperationForgeAliases);

/**
 * Root-level extensions added to the overlaid OpenAPI document.
 */
export type OverlaidRootExtensions = {
  /** Command and group metadata, keyed by command name */
  'x-forge-commands'?: ForgeCommandMetadataMap;
};
