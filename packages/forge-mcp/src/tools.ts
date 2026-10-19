import type { Field, Forge, Method, Model, Type } from '@cloudflare/forge/plugin';

import {
  CATALOGUE_FORMAT,
  type Catalogue,
  type CatalogueTool,
  type ParamRoute,
  type SkippedMethod,
  type ToolAnnotations,
} from './catalogue.ts';
import { SchemaBuilder } from './schema.ts';

/** MCP tool names are 1 to 128 characters. */
const MAX_NAME_LENGTH = 128;

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface CatalogueOptions {
  /**
   * Whether a method gets a tool. By default every method that isn't
   * deprecated. Hidden methods are included: `x-forge-hidden` keeps a method
   * out of listings such as a CLI's help while leaving it callable, and a
   * client can only call the tools `tools/list` returns.
   */
  include?(method: Method): boolean;
  /** A method's tool name. By default its group path and name in snake case, joined by `_`: `dns_records_create`. */
  name?(method: Method): string;
  /** Changes a tool after it is built, or drops it by returning `undefined`. */
  transform?(tool: CatalogueTool, method: Method): CatalogueTool | undefined;
}

/** A tool that couldn't be built, and why. */
class Skip extends Error {}

/** Builds the catalogue of every method in the forge. */
export function buildCatalogue(forge: Forge, options: CatalogueOptions = {}): Catalogue {
  const include = options.include ?? ((method: Method) => !method.deprecated);
  const name = options.name ?? defaultName;
  const schemas = new SchemaBuilder();
  const tools: CatalogueTool[] = [];
  const skipped: SkippedMethod[] = [];
  const names = new Set<string>();

  for (const group of forge.groups) {
    for (const method of group.methods) {
      if (!include(method)) {
        continue;
      }
      const skip = (reason: string) => skipped.push({ method: method.httpMethod, path: method.path, reason });
      try {
        let tool: CatalogueTool | undefined = buildTool(method, name(method), schemas);
        if (options.transform) {
          tool = options.transform(tool, method);
        }
        if (!tool) {
          continue;
        }
        if (tool.name.length > MAX_NAME_LENGTH) {
          throw new Skip(`tool name is over ${MAX_NAME_LENGTH} characters`);
        }
        if (names.has(tool.name)) {
          throw new Skip(`another method already has the tool name ${tool.name}`);
        }
        names.add(tool.name);
        tools.push(tool);
      } catch (err) {
        if (!(err instanceof Skip)) {
          throw err;
        }
        skip(err.message);
      }
    }
  }

  return { format: CATALOGUE_FORMAT, api: { version: forge.version, baseUrl: forge.baseUrl }, tools, skipped };
}

export function defaultName(method: Method): string {
  return [...method.group.path, method.name].map((part) => part.snake()).join('_');
}

/**
 * One method's tool. Path, query and header parameters are top-level
 * arguments named by the parameter in snake case; a JSON body is the `body`
 * argument, as the API takes it.
 */
function buildTool(method: Method, name: string, schemas: SchemaBuilder): CatalogueTool {
  const refs = new Set<Model>();
  const params: ParamRoute[] = [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const add = (key: string, schema: unknown, isRequired: boolean) => {
    properties[key] = schema;
    if (isRequired) {
      required.push(key);
    }
  };

  const located = parameterFields(method.request).flatMap((field) => {
    const location = method.location(field);
    return location ? [{ field, location }] : [];
  });
  const headers = (method.headers?.fields ?? []).filter((field) => !field.readOnly);
  const taken = new Set<string>();
  const keyFor = (field: Field, where: string) => {
    let key = field.name.snake() || field.wireName;
    if (taken.has(key)) {
      key = `${where}_${key}`;
    }
    if (taken.has(key)) {
      throw new Skip(`two arguments are both named ${key}`);
    }
    taken.add(key);
    return key;
  };

  for (const { field, location } of located) {
    const key = keyFor(field, location.in);
    add(key, schemas.field(field, refs), field.required || location.in === 'path');
    params.push(
      location.in === 'path'
        ? { key, name: field.wireName, in: 'path' }
        : { key, name: field.wireName, in: 'query', explode: location.exploded },
    );
  }
  for (const field of headers) {
    const key = keyFor(field, 'header');
    add(key, schemas.field(field, refs), field.required);
    params.push({ key, name: field.wireName, in: 'header' });
  }

  let body: CatalogueTool['request']['body'];
  if (method.body) {
    const json = method.body.json;
    if (json) {
      const key = taken.has('body') ? 'request_body' : 'body';
      if (taken.has(key)) {
        throw new Skip(`two arguments are both named ${key}`);
      }
      add(
        key,
        { ...schemas.type(json.type, refs), ...(method.body.description && { description: method.body.description }) },
        method.body.required,
      );
      body = { key, mediaType: json.mediaType };
    } else if (method.body.required) {
      throw new Skip(`the request body is not JSON (${method.body.contents.map((c) => c.mediaType).join(', ')})`);
    }
  }

  const defs = schemas.defs(refs);
  const title = method.summary || undefined;
  return {
    name,
    ...(title && { title }),
    description: describe(method),
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
      ...(defs && { $defs: defs }),
    },
    annotations: annotations(method, title),
    request: { method: method.httpMethod, path: method.path, params, ...(body && { body }) },
  };
}

/** The fields of a method's request: an object of parameters, or an intersection of parameters and the body. */
function parameterFields(request: Type | undefined): readonly Field[] {
  if (!request) {
    return [];
  }
  if (request.kind === 'object') {
    return request.fields;
  }
  if (request.kind === 'intersection') {
    return request.members.flatMap(parameterFields);
  }
  return [];
}

function describe(method: Method): string {
  const parts = [method.description || method.summary || `${method.httpMethod} ${method.path}`];
  if (method.availability && method.availability !== 'generally-available') {
    parts.push(`This method is ${method.availability}.`);
  }
  if (method.confirmation !== undefined) {
    parts.push(
      `Confirm with the user before calling this tool.${method.confirmation ? ` ${method.confirmation}` : ''}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Hints from the HTTP method. A method that needs confirmation is never
 * read-only and always destructive. Hints describe the method; they don't
 * authorize anything.
 */
function annotations(method: Method, title: string | undefined): ToolAnnotations {
  const verb = method.httpMethod.toUpperCase();
  const confirm = method.confirmation !== undefined;
  const readOnly = READ_ONLY_METHODS.has(verb) && !confirm;
  return {
    ...(title && { title }),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && (confirm || verb === 'DELETE' || verb === 'PUT'),
    idempotentHint: IDEMPOTENT_METHODS.has(verb),
    openWorldHint: true,
  };
}
