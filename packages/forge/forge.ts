import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, normalize, resolve } from 'node:path';
import { OpenAPIV3 } from 'openapi-types';
import { matchResponseStatusKey, type ResponseInfo, resolveOperation } from './openapi-resolver.js';
import type { Schema } from './schema/schema.js';
import { walkAllMethods } from './shared/schema-utils.js';

/**
 * A transformer is a function that receives a Forge instance and uses it to
 * generate code. The transformer calls `forge.emit()` to produce output files.
 */
export type TransformerFn = (forge: Forge) => Promise<void>;

/**
 * A leaf (method name string) or branch ({ groupName: children[] }) in the method map.
 */
export type MethodMapEntry = string | Record<string, MethodMapEntry[]>;

/**
 * A generated source file — pairs a relative path with its content.
 *
 * Returned by `forge.transform()` so callers can inspect every file that was
 * produced, and accepted by `forge.finalize()` to write them to disk.
 */
export class SourceFile {
  constructor(
    /** Relative file path (e.g. "resources/d1.ts") */
    readonly path: string,
    /** File content */
    readonly content: string,
  ) {}

  /** Returns the file content. */
  toString(): string {
    return this.content;
  }
}

/**
 * Forge — the plugin host for code-generation transformers.
 *
 * ## Creating an instance
 *
 * Use the async `init()` factory (see `init.ts` for why this is not a
 * constructor — overlay resolution requires async I/O):
 *
 * ```ts
 * import { init } from '@cloudflare/forge';
 * const forge = await init(openapi);
 * ```
 *
 * Or construct directly with an already-resolved OpenAPI document:
 *
 * ```ts
 * const forge = new Forge(overlaidOpenApiDoc);
 * forge.commands.set('d1', d1Schema);
 * ```
 *
 * ## Running a transformer
 *
 * ```ts
 * const files = await forge.transform(myTransformer);
 * ```
 *
 * ## Writing to disk
 *
 * ```ts
 * await forge.finalize('./output', files, { clean: true });
 * ```
 */
export class Forge {
  readonly #openapi: OpenAPIV3.Document;

  #byOperationId: Record<string, OpenAPIV3.OperationObject> = {};
  #verbPathByOperationId: Record<string, string> = {};

  /**
   * Overlay command schemas keyed by product name (e.g. "d1", "dns", "zones").
   */
  readonly commands = new Map<string, Schema.command>();

  /**
   * Files buffered by `emit()`, drained by `transform()`.
   */
  readonly #files: SourceFile[] = [];

  constructor(openapi: OpenAPIV3.Document) {
    this.#openapi = openapi;
    this.#createByOperationId();
  }

  // ---------------------------------------------------------------------------
  // Method introspection
  // ---------------------------------------------------------------------------

