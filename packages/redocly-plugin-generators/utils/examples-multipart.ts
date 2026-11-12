import { isPlainObject, resolveNode } from './resolve.ts';
import { collectProperties, nonNullType, schemaTypes, unwrapSchema } from './schema.ts';
import type { AnyNode, Located, UserContext } from './types.ts';

/**
 * The parts of a `multipart/form-data` request body that Fern's example check sees. Fern imports
 * `type: string, format: binary` properties (and lists of them) as file parts; the example check
 * does not know file parts, so they are never required and are unexpected when present. The other
 * properties are validated like JSON body properties.
 */

type Ctx = Pick<UserContext, 'resolve'>;

export interface MultipartPart {
  key: string;
  schema: Located;
  file: boolean;
  required: boolean;
  nullable: boolean;
}

/** Whether a multipart property imports as a file (or a list of files). */
export function isFileSchema(ctx: Ctx, located: Located | undefined, depth = 0): boolean {
  const resolved = unwrapSchema(ctx, located);
  if (resolved === undefined || !isPlainObject(resolved.node) || depth > 8) {
    return false;
  }
  const type = nonNullType(resolved.node);
  if (type === 'array') {
    return isFileSchema(
      ctx,
      resolved.node.items === undefined
        ? undefined
        : {
            node: resolved.node.items,
            location: resolved.location.child('items'),
          },
      depth + 1,
    );
  }
  return type === 'string' && resolved.node.format === 'binary';
}

function requiredKeys(
  ctx: Ctx,
  located: Located | undefined,
  result = new Set<string>(),
  seen = new Set<string>(),
): Set<string> {
  const resolved = unwrapSchema(ctx, located);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return result;
  }
  const pointer = resolved.location.absolutePointer;
  if (seen.has(pointer)) {
    return result;
  }
  seen.add(pointer);
  if (Array.isArray(resolved.node.required)) {
    for (const key of resolved.node.required) {
      if (typeof key === 'string') {
        result.add(key);
      }
    }
  }
  if (Array.isArray(resolved.node.allOf)) {
    resolved.node.allOf.forEach((member: AnyNode, index: number) =>
      requiredKeys(ctx, { node: member, location: resolved.location.child(['allOf', index]) }, result, seen),
    );
  }
  return result;
}

/** The parts of a multipart body schema, or undefined when it is not an object with properties. */
export function multipartParts(ctx: Ctx, schema: Located | undefined): MultipartPart[] | undefined {
  const properties = collectProperties(ctx, schema);
  if (properties.length === 0) {
    return undefined;
  }
  const required = requiredKeys(ctx, schema);
  return properties.map((property) => {
    const resolved = resolveNode(ctx, property.schema.node, property.schema.location);
    return {
      key: property.key,
      schema: property.schema,
      file: isFileSchema(ctx, property.schema),
      required: required.has(property.key),
      nullable: schemaTypes(resolved?.node).includes('null'),
    };
  });
}
