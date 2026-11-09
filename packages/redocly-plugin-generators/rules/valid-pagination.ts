/**
 * Validates `x-fern-pagination` on operations and at the document root.
 *
 * The extension is either an object (cursor, offset, uri, path or custom pagination) or, on an
 * operation, a boolean that inherits the document-level object. Every `$request.` selector must
 * point to an `in: query` parameter or request body property of the right type, and every
 * `$response.` selector to a property of the JSON success response.
 */
import { endpointId, getOperations, rootOf, type OperationInfo } from '../utils/document.ts';
import {
  anySchema,
  arraySchema,
  describeMissingResponse,
  getFernResponse,
  isIgnored,
  lookupRequestProperty,
  lookupResponseProperty,
  parseSelector,
  primitiveExcept,
  primitiveIn,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  type SchemaPredicate,
} from '../utils/property-path.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const EXTENSION = 'x-fern-pagination';

type PaginationKind = 'cursor' | 'offset' | 'uri' | 'path' | 'custom';

interface PropertySpec {
  key: string;
  side: 'request' | 'response';
  required: boolean;
  predicate: SchemaPredicate;
  /** Describes the accepted type, for messages. */
  expected: string;
}

const RESULTS: PropertySpec = {
  key: 'results',
  side: 'response',
  required: true,
  predicate: anySchema,
  expected: '',
};

const OFFSET_TYPE = primitiveIn('INTEGER', 'LONG', 'DOUBLE');

const SPECS: Record<PaginationKind, PropertySpec[]> = {
  cursor: [
    {
      key: 'cursor',
      side: 'request',
      required: true,
      predicate: primitiveExcept('BOOLEAN'),
      expected: 'a string, integer or number',
    },
    {
      key: 'next_cursor',
      side: 'response',
      required: true,
      predicate: primitiveExcept('BOOLEAN'),
      expected: 'a string, integer or number',
    },
    RESULTS,
  ],
  offset: [
    {
      key: 'offset',
      side: 'request',
      required: true,
      predicate: OFFSET_TYPE,
      expected: 'an integer or a double-precision number',
    },
    {
      key: 'step',
      side: 'request',
      required: false,
      predicate: OFFSET_TYPE,
      expected: 'an integer or a double-precision number',
    },
    RESULTS,
    {
      key: 'has-next-page',
      side: 'response',
      required: false,
      predicate: primitiveIn('BOOLEAN'),
      expected: 'a boolean',
    },
  ],
  uri: [
    {
      key: 'next_uri',
      side: 'response',
      required: true,
      predicate: primitiveIn('STRING'),
      expected: 'a string',
    },
    RESULTS,
  ],
  path: [
    {
      key: 'next_path',
      side: 'response',
      required: true,
      predicate: primitiveIn('STRING'),
      expected: 'a string',
    },
    RESULTS,
  ],
  custom: [RESULTS],
};

/** The pagination kind Fern's importer picks for an object, in the importer's order. */
function paginationKind(config: Record<string, AnyNode>): PaginationKind | undefined {
  if (config.cursor != null) {
    return 'cursor';
  }
  if ('next_uri' in config) {
    return 'uri';
  }
  if ('next_path' in config) {
    return 'path';
  }
  if ('offset' in config) {
    return 'offset';
  }
  if (config.type === 'custom') {
    return 'custom';
  }
  return undefined;
}

/**
 * Checks the shape of a pagination object. Returns the kind when the object is usable for property
 * checks.
 */
function checkShape(config: AnyNode, location: Location, ctx: UserContext): PaginationKind | undefined {
  if (!isPlainObject(config)) {
    return undefined;
  }
  const kind = paginationKind(config);
  if (kind === undefined) {
    ctx.report({
      message: `${EXTENSION} is not a valid pagination configuration. Declare cursor pagination (cursor, next_cursor, results), offset pagination (offset, results, and optionally step and has-next-page), uri pagination (next_uri, results), path pagination (next_path, results) or custom pagination (type: custom, results).`,
      location,
    });
    return undefined;
  }
  let valid = true;
  for (const spec of SPECS[kind]) {
    const value = config[spec.key];
    if (value == null) {
      if (spec.required) {
        valid = false;
        ctx.report({
          message: `${EXTENSION} declares ${kind} pagination, which requires '${spec.key}'.`,
          location,
        });
      }
      continue;
    }
    if (typeof value !== 'string') {
      valid = false;
      ctx.report({
        message: `${EXTENSION} '${spec.key}' must be a string selector such as '${spec.side === 'request' ? REQUEST_PREFIX : RESPONSE_PREFIX}${spec.key}'.`,
        location: location.child(spec.key),
      });
    }
  }
  return valid ? kind : undefined;
}

interface EffectiveConfig {
  config: Record<string, AnyNode>;
  kind: PaginationKind;
  /** Where to report property problems: the selector itself, or the operation's extension. */
  locationOf: (key: string) => Location;
  inherited: boolean;
}

