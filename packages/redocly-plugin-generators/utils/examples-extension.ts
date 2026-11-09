import { isPlainObject, isRefNode, resolveNode } from './resolve.ts';
import type { AnyNode, Location, UserContext } from './types.ts';

/**
 * Reads an operation's `x-fern-examples` the way Fern's OpenAPI importer does: each entry is
 * parsed against Fern's `ExampleEndpointCallSchema`, and entries that do not match are dropped.
 */

export const EXAMPLE_KEYS = [
  'name',
  'docs',
  'id',
  'path-parameters',
  'query-parameters',
  'headers',
  'request',
  'response',
  'code-samples',
] as const;

export const SDK_LANGUAGES = [
  'curl',
  'python',
  'javascript',
  'typescript',
  'go',
  'ruby',
  'csharp',
  'java',
  'js',
  'node',
  'ts',
  'nodets',
  'golang',
  'dotnet',
  'jvm',
  'c#',
];

export interface SchemaProblem {
  message: string;
  location: Location;
}

export interface FernExampleEntry {
  index: number;
  node: AnyNode;
  location: Location;
  /** Problems that make Fern drop the entry. Empty when Fern keeps it. */
  problems: SchemaProblem[];
  /** Code samples Fern silently discards (the entry itself is kept). */
  droppedCodeSamples: SchemaProblem[];
}

export interface FernExamples {
  node: AnyNode;
  location: Location;
  /** Set when `x-fern-examples` is not a list. */
  notAList: boolean;
  entries: FernExampleEntry[];
}

type Ctx = Pick<UserContext, 'resolve'>;

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function checkOptionalString(
  entry: Record<string, AnyNode>,
  key: string,
  location: Location,
  label: string,
  problems: SchemaProblem[],
): void {
  if (!isAbsent(entry[key]) && typeof entry[key] !== 'string') {
    problems.push({
      message: `${label} must be a string`,
      location: location.child(key),
    });
  }
}

function checkResponse(response: AnyNode, location: Location, problems: SchemaProblem[]): void {
  if (isAbsent(response)) {
    return;
  }
  if (!isPlainObject(response)) {
    problems.push({
      message: '"response" must be an object with "body" and "error", or with "stream"',
      location,
    });
    return;
  }
  if (Array.isArray(response.stream)) {
    const unknown = Object.keys(response).filter((key) => key !== 'stream');
    for (const key of unknown) {
      problems.push({
        message: `Unexpected key "${key}" in a streaming "response" (only "stream" is allowed)`,
        location: location.child(key).key(),
      });
    }
    return;
  }
  for (const key of Object.keys(response)) {
    if (key === 'stream') {
      problems.push({
        message: '"response.stream" must be a list',
        location: location.child(key),
      });
    } else if (key !== 'body' && key !== 'error') {
      problems.push({
        message: `Unexpected key "${key}" in "response" (allowed keys: body, error, stream)`,
        location: location.child(key).key(),
      });
    }
  }
  if (!isAbsent(response.error) && typeof response.error !== 'string') {
    problems.push({
      message: '"response.error" must be a string naming the error',
      location: location.child('error'),
    });
  }
}

function isCodeReference(value: unknown): boolean {
  return isRefNode(value);
}

