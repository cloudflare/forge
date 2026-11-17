import { rootValue } from './extensions-servers.ts';
import { isPlainObject } from './resolve.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

/** `x-fern-base-path` in either the string or the structured form. */
export interface BasePathExtension {
  /** The extension value. */
  value: Located;
  form: 'string' | 'object' | 'invalid';
  /** The base path string, when it is one. */
  path: string | undefined;
  /** Where the base path string lives. */
  pathLocation: Location;
  /** The structured form's `parameters` map. */
  parameters: Located | undefined;
  pathsIncludeBasePath: AnyNode;
}

export function readBasePath(ctx: Ctx, root: Located): BasePathExtension | undefined {
  const value = rootValue(ctx, root, 'x-fern-base-path');
  if (value === undefined) {
    return undefined;
  }
  if (typeof value.node === 'string') {
    return {
      value,
      form: 'string',
      path: value.node,
      pathLocation: value.location,
      parameters: undefined,
      pathsIncludeBasePath: undefined,
    };
  }
  if (!isPlainObject(value.node)) {
    return {
      value,
      form: 'invalid',
      path: undefined,
      pathLocation: value.location,
      parameters: undefined,
      pathsIncludeBasePath: undefined,
    };
  }
  const parameters = value.node.parameters;
  return {
    value,
    form: 'object',
    path: typeof value.node.path === 'string' ? value.node.path : undefined,
    pathLocation: value.location.child(['path']),
    parameters:
      parameters === undefined || parameters === null
        ? undefined
        : { node: parameters, location: value.location.child(['parameters']) },
    pathsIncludeBasePath: value.node['paths-include-base-path'],
  };
}
