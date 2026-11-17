import Ajv2020 from '@redocly/ajv/dist/2020.js';
import type { ErrorObject, Options, ValidateFunction } from '@redocly/ajv/dist/2020.js';
import AjvDraft4 from '@redocly/ajv/dist/draft4.js';
import addFormats from 'ajv-formats';
import { isPlainObject, isRefNode } from './resolve.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

/**
 * Validates example values against OpenAPI schemas with Ajv, the way Redocly's
 * `no-invalid-media-type-examples` does: draft-04 for OAS 3.0 and 2020-12 for OAS 3.1+,
 * `$ref`s resolved through Redocly's resolver and `unevaluatedProperties: false` by default.
 * Only structure (types, required and unexpected properties, enums, constants, unions) is
 * reported; value constraints such as `maximum` or `pattern` are not, matching Fern.
 *
 * `readOnly` and `writeOnly` follow Fern's importer: both are accepted in request and response
 * examples, and a required `readOnly` property is optional (Fern imports it as `optional<T>`).
 */

type Dialect = '2020' | 'draft4';

type ValidatorContext = Pick<UserContext, 'resolve' | 'specVersion'>;

export interface ExampleError {
  /** Ajv keyword that failed. */
  keyword: string;
  /** Path segments from the example root to the failing value. */
  path: (string | number)[];
  /** Whether the problem is about a key (unexpected property). */
  onKey: boolean;
  /** Message in Fern's wording. */
  message: string;
}

interface AjvLike {
  compile(schema: AnyNode): ValidateFunction;
  addSchema(schema: AnyNode, key: string): void;
  getSchema(key: string): ValidateFunction | undefined;
  setDefaultUnevaluatedProperties(value: boolean): void;
}

const COMPOSITE_KEYWORDS = new Set(['oneOf', 'anyOf']);

/**
 * Value constraints Fern's example check does not enforce (in parameters or bodies, inline or
 * named): examples that violate them pass `fern check`.
 */
const UNCHECKED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

function dialectOf(specVersion: UserContext['specVersion']): Dialect {
  return specVersion === 'oas2' || specVersion === 'oas3_0' ? 'draft4' : '2020';
}

function schemaIdKey(dialect: Dialect): string {
  return dialect === 'draft4' ? 'id' : '$id';
}

function decodePointer(pointer: string): (string | number)[] {
  if (pointer === '') {
    return [];
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function valueAt(data: unknown, path: (string | number)[]): unknown {
  let current: unknown = data;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** `"hello"` for strings, `123` for numbers, JSON otherwise; matches Fern's "Example is: ..." output. */
export function describeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

function withArticle(type: string): string {
  switch (type) {
    case 'integer':
      return 'an integer';
    case 'object':
      return 'an object';
    case 'array':
      return 'a list';
    case 'null':
      return 'null';
    default:
      return `a ${type}`;
  }
}

function fernMessage(error: ErrorObject, value: unknown): string {
  const params = error.params as Record<string, AnyNode>;
  switch (error.keyword) {
    case 'type': {
      const types: string[] = Array.isArray(params.type) ? params.type : String(params.type).split(',');
      return `Expected example to be ${types.map(withArticle).join(' or ')}. Example is: ${describeValue(value)}`;
    }
    case 'required':
      return `Example is missing required property "${params.missingProperty}"`;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return `Unexpected property "${params.additionalProperty ?? params.unevaluatedProperty}"`;
    case 'enum': {
      const allowed: unknown[] = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      return `${describeValue(value)} is not a valid example for this enum. Enum values are: ${allowed.map(describeValue).join(', ')}`;
    }
    case 'const':
      return `Expected example to be ${describeValue(params.allowedValue)}. Example is: ${describeValue(value)}`;
    case 'oneOf':
      return 'Example must match exactly one of the oneOf schemas';
    case 'anyOf':
      return 'Example does not match any of the anyOf schemas';
    default:
      return `Example ${error.message ?? 'is invalid'}`;
  }
}

/**
 * Drops errors that are explained by an enclosing `oneOf`/`anyOf` failure: Ajv reports every
 * failing branch as well as the composite keyword, and Fern only reports that the union failed.
 */
function pruneBranchErrors(errors: ErrorObject[]): ErrorObject[] {
  const composites = errors.filter((error) => COMPOSITE_KEYWORDS.has(error.keyword));
  return errors.filter(
    (error) =>
      !composites.some(
        (composite) =>
          composite !== error &&
          error.instancePath.startsWith(composite.instancePath) &&
          error.schemaPath.startsWith(`${composite.schemaPath}/`),
      ),
  );
}

/** Keys whose values are example data rather than schemas. */
const DATA_KEYWORDS = new Set(['example', 'examples', 'enum', 'const', 'default']);

/** Keys whose values map names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

function isReadOnlyProperty(ctx: ValidatorContext, property: AnyNode, base: string): boolean {
  if (!isPlainObject(property)) {
    return false;
  }
  if (property.readOnly === true) {
    return true;
  }
  if (!isRefNode(property)) {
    return false;
  }
  const resolved: AnyNode = ctx.resolve(property, base).node;
  return isPlainObject(resolved) && resolved.readOnly === true;
}

/**
 * Copies a schema with `readOnly` properties removed from every `required` list, since Fern's
 * importer makes them optional. `base` is the file the schema lives in, for resolving `$ref`s.
 */
function withOptionalReadOnly(ctx: ValidatorContext, node: AnyNode, base: string): AnyNode {
  if (Array.isArray(node)) {
    return node.map((item) => withOptionalReadOnly(ctx, item, base));
  }
  if (!isPlainObject(node)) {
    return node;
  }
  const copy: Record<string, AnyNode> = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      copy[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, withOptionalReadOnly(ctx, schema, base)]),
      );
    } else {
      copy[key] = DATA_KEYWORDS.has(key) || key.startsWith('x-') ? value : withOptionalReadOnly(ctx, value, base);
    }
  }
  if (Array.isArray(node.required) && isPlainObject(node.properties)) {
    const properties = node.properties;
    copy.required = node.required.filter(
      (key: AnyNode) => typeof key !== 'string' || !isReadOnlyProperty(ctx, properties[key], base),
    );
  }
  return copy;
}

