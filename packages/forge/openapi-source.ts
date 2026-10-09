/**
 * OpenAPI Sources
 *
 * An OpenAPI spec can be written in more than one format. Each format is read
 * by an `OpenApiLoader` that declares its own source shape; a registry built
 * with `createOpenApiLoaders` dispatches on `format` without knowing which
 * formats exist, and accepts exactly the sources its loaders declare.
 */

import type { ForgeOpenApiDocument } from './init-from-openapi.js';

/** The field every OpenAPI source shares; each loader's source type adds its own. */
type OpenApiSourceBase = { format: string };

/** One OpenAPI document defined by a source. */
export type OpenApiSourceDocument = {
  /** Name of the document within its source, as its loader names it. */
  name: string;
  /** The OpenAPI document. */
  document: ForgeOpenApiDocument;
};

type IsUnion<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? false : true) : never;

/** Reads OpenAPI specs written in one format. */
export type OpenApiLoader<TSource extends OpenApiSourceBase> = {
  /** Format this loader reads, as a single literal; unique within a registry. */
  format: string extends TSource['format']
    ? never
    : true extends IsUnion<TSource['format']>
      ? never
      : TSource['format'];
  /** Reads every document the source defines. */
  load(source: TSource): Promise<OpenApiSourceDocument[]>;
};

/** Any loader, whatever source it declares. */
type AnyOpenApiLoader = {
  format: string;
  load(source: never): Promise<OpenApiSourceDocument[]>;
};

type SourceOfLoader<TLoader> = TLoader extends OpenApiLoader<infer TSource> ? TSource : never;

/** The sources accepted by a set of loaders. */
type OpenApiSourceOf<TLoaders extends readonly AnyOpenApiLoader[]> = SourceOfLoader<TLoaders[number]>;

/** Loaders registered together, accepting the sources they declare. */
export type OpenApiLoaders<TSource extends OpenApiSourceBase> = {
  /** Reads every document the source defines. */
  load(source: TSource): Promise<OpenApiSourceDocument[]>;
  /**
   * Reads the source's only document.
   *
   * @throws When the source defines no documents, or more than one, naming each.
   */
  loadOne(source: TSource): Promise<ForgeOpenApiDocument>;
};

/**
 * Registers loaders and dispatches each source to the loader for its format.
 *
 * @throws When no loader is given, or two loaders read the same format.
 */
export function createOpenApiLoaders<TLoaders extends readonly [AnyOpenApiLoader, ...AnyOpenApiLoader[]]>(
  ...loaders: TLoaders
): OpenApiLoaders<OpenApiSourceOf<TLoaders>> {
  type Source = OpenApiSourceOf<TLoaders>;

  if (loaders.length === 0) throw new Error('At least one OpenAPI loader is required');
  const byFormat = new Map<string, AnyOpenApiLoader>();
  const duplicates = new Set<string>();
  for (const loader of loaders) {
    if (byFormat.has(loader.format)) duplicates.add(loader.format);
    byFormat.set(loader.format, loader);
  }
  if (duplicates.size > 0) {
    throw new Error(`OpenAPI formats registered more than once:\n- ${[...duplicates].join('\n- ')}`);
  }
  const formats = [...byFormat.keys()];

  async function load(source: Source): Promise<OpenApiSourceDocument[]> {
    const loader = byFormat.get(source.format);
    if (!loader) {
      throw new Error(
        `No OpenAPI loader reads format "${source.format}". Registered formats:\n- ${formats.join('\n- ')}`,
      );
    }
    return loader.load(source as never);
  }

  async function loadOne(source: Source): Promise<ForgeOpenApiDocument> {
    const documents = await load(source);
    const [first] = documents;
    if (documents.length === 1 && first) return first.document;
    if (!first) throw new Error(`The ${source.format} OpenAPI source defines no documents`);
    throw new Error(
      `The ${source.format} OpenAPI source defines ${documents.length} documents; narrow it to one of:\n- ` +
        documents.map((document) => document.name).join('\n- '),
    );
  }

  return { load, loadOne };
}