function checkCodeSamples(
  samples: AnyNode,
  location: Location,
  problems: SchemaProblem[],
  dropped: SchemaProblem[],
): void {
  if (isAbsent(samples)) {
    return;
  }
  if (!Array.isArray(samples)) {
    dropped.push({
      message: '"code-samples" must be a list; Fern ignores it',
      location,
    });
    return;
  }
  samples.forEach((sample: AnyNode, index: number) => {
    const sampleLocation = location.child(index);
    if (!isPlainObject(sample)) {
      dropped.push({
        message: 'Code sample must be an object; Fern ignores it',
        location: sampleLocation,
      });
      return;
    }
    if (typeof sample.code !== 'string' && !isCodeReference(sample.code)) {
      dropped.push({
        message: 'Code sample has no "code" string (or {$ref} to a file); Fern ignores it',
        location: sampleLocation,
      });
      return;
    }
    const sampleProblems: SchemaProblem[] = [];
    const isSdk = sample.sdk !== undefined;
    const allowed = isSdk ? ['sdk', 'code', 'name', 'docs'] : ['language', 'code', 'install', 'name', 'docs'];
    if (isSdk) {
      if (typeof sample.sdk !== 'string' || !SDK_LANGUAGES.includes(sample.sdk)) {
        sampleProblems.push({
          message: `Code sample "sdk" must be one of: ${SDK_LANGUAGES.join(', ')}`,
          location: sampleLocation.child('sdk'),
        });
      }
    } else if (typeof sample.language !== 'string') {
      sampleProblems.push({
        message: 'Code sample needs a "language" string or an "sdk"',
        location: sampleLocation,
      });
    }
    for (const key of Object.keys(sample)) {
      if (!allowed.includes(key)) {
        sampleProblems.push({
          message: `Unexpected key "${key}" in code sample (allowed keys: ${allowed.join(', ')})`,
          location: sampleLocation.child(key).key(),
        });
      }
    }
    for (const key of ['name', 'docs', ...(isSdk ? [] : ['install'])]) {
      checkOptionalString(sample, key, sampleLocation, `Code sample "${key}"`, sampleProblems);
    }
    problems.push(...sampleProblems);
  });
}

function parseEntry(node: AnyNode, index: number, location: Location): FernExampleEntry {
  const problems: SchemaProblem[] = [];
  const droppedCodeSamples: SchemaProblem[] = [];
  if (!isPlainObject(node)) {
    problems.push({ message: 'Entry must be an object', location });
    return { index, node, location, problems, droppedCodeSamples };
  }
  for (const key of Object.keys(node)) {
    if (!(EXAMPLE_KEYS as readonly string[]).includes(key)) {
      problems.push({
        message: `Unexpected key "${key}" (allowed keys: ${EXAMPLE_KEYS.join(', ')})`,
        location: location.child(key).key(),
      });
    }
  }
  for (const key of ['name', 'docs', 'id']) {
    checkOptionalString(node, key, location, `"${key}"`, problems);
  }
  for (const key of ['path-parameters', 'query-parameters', 'headers']) {
    if (!isAbsent(node[key]) && !isPlainObject(node[key])) {
      problems.push({
        message: `"${key}" must be an object mapping names to example values`,
        location: location.child(key),
      });
    }
  }
  checkResponse(node.response, location.child('response'), problems);
  checkCodeSamples(node['code-samples'], location.child('code-samples'), problems, droppedCodeSamples);
  return { index, node, location, problems, droppedCodeSamples };
}

/** The operation's `x-fern-examples`, if present. */
export function readFernExamples(ctx: Ctx, operation: { node: AnyNode; location: Location }): FernExamples | undefined {
  if (!isPlainObject(operation.node)) {
    return undefined;
  }
  const raw = operation.node['x-fern-examples'];
  if (raw === undefined) {
    return undefined;
  }
  const resolved = resolveNode(ctx, raw, operation.location.child('x-fern-examples'));
  if (resolved === undefined) {
    return undefined;
  }
  if (!Array.isArray(resolved.node)) {
    return {
      node: resolved.node,
      location: resolved.location,
      notAList: resolved.node !== null,
      entries: [],
    };
  }
  return {
    node: resolved.node,
    location: resolved.location,
    notAList: false,
    entries: resolved.node.map((entry: AnyNode, index: number) =>
      parseEntry(entry, index, resolved.location.child(index)),
    ),
  };
}

/** Entries Fern keeps after parsing. */
export function keptEntries(examples: FernExamples): FernExampleEntry[] {
  return examples.entries.filter((entry) => entry.problems.length === 0);
}

/** Whether an entry has no request, response or parameters (Fern calls these incomplete). */
export function isIncompleteExample(entry: FernExampleEntry): boolean {
  const node = entry.node;
  return (
    isAbsent(node.request) &&
    isAbsent(node.response) &&
    isAbsent(node['query-parameters']) &&
    isAbsent(node['path-parameters']) &&
    isAbsent(node.headers)
  );
}

/** Entries Fern's validator skips: nothing but code samples. */
export function isCodeSamplesOnly(entry: FernExampleEntry): boolean {
  return isIncompleteExample(entry) && !isAbsent(entry.node['code-samples']);
}