export class ExampleValidator {
  private readonly instances: Partial<Record<Dialect, AjvLike>> = {};
  private readonly synthetic = new Map<string, ValidateFunction>();

  private ajv(ctx: ValidatorContext, dialect: Dialect): AjvLike {
    const existing = this.instances[dialect];
    if (existing !== undefined) {
      return existing;
    }
    const idKey = schemaIdKey(dialect);
    const options: Options = {
      schemaId: idKey as '$id',
      meta: true,
      allErrors: true,
      strictSchema: false,
      inlineRefs: false,
      validateSchema: false,
      discriminator: true,
      allowUnionTypes: true,
      validateFormats: false,
      passContext: true,
      logger: false,
      loadSchemaSync(base: string, $ref: string, $id: string) {
        const decodedBase = decodeURI(base.split('#')[0]!);
        const resolved = ctx.resolve({ $ref }, decodedBase);
        if (resolved.location === undefined || !isPlainObject(resolved.node)) {
          return false;
        }
        return {
          [idKey]: `${encodeURI(resolved.location.source.absoluteRef)}#${$id}`,
          ...withOptionalReadOnly(ctx, resolved.node, resolved.location.source.absoluteRef),
        };
      },
    } as Options;
    // oxlint-disable-next-line typescript/no-explicit-any
    const Constructor: any = dialect === '2020' ? Ajv2020 : AjvDraft4;
    const instance = new Constructor(options) as AjvLike;
    // oxlint-disable-next-line typescript/no-explicit-any
    (addFormats as any)(instance);
    instance.setDefaultUnevaluatedProperties(false);
    this.instances[dialect] = instance;
    return instance;
  }

  private validatorFor(ctx: ValidatorContext, schema: Located): ValidateFunction | undefined {
    const dialect = dialectOf(ctx.specVersion);
    const ajv = this.ajv(ctx, dialect);
    let node = schema.node;
    let location = schema.location;
    if (isRefNode(node) && Object.keys(node).length === 1) {
      const resolved = ctx.resolve(node, location.source.absoluteRef);
      if (resolved.location === undefined || !isPlainObject(resolved.node)) {
        return undefined;
      }
      node = resolved.node;
      location = resolved.location;
    }
    if (!isPlainObject(node)) {
      return undefined;
    }
    const id = encodeURI(location.absolutePointer);
    try {
      if (ajv.getSchema(id) === undefined) {
        ajv.addSchema(
          {
            ...withOptionalReadOnly(ctx, node, location.source.absoluteRef),
            [schemaIdKey(dialect)]: id,
          },
          id,
        );
      }
      return ajv.getSchema(id);
    } catch {
      // Schemas Ajv cannot compile are reported by other rules (struct, no-unresolved-refs).
      return undefined;
    }
  }

  private syntheticValidator(ctx: ValidatorContext, schema: Record<string, unknown>): ValidateFunction | undefined {
    const dialect = dialectOf(ctx.specVersion);
    const key = `${dialect}:${JSON.stringify(schema)}`;
    const cached = this.synthetic.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const validate = this.ajv(ctx, dialect).compile(schema);
      this.synthetic.set(key, validate);
      return validate;
    } catch {
      return undefined;
    }
  }

  /**
   * Validates `data` against the schema at `schema` (a node in the document) or against a
   * standalone JSON schema object. Returns Fern-style errors with paths relative to `data`.
   */
  validate(
    ctx: ValidatorContext,
    data: unknown,
    schema: Located | { standalone: Record<string, unknown> },
  ): ExampleError[] {
    const validate =
      'standalone' in schema ? this.syntheticValidator(ctx, schema.standalone) : this.validatorFor(ctx, schema);
    if (validate === undefined) {
      return [];
    }
    let valid: boolean;
    try {
      valid = Boolean(
        validate.call({}, data, {
          instancePath: '',
          parentData: { fake: {} },
          parentDataProperty: 'fake',
          rootData: {},
          dynamicAnchors: {},
        } as never),
      );
    } catch {
      return [];
    }
    if (valid) {
      return [];
    }
    const result: ExampleError[] = [];
    const errors = (validate.errors ?? []).filter((error) => !UNCHECKED_KEYWORDS.has(error.keyword));
    for (const error of pruneBranchErrors(errors)) {
      const path = decodePointer(error.instancePath);
      const value = valueAt(data, path);
      // Fern treats strings starting with `$` as example references and does not validate them.
      if (typeof value === 'string' && value.startsWith('$')) {
        continue;
      }
      const params = error.params as Record<string, AnyNode>;
      const unexpected = error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties';
      result.push({
        keyword: error.keyword,
        path: unexpected ? [...path, String(params.additionalProperty ?? params.unevaluatedProperty)] : path,
        onKey: unexpected,
        message: fernMessage(error, value),
      });
    }
    return result;
  }
}

/** JSON pointer for messages, e.g. `/owner/name`. */
export function pointerOf(path: (string | number)[]): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** The location of `path` under `base`, pointing at the key when `onKey` is set. */
export function locationAt(base: Location, path: (string | number)[], onKey = false): Location {
  const location = path.length === 0 ? base : base.child(path);
  return onKey ? location.key() : location;
}
