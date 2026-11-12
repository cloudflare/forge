/**
 * Validates Fern type references written in Fern's type syntax: schema-level `x-fern-type` and
 * the `type` of `x-fern-global-headers` / `x-fern-idempotency-headers` entries. Named types must
 * be keys of `components.schemas` (Fern turns anything else into `unknown`), map keys must be
 * primitives (Fern ignores the whole type otherwise), and `file`, `text` and `bytes` cannot be
 * expressed this way (Fern turns them into `unknown`, except where the media type already
 * determines the body). Broken `$ref`s are left to Redocly's `no-unresolved-refs`.
 */
import { rootOf } from '../utils/document.ts';
import { describeValue } from '../utils/extensions.ts';
import { rootValue } from '../utils/extensions-servers.ts';
import {
  formatFernType,
  isTypeNameSyntax,
  namedTypes,
  nonPrimitiveMapKeys,
  parseFernType,
} from '../utils/fern-type.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

interface FernTypeUsage {
  value: AnyNode;
  location: Location;
  label: string;
  /** Whether the type sits on a header (`x-fern-global-headers` / `x-fern-idempotency-headers`). */
  header: boolean;
  /** A special type that has no effect at this location because Fern ignores the schema there. */
  ignoredSpecialType?: string | undefined;
}

const SPECIAL_TYPES: Record<string, string> = {
  file: 'The file type can only be used as properties in inlined requests, which {label} cannot express; Fern treats it as unknown, so the value is no longer uploaded as a file. Use a multipart/form-data request property with type: string and format: binary instead.',
  text: 'The text type can only be used as a response or response-stream, which {label} cannot express; Fern treats it as unknown. Use a text/plain response instead.',
  bytes:
    'The bytes type can only be used as a request, which {label} cannot express; Fern treats it as unknown. Use an application/octet-stream request body instead.',
};

/**
 * `text` on a `text/plain` response schema and `bytes` on an `application/octet-stream` request
 * body schema have no effect: Fern derives those bodies from the media type, not the schema.
 */
function ignoredSpecialType(pointer: string): string | undefined {
  if (/\/responses\/[^/]+\/content\/text~1plain\/schema$/.test(pointer)) {
    return 'text';
  }
  if (pointer.endsWith('/requestBody/content/application~1octet-stream/schema')) {
    return 'bytes';
  }
  return undefined;
}

function checkUsage(ctx: UserContext, usage: FernTypeUsage, schemaNames: Set<string>): void {
  const { value, location, label, header } = usage;
  if (typeof value !== 'string') {
    ctx.report({
      message: `${label} must be a string in Fern's type syntax (for example optional<list<string>>); got ${describeValue(value)}. ${header ? 'Fern fails to import the document.' : 'Fern cannot convert it and turns the schema that contains it into unknown.'}`,
      location,
    });
    return;
  }
  const parsed = parseFernType(value);
  const mapKeys = nonPrimitiveMapKeys(parsed);
  if (mapKeys.length > 0) {
    for (const key of mapKeys) {
      ctx.report({
        message: `${label} '${value}' uses '${formatFernType(key)}' as a map key, but map keys must be primitive types; Fern ignores this type and falls back to ${header ? 'string' : "the schema's own type"}.`,
        location,
      });
    }
    return;
  }
  const reported = new Set<string>();
  for (const name of namedTypes(parsed)) {
    if (reported.has(name)) {
      continue;
    }
    reported.add(name);
    const special = SPECIAL_TYPES[name];
    if (special !== undefined) {
      if (name !== usage.ignoredSpecialType || value !== name) {
        ctx.report({
          message: special.replace('{label}', label),
          location,
        });
      }
    } else if (!schemaNames.has(name)) {
      ctx.report({
        message: isTypeNameSyntax(name)
          ? `Type ${name} is not defined. ${label} '${value}' references it, but it is neither a Fern primitive nor a key of components.schemas, so Fern treats it as unknown.`
          : `Type ${name} is not defined. ${label} '${value}' is not valid Fern type syntax: '${name}' is neither a primitive, a container such as list<...> or map<..., ...>, nor a key of components.schemas, so Fern treats it as unknown.`,
        location,
      });
    }
  }
}

function headerUsages(ctx: UserContext, rootNode: AnyNode, key: string): FernTypeUsage[] {
  const root = rootOf(rootNode, ctx);
  const headers = rootValue(ctx, root, key);
  if (headers === undefined || !Array.isArray(headers.node)) {
    return [];
  }
  const usages: FernTypeUsage[] = [];
  headers.node.forEach((_header: AnyNode, index: number) => {
    const header = resolveChild(ctx, headers, index);
    if (
      header === undefined ||
      !isPlainObject(header.node) ||
      header.node.type === undefined ||
      header.node.type === null
    ) {
      return;
    }
    usages.push({
      value: header.node.type,
      location: header.location.child(['type']),
      label: `${key} type`,
      header: true,
    });
  });
  return usages;
}

export const noUndefinedTypeReference: RuleDefinition = {
  name: 'no-undefined-type-reference',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-undefined-type-reference'],
  severity: 'error',
  description: "Types written in Fern's type syntax (x-fern-type, header type) parse and reference schemas that exist.",
  rule: () => {
    let usages: FernTypeUsage[] = [];
    return {
      Root: {
        enter() {
          usages = [];
        },
        leave(rootNode: AnyNode, ctx: UserContext) {
          const root = rootOf(rootNode, ctx);
          const components = resolveChild(ctx, root, 'components');
          const schemas = components === undefined ? undefined : resolveChild(ctx, components, 'schemas');
          const schemaNames = new Set(
            schemas !== undefined && isPlainObject(schemas.node) ? Object.keys(schemas.node) : [],
          );
          for (const usage of [
            ...headerUsages(ctx, rootNode, 'x-fern-global-headers'),
            ...headerUsages(ctx, rootNode, 'x-fern-idempotency-headers'),
            ...usages,
          ]) {
            checkUsage(ctx, usage, schemaNames);
          }
        },
      },
      Schema(schema: AnyNode, ctx: UserContext) {
        if (!isPlainObject(schema) || schema['x-fern-type'] === undefined || schema['x-fern-type'] === null) {
          return;
        }
        usages.push({
          value: schema['x-fern-type'],
          location: ctx.location.child(['x-fern-type']),
          label: 'x-fern-type',
          header: false,
          ignoredSpecialType: ignoredSpecialType(ctx.location.pointer),
        });
      },
    };
  },
};