function checkOperation(ctx: UserContext, operation: OperationInfo, config: EffectiveConfig): void {
  const id = endpointId(operation);
  const prefix = `${EXTENSION} for endpoint ${id}`;
  const suffix = config.inherited ? ' (inherited from the document-level x-fern-pagination)' : '';
  const specs = SPECS[config.kind];
  const response = getFernResponse(ctx, operation);

  const checkSpec = (spec: PropertySpec, responseSchema?: Located): void => {
    const value = config.config[spec.key];
    if (typeof value !== 'string') {
      return;
    }
    const location = config.locationOf(spec.key);
    const prefixText = spec.side === 'request' ? '$request' : '$response';
    const path = parseSelector(value, spec.side === 'request' ? REQUEST_PREFIX : RESPONSE_PREFIX);
    if (path === undefined) {
      ctx.report({
        message: `${prefix} must define a dot-delimited '${spec.key}' property starting with ${prefixText} (e.g. ${prefixText}.${spec.key})${suffix}.`,
        location,
      });
      return;
    }
    const lookup =
      spec.side === 'request'
        ? lookupRequestProperty(ctx, operation, path, spec.predicate)
        : lookupResponseProperty(ctx, responseSchema, path, spec.predicate);
    if (!lookup.valid) {
      const where =
        spec.side === 'request'
          ? path.length === 1
            ? 'an `in: query` parameter or request body property'
            : 'a request body property'
          : 'a property of the JSON success response';
      const requirement =
        spec.expected === ''
          ? `It must point to an existing ${where.replace(/^an? /, '')}.`
          : `It must point to ${where} whose type is ${spec.expected}.`;
      const message =
        spec.key === 'has-next-page'
          ? `"has-next-page" selector, ${value}, does not point to a boolean property${suffix}.`
          : `${prefix} specifies '${spec.key}' ${value}, which is not a valid '${spec.key}' type${suffix}. ${requirement}`;
      ctx.report({ message, location });
      return;
    }
    if (spec === RESULTS && !arraySchema(ctx, lookup.match!)) {
      ctx.report({
        message: `${prefix} specifies 'results' ${value}, which is not an array${suffix}. Fern pages through the items of the results property, so it should be an array.`,
        location,
        forceSeverity: 'warn',
      });
    }
  };

  for (const spec of specs.filter((candidate) => candidate.side === 'request')) {
    checkSpec(spec);
  }
  if (response.kind === 'none') {
    ctx.report({
      message: `${prefix} must define a response type${suffix}: ${describeMissingResponse(response.reason)}.`,
      location: config.locationOf(''),
    });
    return;
  }
  for (const spec of specs.filter((candidate) => candidate.side === 'response')) {
    checkSpec(spec, response.schema);
  }
}

export const validPagination: RuleDefinition = {
  name: 'valid-pagination',
  vendor: 'fern',
  sourceRules: ['fern-definition/valid-pagination'],
  severity: 'error',
  description:
    'x-fern-pagination must be well-formed and its selectors must point to request and response properties of the right type.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const document = rootOf(root, ctx);
        const rootConfig = isPlainObject(root) ? root[EXTENSION] : undefined;
        const rootLocation = ctx.location.child(EXTENSION);
        let rootKind: PaginationKind | undefined;
        if (typeof rootConfig === 'boolean') {
          ctx.report({
            message:
              'Global pagination extension is a boolean, expected an object. Only endpoints may declare a boolean for x-fern-pagination.',
            location: rootLocation,
          });
        } else if (rootConfig != null && !isPlainObject(rootConfig)) {
          ctx.report({
            message: `The document-level ${EXTENSION} must be an object.`,
            location: rootLocation,
          });
        } else if (rootConfig != null) {
          rootKind = checkShape(rootConfig, rootLocation, ctx);
        }

        for (const operation of getOperations(ctx, document)) {
          if (isIgnored(operation.node)) {
            continue;
          }
          const value = operation.node[EXTENSION];
          if (value == null) {
            continue;
          }
          const location = operation.location.child(EXTENSION);
          if (typeof value === 'boolean') {
            if (value === false) {
              ctx.report({
                message: `${EXTENSION}: false does not disable pagination: Fern treats it like true and applies the document-level ${EXTENSION}. Remove the extension instead.`,
                location,
                forceSeverity: 'warn',
              });
            }
            if (rootConfig == null) {
              ctx.report({
                message: `${EXTENSION}: ${value} inherits the document-level ${EXTENSION}, but the document does not declare one, so Fern generates no pagination for endpoint ${endpointId(operation)}.`,
                location,
                forceSeverity: 'warn',
              });
              continue;
            }
            if (rootKind !== undefined) {
              checkOperation(ctx, operation, {
                config: rootConfig,
                kind: rootKind,
                locationOf: () => location,
                inherited: true,
              });
            }
            continue;
          }
          if (!isPlainObject(value)) {
            ctx.report({
              message: `${EXTENSION} must be an object, or a boolean to inherit the document-level ${EXTENSION}.`,
              location,
            });
            continue;
          }
          const kind = checkShape(value, location, ctx);
          if (kind !== undefined) {
            checkOperation(ctx, operation, {
              config: value,
              kind,
              locationOf: (key) => (key === '' ? location : location.child(key)),
              inherited: false,
            });
          }
        }
      },
    },
  }),
};
