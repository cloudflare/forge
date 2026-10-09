/**
 * OpenAPI File Loaders
 *
 * Loaders for OpenAPI specs serialized as JSON or YAML. They are ordinary
 * `OpenApiLoader`s; the registry in `openapi-source.ts` does not know about
 * them.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { OpenApiLoader, OpenApiSourceDocument } from './openapi-source.js';
import { isOpenApiDocument } from './shared/openapi-document.js';

/** An OpenAPI spec serialized as JSON. */
export type JsonOpenApiSource = {
  format: 'json';
  /** File path or `file:` URL object. */
  location: string | URL;
};

/** An OpenAPI spec serialized as YAML. */
export type YamlOpenApiSource = {
  format: 'yaml';
  /** File path or `file:` URL object. */
  location: string | URL;
};

async function readSpec(location: string | URL): Promise<string> {
  try {
    return await readFile(location, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read the OpenAPI spec (${String(location)})`, { cause });
  }
}

function parseSpec(
  location: string | URL,
  syntax: string,
  raw: string,
  parse: (raw: string) => unknown,
): OpenApiSourceDocument {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (cause) {
    throw new Error(`The OpenAPI spec is not valid ${syntax} (${String(location)})`, { cause });
  }
  if (!isOpenApiDocument(parsed)) {
    throw new Error(
      `The OpenAPI spec is not an OpenAPI 3.x document with string \`openapi\`, \`info.title\` and \`info.version\` fields and a \`paths\` object (${String(location)})`,
    );
  }
  return { name: parsed.info.title, document: parsed };
}

// RFC 8259 lets JSON parsers ignore a leading byte order mark, which some editors write.
function parseJsonSpec(raw: string): unknown {
  return JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
}

// OpenAPI recommends YAML 1.2 limited to the tags of its JSON schema, so that a spec reads the same
// as YAML and as JSON; the yaml package's default YAML 1.2 core schema reads it so, keeping unquoted
// dates as strings. Merge keys, from YAML 1.1, are applied as js-yaml applies them by default, and
// alias expansion is not capped: the cap guards untrusted input, and a spec is the caller's own file.
// The yaml package returns an aliased node as one shared object, so the result is copied into a
// tree of its own, as `JSON.parse` returns, so that changing one operation never changes another.
function parseYamlSpec(raw: string): unknown {
  return JSON.parse(JSON.stringify(parseYaml(raw, { merge: true, maxAliasCount: -1 })));
}

/** Reads OpenAPI specs serialized as JSON. */
export function jsonLoader(): OpenApiLoader<JsonOpenApiSource> {
  return {
    format: 'json',
    load: async ({ location }) => [parseSpec(location, 'JSON', await readSpec(location), parseJsonSpec)],
  };
}

/** Reads OpenAPI specs serialized as YAML. */
export function yamlLoader(): OpenApiLoader<YamlOpenApiSource> {
  return {
    format: 'yaml',
    load: async ({ location }) => [parseSpec(location, 'YAML', await readSpec(location), parseYamlSpec)],
  };
}