  /**
   * Build a hierarchical method map from all commands.
   * Returns an array of `{ commandName: [...methods/groups] }` objects,
   * sorted by command name. Each leaf is a method name string; each branch
   * is `{ groupName: [...children] }`.
   */
  methodMap(): Record<string, MethodMapEntry[]>[] {
    type TreeNode = { methods: string[]; groups: Map<string, TreeNode> };

    const mkNode = (): TreeNode => ({ methods: [], groups: new Map() });

    const pushUnique = (arr: string[], v: string) => {
      if (!arr.includes(v)) arr.push(v);
    };

    const addToTree = (root: TreeNode, groupPath: string | undefined, methodName: string) => {
      if (!groupPath) {
        pushUnique(root.methods, methodName);
        return;
      }
      let cursor = root;
      for (const seg of groupPath.split('.').filter(Boolean)) {
        const child = cursor.groups.get(seg) ?? mkNode();
        cursor.groups.set(seg, child);
        cursor = child;
      }
      pushUnique(cursor.methods, methodName);
    };

    const treeToList = (node: TreeNode): MethodMapEntry[] => {
      const entries = [
        ...node.methods.map((m) => ({ key: m, item: m as MethodMapEntry })),
        ...Array.from(node.groups.entries()).map(([name, child]) => ({
          key: name,
          item: { [name]: treeToList(child) } as MethodMapEntry,
        })),
      ].sort((a, b) => a.key.localeCompare(b.key));
      return entries.map((e) => e.item);
    };

    const trees = new Map<string, TreeNode>();
    for (const [commandName, schema] of this.commands) {
      const root = trees.get(commandName) ?? mkNode();
      trees.set(commandName, root);
      walkAllMethods(schema.methods, (method, groupPath) => {
        addToTree(root, groupPath, method.name);
      });
    }

    return [...trees.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, node]) => ({ [name]: treeToList(node) }));
  }

  /**
   * Compute statistics about methods across all commands.
   * Returns total count and a breakdown by method name (descending by frequency).
   */
  methodStats(): { total: number; byMethod: Record<string, number> } {
    const counts: Record<string, number> = {};
    let total = 0;

    for (const [_name, schema] of this.commands) {
      walkAllMethods(schema.methods, (method) => {
        counts[method.name] = (counts[method.name] ?? 0) + 1;
        total++;
      });
    }

    const sorted = Object.fromEntries(Object.entries(counts).sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b)));

    return { total, byMethod: sorted };
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  /**
   * Buffer a generated file. Call this from a transformer to produce output.
   *
   * @param path Relative file path (e.g. "resources/d1.ts")
   * @param content File content
   */
  emit(path: string, content: string): void {
    this.#files.push(new SourceFile(path, content));
  }

  /**
   * Run a transformer function, then drain the emit buffer and return every
   * file that was produced as a `SourceFile[]`.
   *
   * The buffer is cleared after this call so the same Forge instance can be
   * reused for another transformer. Pass the returned array to `finalize()`
   * to write the files to disk.
   */
  async transform(fn: TransformerFn): Promise<SourceFile[]> {
    await fn(this);
    const snapshot = [...this.#files];
    this.#files.length = 0;
    return snapshot;
  }

  /**
   * Write an array of `SourceFile`s to disk under `outputDir`.
   * Creates directories as needed. Optionally cleans the output directory first.
   * Returns the same array for chaining.
   */
  async finalize(outputDir: string, files: SourceFile[], options?: { clean?: boolean }): Promise<SourceFile[]> {
    const resolvedOutputDir = resolve(outputDir);

    if (options?.clean) {
      await rm(resolvedOutputDir, { recursive: true, force: true });
    }

    // Collect unique directories first, then create them all before writing
    const dirs = new Set<string>();
    const resolvedFiles = new Map<string, string>();

    for (const file of files) {
      const fullPath = resolve(resolvedOutputDir, normalize(file.path));

      // Guard against path traversal — every output file must land inside outputDir
      if (!fullPath.startsWith(resolvedOutputDir)) {
        throw new Error(`Path traversal detected: "${file.path}" resolves outside output directory`);
      }

      dirs.add(dirname(fullPath));
      resolvedFiles.set(fullPath, file.content);
    }

    // Create all directories in parallel
    await Promise.all(Array.from(dirs).map((dir) => mkdir(dir, { recursive: true })));

    // Write all files in parallel
    await Promise.all(Array.from(resolvedFiles.entries()).map(([fullPath, content]) => writeFile(fullPath, content)));

    return files;
  }

  // ---------------------------------------------------------------------------
  // OpenAPI queries
  // ---------------------------------------------------------------------------

  #createByOperationId() {
    const byOperationId: Record<string, OpenAPIV3.OperationObject> = {};
    const duplicateOperationIds: Record<string, OpenAPIV3.OperationObject[]> = {};
    for (const [path, pathItem] of Object.entries(this.#openapi.paths)) {
      if (!pathItem) continue;

      const methods: Array<OpenAPIV3.HttpMethods> = [
        OpenAPIV3.HttpMethods.GET,
        OpenAPIV3.HttpMethods.PUT,
        OpenAPIV3.HttpMethods.POST,
        OpenAPIV3.HttpMethods.DELETE,
        OpenAPIV3.HttpMethods.OPTIONS,
        OpenAPIV3.HttpMethods.HEAD,
        OpenAPIV3.HttpMethods.PATCH,
        OpenAPIV3.HttpMethods.TRACE,
      ];

      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation || !operation.operationId) continue;

        const operationId = operation.operationId.replace(/'/g, '');

        if (operationId in byOperationId) {
          if (operationId in duplicateOperationIds) {
            duplicateOperationIds[operationId]?.push(operation);
          } else {
            const existingOperation = byOperationId[operationId];
            if (existingOperation) {
              duplicateOperationIds[operationId] = [existingOperation, operation];
            }
          }
        } else {
          byOperationId[operationId] = operation;
          this.#verbPathByOperationId[operationId] = `${method.toUpperCase()} ${path}`;
        }
      }
    }
    this.#byOperationId = Object.fromEntries(
      Object.entries(byOperationId).toSorted((a, b) => a[0].localeCompare(b[0])),
    );

    if (Object.keys(duplicateOperationIds).length > 0) {
      console.error(JSON.stringify(Object.keys(duplicateOperationIds), null, 2));
      throw new Error(`Duplicate operation ids found ${Object.keys(duplicateOperationIds)}`);
    }
  }

  getMissingDescriptions(updates: Record<string, string> = {}) {
    const missingDescriptions: string[] = [];
    for (const [operationId, operation] of Object.entries(this.#byOperationId)) {
      if (!operation.description && !updates[operationId]) {
        missingDescriptions.push(operationId);
      }
    }
    console.log(JSON.stringify({ missingDescriptions }, null, 2));
    console.log(
      `${missingDescriptions.length} missing descriptions out of ${Object.keys(this.#byOperationId).length} (${((missingDescriptions.length / Object.keys(this.#byOperationId).length) * 100).toFixed(2)}%)`,
    );
    return missingDescriptions;
  }

  /**
   * The internal lookup tables are keyed by operationId with apostrophes
   * stripped (see the population loop above). Normalize callers' input so
   * passing in the literal spec id (with apostrophes, e.g.
   * 'workers-kv-namespace-list-a-namespace\\'-s-keys') still finds it.
   */
  #normalizeOperationId(operationId: string): string {
    return operationId.replace(/'/g, '');
  }

  getDescription(operationId: string): string {
    const id = this.#normalizeOperationId(operationId);
    const operation = this.#byOperationId[id];
    if (!operation) {
      throw new Error(`Operation id ${operationId} not found`);
    }

    const description = operation.description ?? operation.summary;
    if (!description) {
      throw new Error(`Operation id ${operationId} has no description`);
    }

    return description;
  }

  /**
   * Get the description for an operation, returning `undefined` when none exists.
   */
  getOperationDescription(operationId: string): string | undefined {
    const operation = this.#byOperationId[this.#normalizeOperationId(operationId)];
    if (!operation) return undefined;
    return operation.description ?? operation.summary;
  }

  /**
   * Get the short, single-line `summary` for an operation, returning `undefined`
   * when the upstream spec has none. Kept distinct from `getOperationDescription`
   * (which prefers the longer `description`) so consumers can surface the crisp
   * one-line label separately from the full body.
   */
  getOperationSummary(operationId: string): string | undefined {
    const operation = this.#byOperationId[this.#normalizeOperationId(operationId)];
    if (!operation) return undefined;
    return operation.summary;
  }

  getOperationIds() {
    return Object.keys(this.#byOperationId).toSorted();
  }

  getVerbPath(operationId: string): string | undefined {
    return this.#verbPathByOperationId[this.#normalizeOperationId(operationId)];
  }

  /**
   * Get a map of parameter name -> description for all parameters of an operation.
   * Resolves $ref chains to find descriptions on component schemas.
   */
  getParameterDescriptions(operationId: string): Map<string, string> {
    const id = this.#normalizeOperationId(operationId);
    const operation = this.#byOperationId[id];
    if (!operation) {
      throw new Error(`Operation id ${operationId} not found`);
    }

    const descriptions = new Map<string, string>();

    if (operation.parameters) {
      for (const paramOrRef of operation.parameters) {
        const param = this.#resolveRef(paramOrRef) as OpenAPIV3.ParameterObject | undefined;
        if (!param || !param.name) continue;

        if (param.description) {
          descriptions.set(param.name, param.description);
          continue;
        }

        if (param.schema) {
          const schema = this.#resolveRef(param.schema) as OpenAPIV3.SchemaObject | undefined;
          if (schema?.description) {
            descriptions.set(param.name, schema.description);
          }
        }
      }
    }

    const bodySchema = operation.requestBody
      ? (this.#resolveRef(operation.requestBody) as OpenAPIV3.RequestBodyObject | undefined)
      : undefined;
    const jsonSchema = bodySchema?.content?.['application/json']?.schema;
    if (jsonSchema) {
      this.#collectPropertyDescriptions(jsonSchema, descriptions);
    }

    return descriptions;
  }

  /**
   * Look up the response declared on an operation for an actual HTTP status code.
   *
   * Implements OpenAPI 3 status-code matching precedence over the operation's
   * declared response keys:
   *
   *   1. **Exact** — `status` matches a literal numeric key (e.g. `401` ↔ `"401"`).
   *   2. **Range** — falls back to the matching range bucket (`"2XX"`, `"4XX"`,
   *      `"5XX"`, ...). Both uppercase (spec form) and lowercase (real-world
   *      form) are accepted.
   *   3. **Default** — falls back to the `"default"` key if present.
   *   4. **No match** — returns `undefined`. Callers should treat this as
   *      "the spec doesn't tell us what to expect for this status."
   *
   * The returned `ResponseInfo` is the same per-status entry exposed on
   * `OperationInfo.responses`, with content keyed by media type and the
   * top-level `$ref` of each body schema already resolved. Use
   * `resolveDocRef` / `resolveSchemaRef` (re-exported from the resolver)
   * to walk any nested `$ref`s within the schema.
   *
   * @see {@link https://spec.openapis.org/oas/v3.1.0#responses-object}
   *
   * @param operationId  Spec operation id. Apostrophes are stripped for
   *                     lookup, matching the rest of this class.
   * @param status       Numeric HTTP status code (e.g. `200`, `401`, `503`).
   * @returns The matching `ResponseInfo`, or `undefined` if the operation
   *          isn't known or no response key matches the status.
   *
   * @example
   * ```ts
   * // Operation declares "200" and "4XX".
   * forge.matchResponseStatus('ip-address-management-prefixes-download-loa-document', 200)
   *   // → { content: { 'application/pdf': { schema, ref: null, ... } } }
   * forge.matchResponseStatus('ip-address-management-prefixes-download-loa-document', 401)
   *   // → matches "4XX": { content: { 'application/json': { ... } } }
   * forge.matchResponseStatus('ip-address-management-prefixes-download-loa-document', 503)
   *   // → matches "4XX"? No — 503 is in the 5XX bucket. Returns undefined
   *   //   unless the operation also declares "5XX" or "default".
   * ```
   */
  matchResponseStatus(operationId: string, status: number): ResponseInfo | undefined {
    const info = resolveOperation(this.#normalizeOperationId(operationId));
    if (!info) return undefined;
    const key = matchResponseStatusKey(status, Object.keys(info.responses));
    if (key === undefined) return undefined;
    return info.responses[key];
  }

  #resolveRef(obj: unknown): unknown {
    if (!obj || typeof obj !== 'object') return obj;
    const refObj = obj as { $ref?: string };
    if (!refObj.$ref) return obj;

    const parts = refObj.$ref.replace(/^#\//, '').split('/');
    let current: unknown = this.#openapi;
    for (const part of parts) {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  #collectPropertyDescriptions(
    schemaOrRef: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    descriptions: Map<string, string>,
    visited: Set<unknown> = new Set(),
  ): void {
    const schema = this.#resolveRef(schemaOrRef) as OpenAPIV3.SchemaObject | undefined;
    if (!schema) return;
    if (visited.has(schema)) return;
    visited.add(schema);

    if (schema.properties) {
      for (const [name, propOrRef] of Object.entries(schema.properties)) {
        if (descriptions.has(name)) continue;
        const prop = this.#resolveRef(propOrRef) as OpenAPIV3.SchemaObject | undefined;
        if (prop?.description) {
          descriptions.set(name, prop.description);
        }
      }
    }

    if (schema.allOf) {
      for (const item of schema.allOf) {
        this.#collectPropertyDescriptions(item, descriptions, visited);
      }
    }

    for (const key of ['anyOf', 'oneOf'] as const) {
      const variants = (schema as Record<string, unknown>)[key] as
        | (OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject)[]
        | undefined;
      if (variants) {
        for (const item of variants) {
          this.#collectPropertyDescriptions(item, descriptions, visited);
        }
      }
    }
  }
}
