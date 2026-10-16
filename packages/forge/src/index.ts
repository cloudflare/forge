/**
 * Write forge plugins in TypeScript or JavaScript.
 *
 * A plugin generates files from the forge of an OpenAPI document: its
 * groups, methods, models and types, as forge's Rust API has them. Build it
 * with `forge-plugin build`, and run it with
 * `forge openapi.json --target wasm://plugin.wasm --out sdk`.
 *
 * ```ts
 * import { definePlugin } from "@cloudflare/forge/plugin";
 *
 * export const { generate, generateGroup } = definePlugin({
 *   generateGroup(group) {
 *     const names = group.methods.map((m) => m.name.camel());
 *     return [{ path: `${group.name.kebab()}.txt`, content: names.join("\n") }];
 *   },
 * });
 * ```
 *
 * The forge stays in forge's process. Each part is fetched the first time
 * a plugin reads it, and kept until the call ends, so reading a part again
 * is free, and the same part is always the same object: compare groups,
 * methods and models with `===`.
 *
 * @module
 */

// This file is the source of plugin/index.js and plugin/index.d.ts, which
// scripts/build.mjs compiles it to. It is typed against the bindings jco
// generates from plugin/forge.wit, so a change to the WIT that this library
// doesn't follow fails to compile. Its exports are interfaces, and the
// classes behind them stay private, so the bindings never show in
// index.d.ts.

import * as host from 'forge:plugin/forge@0.3.0';
import type * as hostPlugin from 'forge:plugin/plugin@0.3.0';

// ---------------------------------------------------------------------------
// The API.

/** A plugin: what {@link definePlugin} takes. */
export interface Plugin {
  /** Generates files for the forge. Called exactly once. */
  generate?(forge: Forge): Iterable<File>;
  /**
   * Generates files for a group. Called exactly once for each group, in
   * parallel with other groups, each in an instance of its own. Nothing a
   * call keeps in module state is seen by the calls for other groups.
   */
  generateGroup?(group: Group): Iterable<File>;
}

/**
 * A file a plugin generates.
 *
 * forge writes it to the output directory, creating directories it needs,
 * and skips a file with no content. It rejects a path that is absolute,
 * has `.` or `..` parts, or that two files share.
 */
export interface File {
  /** The path relative to the output directory, using `/` as a separator. */
  path: string;
  /** The content: text, which is written as UTF-8, or bytes. */
  content: string | Uint8Array;
}

/** What the entry module of a plugin exports, under these names. */
export interface Exports {
  generate(): Array<{ path: string; content: Uint8Array }>;
  generateGroup(group: number): Array<{ path: string; content: Uint8Array }>;
}

/**
 * A name from the document, as lower-case words, which a plugin spells in
 * the casing of its language. `XMLDocument` is "xml document", `getByID` is
 * "get by id", and `ipv4_cidr` is "ipv4 cidr".
 */
export interface Name {
  /** The lower-case words. */
  readonly words: readonly string[];
  /** Whether the name has no words: what was written has no letters or digits. */
  readonly isEmpty: boolean;
  /** `petStore` */
  camel(): string;
  /** `PetStore` */
  pascal(): string;
  /** `pet_store` */
  snake(): string;
  /** `pet-store` */
  kebab(): string;
  /** Whether the names have the same words, however they were written. */
  equals(other: Name): boolean;
  /** The words, separated by spaces. */
  toString(): string;
}

/** The OpenAPI document, as an SDK sees it. */
export interface Forge {
  /** `info.version`. */
  readonly version: string;
  /** `info.title`, `info.summary` and `info.description`, as paragraphs. */
  readonly description: string;
  /** The URL of the first server, with its variables substituted. */
  readonly baseUrl: string;
  /** Every group, depth first. Siblings are sorted by name. */
  readonly groups: readonly Group[];
  /** The models in no group: those methods in more than one top-level group use. */
  readonly models: readonly Model[];
}

/** A named collection of subgroups, methods and models. */
export interface Group {
  readonly name: Name;
  /** A short description, or an empty string. */
  readonly description: string;
  /** The names of the groups from the top level down to this one, ending with its own. */
  readonly path: readonly Name[];
  /** The group this one is in, or undefined at the top level. */
  readonly parent: Group | undefined;
  /** The groups directly inside, sorted by name. */
  readonly children: readonly Group[];
  /** Every group below this one, depth first. */
  readonly descendants: readonly Group[];
  /** The methods directly inside, sorted by name. */
  readonly methods: readonly Method[];
  /** The models placed directly in this group: the deepest one every method using them shares. */
  readonly models: readonly Model[];
}

/** An operation an SDK exposes as a function. */
export interface Method {
  /** Unique within its group. */
  readonly name: Name;
  readonly group: Group;
  /** As it is sent, such as `GET`. */
  readonly httpMethod: string;
  /** The path template, such as `/accounts/{account_id}`. */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  /**
   * Whether the operation is `deprecated`. It is apart from `availability`:
   * a method can be deprecated without being `"deprecated"`, and the other
   * way around.
   */
  readonly deprecated: boolean;
  /** The stage of the API the method is in, from `x-fern-availability`, or undefined if it doesn't say. */
  readonly availability: Availability | undefined;
  /**
   * Whether to leave the method out of listings of methods, such as a CLI's
   * help, although it can still be called: `x-forge-hidden`.
   */
  readonly hidden: boolean;
  /**
   * A sentence to show before calling the method, which changes or deletes
   * something irreversibly, from `x-forge-require-confirmation`, or
   * undefined if it needs no confirmation. An empty string needs
   * confirmation, with no sentence of its own.
   */
  readonly confirmation: string | undefined;
  /**
   * What a caller passes, or undefined for no parameters and no body: the
   * body alone, an object of the path and query parameters, or an
   * intersection of the parameters and the body. The `location` of a field
   * says which parameter it is.
   */
  readonly request: Type | undefined;
  /**
   * The header parameters, as an object with a field for each, sent as the
   * header its wire name names, or undefined if there are none. They are
   * apart from `request`, and their fields have no `location`.
   */
  readonly headers: ObjectType | undefined;
  readonly body: Body | undefined;
  /** The `2XX` responses, sorted by status. */
  readonly responses: readonly Response[];
  /** Every other response, sorted by status with `default` last. */
  readonly errors: readonly Response[];
  /**
   * The extensions of the operation, or of the alias the method comes
   * from, that forge doesn't read itself, in the order they are written:
   * keys starting with `x-`, for plugins to read as they need.
   */
  readonly extensions: readonly (readonly [string, Json])[];
  /** The value of the extension `name`, such as `x-forge-params`, or undefined if there is none. */
  extension(name: string): Json | undefined;
  /**
   * Where `field` is sent, or undefined if it is not one of the method's
   * parameters, as for a field sent in the body.
   */
  location(field: Field): Location | undefined;
}

/**
 * Where a parameter is sent. For the query, `exploded` says whether each
 * item of an array is its own parameter, as in `ids=1&ids=2`.
 */
export type Location = { readonly in: 'path' } | { readonly in: 'query'; readonly exploded: boolean };

/** The stage of the API a method is in, as `x-fern-availability` writes it. */
export type Availability = 'alpha' | 'beta' | 'preview' | 'generally-available' | 'deprecated';

/**
 * A JSON value that forge keeps without reading, as `JSON.parse` reads it.
 * Numbers are 64-bit floats, as in forge. A JavaScript object lists keys
 * that are integers first, so an object's keys may not be in the order
 * they are written.
 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export interface Body {
  readonly required: boolean;
  readonly description: string;
  /** Each media type it can be sent as, sorted. */
  readonly contents: readonly Content[];
  /** The JSON content a client sends: `application/json`, or the first JSON media type. */
  readonly json: Content | undefined;
}

export interface Response {
  /** A code such as `200`, a range such as `4XX`, or `default`. */
  readonly status: string;
  readonly description: string;
  readonly contents: readonly Content[];
  readonly json: Content | undefined;
}

/** A body in one media type. */
export interface Content {
  /** Such as `application/json`. */
  readonly mediaType: string;
  /** Whether the media type is `application/json` or ends in `+json`. */
  readonly isJson: boolean;
  /**
   * The description of the content's schema, as a field's is read, or an
   * empty string. The body's or response's own describes it as a whole.
   */
  readonly description: string;
  /** The type of the body; `unknown` for media types other than JSON. */
  readonly type: Type;
}

/** A named schema from `components.schemas`, which an SDK declares as a type. */
export interface Model {
  /** Its key in `components.schemas`, such as `Account`, or a path such as `Tree/$defs/Node`. */
  readonly schemaName: string;
  readonly name: Name;
  /** The group it is placed in, or undefined at the top level. */
  readonly group: Group | undefined;
  readonly description: string;
  readonly deprecated: boolean;
  readonly type: Type;
  /** The schema name. */
  toString(): string;
}

/** A property of an object type. */
export interface Field {
  /** The property's name as it is sent. */
  readonly wireName: string;
  readonly name: Name;
  readonly required: boolean;
  readonly description: string;
  readonly deprecated: boolean;
  /**
   * Whether the server sets the property, so a client doesn't send it,
   * though the same model's field appears in responses: `readOnly`.
   */
  readonly readOnly: boolean;
  /** Whether the value is a secret, such as a password or a token, to keep out of logs: `x-sensitive`. */
  readonly sensitive: boolean;
  /** The `default` of the property's schema, or undefined if it has none. */
  readonly default: Json | undefined;
  readonly type: Type;
}

/**
 * The type of a value. Switch on `kind` to narrow it:
 *
 * ```ts
 * function ts(type: Type): string {
 *   switch (type.kind) {
 *     case "array": return `${ts(type.elem)}[]`;
 *     // ...
 *   }
 * }
 * ```
 *
 * A type that allows null is a union with a `null` scalar member.
 */
export type Type = ScalarType | EnumType | ArrayType | ObjectType | UnionType | IntersectionType | ModelType;

/** A primitive, or any value (`unknown`). */
export type ScalarType = {
  /**
   * The original `format`, including an empty or unrecognized one, or
   * undefined if absent. The scalar classification is unchanged: a UUID
   * is `string`, for example. Forge does not validate values.
   */
  readonly format: string | undefined;
} & (
  | {
      readonly kind: 'scalar';
      readonly scalar: 'unknown' | 'null' | 'boolean' | 'string' | 'date-time' | 'date' | 'bytes' | 'binary';
    }
  | { readonly kind: 'scalar'; readonly scalar: 'number'; readonly number: NumberFormat }
);

/** The size of a number, from its `format`. `int` and `double` have none. */
export type NumberFormat =
  | 'int'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'float'
  | 'double';

/** One of a list of values: from `enum` or `const`. */
export interface EnumType {
  readonly kind: 'enum';
  /** At least one, all different, in order; never null. */
  readonly values: readonly (string | number | boolean)[];
}

export interface ArrayType {
  readonly kind: 'array';
  readonly elem: Type;
  /** The fewest elements, `minItems`, or undefined if absent. An explicit zero is kept. */
  readonly minItems: number | undefined;
  /** The most elements the array can have, `maxItems`, or undefined if it has no limit. */
  readonly maxItems: number | undefined;
}

/** An object: fields, other keys, both or neither. A map has only `extra`. */
export interface ObjectType {
  readonly kind: 'object';
  readonly fields: readonly Field[];
  /** The type of values under other keys, or undefined if it allows none. */
  readonly extra: Type | undefined;
}

/** Any of the members: from `anyOf`, `oneOf`, or a list of types. */
export interface UnionType {
  readonly kind: 'union';
  /** At least two, all different. */
  readonly members: readonly Type[];
  /**
   * Whether a value is at most one of the members: true for `oneOf`, a
   * list of types, or null and another type; false for `anyOf`.
   */
  readonly exclusive: boolean;
  readonly discriminator: Discriminator | undefined;
}

/** The property whose value says which member of a union a value is. */
export interface Discriminator {
  readonly wireName: string;
  readonly name: Name;
  /** Each value of the property, and the member it says a value is. */
  readonly cases: readonly (readonly [string, Type])[];
  /** The model of a value that matches no case. */
  readonly default: Model | undefined;
}

/** All of the members: from `allOf`. */
export interface IntersectionType {
  readonly kind: 'intersection';
  readonly members: readonly Type[];
}

/** A `$ref` to a model. Read `model.type` to write it in place. */
export interface ModelType {
  readonly kind: 'model';
  readonly model: Model;
}

/**
 * Returns the exports of a plugin that calls `plugin`. Export them from the
 * plugin's entry module:
 *
 * ```ts
 * export const { generate, generateGroup } = definePlugin({ ... });
 * ```
 *
 * Throw to fail: forge stops and prints the error's message.
 */
export function definePlugin(plugin: Plugin): Exports {
  const exports = {
    generate() {
      return call(() => files(plugin.generate?.(new ForgeImpl()) ?? []));
    },
    generateGroup(id: host.GroupId) {
      return call(() => files(plugin.generateGroup?.(new ForgeImpl().group(id)) ?? []));
    },
  } satisfies Pick<typeof hostPlugin, 'generate' | 'generateGroup'>;
  return exports;
}

// ---------------------------------------------------------------------------
// The implementation.

// The API spells out what it shares with the WIT, so the bindings stay out
// of index.d.ts. These fail to compile if the two come apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;
type _ScalarsMatch = Check<Same<ScalarType['scalar'], host.Scalar['tag']>>;
type _NumbersMatch = Check<Same<NumberFormat, host.Number>>;
type _AvailabilitiesMatch = Check<Same<Availability, host.Availability>>;
type _EnumValuesMatch = Check<Same<EnumType['values'][number], host.EnumValue['val']>>;

// The bindings' types say a missing option is undefined, but QuickJS gives
// null, so options are read through `opt`.

/** Reads the JSON text the host sends for a value. */
function parseJson(text: host.Json): Json {
  return JSON.parse(text) as Json;
}

/** Returns `value`, or undefined for null. */
function opt<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * Runs `f`, turning whatever it throws into the string the WIT's error
 * case carries.
 */
function call<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    throw err instanceof Error ? err.message : String(err);
  }
}

/** Returns `files` as the host takes them, with their content in bytes. */
function files(files: Iterable<File>): hostPlugin.File[] {
  return Array.from(files, (file) => {
    if (typeof file?.path !== 'string') {
      throw new Error(`a file needs a path, not ${JSON.stringify(file?.path)}`);
    }
    const content = file.content ?? '';
    return { path: file.path, content: typeof content === 'string' ? encode(content) : content };
  });
}

type Encoder = { encode(s: string): Uint8Array };
const NativeEncoder = (globalThis as { TextEncoder?: new () => Encoder }).TextEncoder;

/**
 * Encodes `s` in UTF-8. QuickJS has no TextEncoder, so `s` is encoded here:
 * a code unit at a time, into one buffer as large as UTF-8 can need, which
 * is several times faster than building an array of bytes. A lone surrogate
 * is written as its own three bytes.
 */
const encode: (s: string) => Uint8Array = NativeEncoder
  ? (s) => new NativeEncoder().encode(s)
  : (s) => {
      const out = new Uint8Array(s.length * 3);
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) {
          out[n++] = c;
        } else if (c < 0x800) {
          out[n++] = 0xc0 | (c >> 6);
          out[n++] = 0x80 | (c & 63);
        } else {
          const next = c >= 0xd800 && c < 0xdc00 ? s.charCodeAt(i + 1) : 0;
          if (next >= 0xdc00 && next < 0xe000) {
            c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
            i++;
            out[n++] = 0xf0 | (c >> 18);
            out[n++] = 0x80 | ((c >> 12) & 63);
          } else {
            out[n++] = 0xe0 | (c >> 12);
          }
          out[n++] = 0x80 | ((c >> 6) & 63);
          out[n++] = 0x80 | (c & 63);
        }
      }
      return out.slice(0, n);
    };

/** Returns a list of ids, which comes as a Uint32Array, as an array. */
function ids(list: Uint32Array | ArrayLike<number>): number[] {
  return Array.from(list);
}

/** Returns a function that returns what `f` makes, made once on first use. */
function lazy<T>(f: () => T): () => T {
  let done = false;
  let value: T | undefined;
  return () => {
    if (!done) {
      value = f();
      done = true;
    }
    return value as T;
  };
}

/** Returns what `cache` has under `id`, making it with `make` if it has nothing. */
function cached<T>(cache: Map<number, T>, id: number, make: () => T): T {
  let value = cache.get(id);
  if (value === undefined) {
    value = make();
    cache.set(id, value);
  }
  return value;
}

class NameImpl implements Name {
  readonly words: readonly string[];

  constructor(words: host.Name) {
    this.words = Object.freeze(Array.from(words));
  }

  get isEmpty(): boolean {
    return this.words.length === 0;
  }

  camel(): string {
    return this.words.map((word, i) => (i === 0 ? word : upperFirst(word))).join('');
  }

  pascal(): string {
    return this.words.map(upperFirst).join('');
  }

  snake(): string {
    return this.words.join('_');
  }

  kebab(): string {
    return this.words.join('-');
  }

  equals(other: Name): boolean {
    return this.words.length === other.words.length && this.words.every((word, i) => word === other.words[i]);
  }

  toString(): string {
    return this.words.join(' ');
  }
}

/** Upper-cases the first character of `word`, as Rust's `char::to_uppercase` does. */
function upperFirst(word: string): string {
  const first = word.codePointAt(0);
  if (first === undefined) {
    return word;
  }
  const ch = String.fromCodePoint(first);
  return ch.toUpperCase() + word.slice(ch.length);
}

class ForgeImpl implements Forge {
  readonly version: string;
  readonly description: string;
  readonly baseUrl: string;
  private readonly groupCache = new Map<host.GroupId, GroupImpl>();
  private readonly methodCache = new Map<host.MethodId, MethodImpl>();
  private readonly modelCache = new Map<host.ModelId, ModelImpl>();
  private readonly typeCache = new Map<host.TypeId, Type>();
  private readonly allGroups = lazy(() => ids(host.groups()).map((id) => this.group(id)));
  private readonly topModels = lazy(() => ids(host.models()).map((id) => this.model(id)));

  constructor() {
    const info = host.info();
    this.version = info.version;
    this.description = info.description;
    this.baseUrl = info.baseUrl;
  }

  get groups(): readonly Group[] {
    return this.allGroups();
  }

  get models(): readonly Model[] {
    return this.topModels();
  }

  group(id: host.GroupId): GroupImpl {
    return cached(this.groupCache, id, () => new GroupImpl(this, id));
  }

  method(id: host.MethodId): MethodImpl {
    return cached(this.methodCache, id, () => new MethodImpl(this, id));
  }

  model(id: host.ModelId): ModelImpl {
    return cached(this.modelCache, id, () => new ModelImpl(this, id));
  }

  type(id: host.TypeId): Type {
    return cached(this.typeCache, id, () => makeType(this, id));
  }
}

class GroupImpl implements Group {
  private readonly info: () => {
    name: Name;
    description: string;
    path: host.GroupId[];
    children: host.GroupId[];
    methods: host.MethodId[];
    models: host.ModelId[];
  };

  constructor(
    private readonly forge: ForgeImpl,
    id: host.GroupId,
  ) {
    this.info = lazy(() => {
      const g = host.getGroup(id);
      return {
        name: new NameImpl(g.name),
        description: g.description,
        path: ids(g.path),
        children: ids(g.children),
        methods: ids(g.methods),
        models: ids(g.models),
      };
    });
  }

  get name(): Name {
    return this.info().name;
  }

  get description(): string {
    return this.info().description;
  }

  get path(): readonly Name[] {
    return this.info().path.map((id) => this.forge.group(id).name);
  }

  get parent(): Group | undefined {
    const path = this.info().path;
    const parent = path[path.length - 2];
    return parent === undefined ? undefined : this.forge.group(parent);
  }

  get children(): readonly Group[] {
    return this.info().children.map((id) => this.forge.group(id));
  }

  get descendants(): readonly Group[] {
    const out: Group[] = [];
    const stack = [...this.children].reverse();
    for (let group = stack.pop(); group !== undefined; group = stack.pop()) {
      out.push(group);
      stack.push(...[...group.children].reverse());
    }
    return out;
  }

  get methods(): readonly Method[] {
    return this.info().methods.map((id) => this.forge.method(id));
  }

  get models(): readonly Model[] {
    return this.info().models.map((id) => this.forge.model(id));
  }
}

/** How each HTTP method is sent, but `other`, which carries its own. */
const httpMethods: Record<Exclude<host.HttpMethod['tag'], 'other'>, string> = {
  get: 'GET',
  put: 'PUT',
  post: 'POST',
  delete: 'DELETE',
  options: 'OPTIONS',
  head: 'HEAD',
  patch: 'PATCH',
  trace: 'TRACE',
  query: 'QUERY',
  connect: 'CONNECT',
};

class MethodImpl implements Method {
  private readonly info: () => {
    name: Name;
    group: host.GroupId;
    httpMethod: string;
    path: string;
    summary: string;
    description: string;
    deprecated: boolean;
    availability: Availability | undefined;
    hidden: boolean;
    confirmation: string | undefined;
    request: host.TypeId | undefined;
    headers: host.TypeId | undefined;
    body: Body | undefined;
    responses: Response[];
    errors: Response[];
    extensions: (readonly [string, Json])[];
  };

  constructor(
    private readonly forge: ForgeImpl,
    private readonly id: host.MethodId,
  ) {
    this.info = lazy(() => {
      const m = host.getMethod(id);
      const body = opt(m.body);
      return {
        name: new NameImpl(m.name),
        group: m.group,
        httpMethod: m.httpMethod.tag === 'other' ? m.httpMethod.val : httpMethods[m.httpMethod.tag],
        path: m.path,
        summary: m.summary,
        description: m.description,
        deprecated: m.deprecated,
        availability: opt(m.availability),
        hidden: m.hidden,
        confirmation: opt(m.confirmation),
        request: opt(m.request),
        headers: opt(m.headers),
        body: body && {
          required: body.required,
          description: body.description,
          ...contents(forge, body.contents, body.json),
        },
        responses: m.responses.map((r) => response(forge, r)),
        errors: m.errors.map((r) => response(forge, r)),
        extensions: m.extensions.map(([name, value]) => [name, parseJson(value)] as const),
      };
    });
  }

  get name(): Name {
    return this.info().name;
  }

  get group(): Group {
    return this.forge.group(this.info().group);
  }

  get httpMethod(): string {
    return this.info().httpMethod;
  }

  get path(): string {
    return this.info().path;
  }

  get summary(): string {
    return this.info().summary;
  }

  get description(): string {
    return this.info().description;
  }

  get deprecated(): boolean {
    return this.info().deprecated;
  }

  get availability(): Availability | undefined {
    return this.info().availability;
  }

  get hidden(): boolean {
    return this.info().hidden;
  }

  get confirmation(): string | undefined {
    return this.info().confirmation;
  }

  get request(): Type | undefined {
    const request = this.info().request;
    return request === undefined ? undefined : this.forge.type(request);
  }

  get headers(): ObjectType | undefined {
    const headers = this.info().headers;
    if (headers === undefined) {
      return undefined;
    }
    const type = this.forge.type(headers);
    return type.kind === 'object' ? type : undefined;
  }

  get body(): Body | undefined {
    return this.info().body;
  }

  get responses(): readonly Response[] {
    return this.info().responses;
  }

  get errors(): readonly Response[] {
    return this.info().errors;
  }

  get extensions(): readonly (readonly [string, Json])[] {
    return this.info().extensions;
  }

  extension(name: string): Json | undefined {
    return this.info().extensions.find(([n]) => n === name)?.[1];
  }

  location(field: Field): Location | undefined {
    if (!(field instanceof FieldImpl) || field.forge !== this.forge) {
      return undefined;
    }
    const location = opt(host.getLocation(this.id, field.object, field.index));
    switch (location?.tag) {
      case undefined:
        return undefined;
      case 'path':
        return { in: 'path' };
      case 'query':
        return { in: 'query', exploded: location.val };
      default: {
        const unknown: never = location;
        throw new Error(`a location this library doesn't know: ${JSON.stringify(unknown)}`);
      }
    }
  }
}

function response(forge: ForgeImpl, r: host.ResponseInfo): Response {
  return { status: r.status, description: r.description, ...contents(forge, r.contents, r.json) };
}

/** Returns `list` as `Content`s, and the one at index `json`. */
function contents(
  forge: ForgeImpl,
  list: host.ContentInfo[],
  json: number | undefined,
): { contents: Content[]; json: Content | undefined } {
  const all = list.map((c) => new ContentImpl(forge, c));
  const index = opt(json);
  return { contents: all, json: index === undefined ? undefined : all[index] };
}

class ContentImpl implements Content {
  readonly mediaType: string;
  readonly description: string;
  private readonly ty: host.TypeId;

  constructor(
    private readonly forge: ForgeImpl,
    info: host.ContentInfo,
  ) {
    this.mediaType = info.mediaType;
    this.description = info.description;
    this.ty = info.ty;
  }

  get isJson(): boolean {
    const base = (this.mediaType.split(';')[0] ?? '').trim().toLowerCase();
    return base === 'application/json' || base.endsWith('+json');
  }

  get type(): Type {
    return this.forge.type(this.ty);
  }
}

class ModelImpl implements Model {
  private readonly info: () => {
    schemaName: string;
    name: Name;
    group: host.GroupId | undefined;
    description: string;
    deprecated: boolean;
    ty: host.TypeId;
  };

  constructor(
    private readonly forge: ForgeImpl,
    id: host.ModelId,
  ) {
    this.info = lazy(() => {
      const m = host.getModel(id);
      return {
        schemaName: m.schemaName,
        name: new NameImpl(m.name),
        group: opt(m.group),
        description: m.description,
        deprecated: m.deprecated,
        ty: m.ty,
      };
    });
  }

  get schemaName(): string {
    return this.info().schemaName;
  }

  get name(): Name {
    return this.info().name;
  }

  get group(): Group | undefined {
    const group = this.info().group;
    return group === undefined ? undefined : this.forge.group(group);
  }

  get description(): string {
    return this.info().description;
  }

  get deprecated(): boolean {
    return this.info().deprecated;
  }

  get type(): Type {
    return this.forge.type(this.info().ty);
  }

  toString(): string {
    return this.schemaName;
  }
}

class FieldImpl implements Field {
  readonly wireName: string;
  readonly name: Name;
  readonly required: boolean;
  readonly description: string;
  readonly deprecated: boolean;
  readonly readOnly: boolean;
  readonly sensitive: boolean;
  readonly default: Json | undefined;
  private readonly ty: host.TypeId;

  /** The object type the field is in, and its index there, which the host knows it by. */
  constructor(
    readonly forge: ForgeImpl,
    readonly object: host.TypeId,
    readonly index: number,
    info: host.FieldInfo,
  ) {
    this.wireName = info.wireName;
    this.name = new NameImpl(info.name);
    this.required = info.required;
    this.description = info.description;
    this.deprecated = info.deprecated;
    this.readOnly = info.readOnly;
    this.sensitive = info.sensitive;
    const value = opt(info.default);
    this.default = value === undefined ? undefined : parseJson(value);
    this.ty = info.ty;
  }

  get type(): Type {
    return this.forge.type(this.ty);
  }
}

/** Returns the type `id`. Types it refers to are made when first read. */
function makeType(forge: ForgeImpl, id: host.TypeId): Type {
  const t = host.getType(id);
  const type = (ty: host.TypeId) => forge.type(ty);
  switch (t.tag) {
    case 'scalar':
      return t.val.kind.tag === 'number'
        ? { kind: 'scalar', scalar: 'number', number: t.val.kind.val, format: opt(t.val.format) }
        : { kind: 'scalar', scalar: t.val.kind.tag, format: opt(t.val.format) };
    case 'enum':
      return { kind: 'enum', values: t.val.map((value) => value.val) };
    case 'array': {
      const { elem } = t.val;
      const minItems = opt(t.val.minItems);
      const maxItems = opt(t.val.maxItems);
      return {
        kind: 'array',
        get elem() {
          return type(elem);
        },
        // A u64 comes as a bigint; no array's limit needs more than a number.
        minItems: minItems === undefined ? undefined : Number(minItems),
        maxItems: maxItems === undefined ? undefined : Number(maxItems),
      };
    }
    case 'object': {
      const fields = t.val.fields.map((field, i) => new FieldImpl(forge, id, i, field));
      const extra = opt(t.val.extra);
      return {
        kind: 'object',
        fields,
        get extra() {
          return extra === undefined ? undefined : type(extra);
        },
      };
    }
    case 'union': {
      const members = ids(t.val.members);
      const d = opt(t.val.discriminator);
      const discriminator: Discriminator | undefined = d && {
        wireName: d.wireName,
        name: new NameImpl(d.name),
        get cases() {
          return d.cases.map(([value, ty]) => [value, type(ty)] as const);
        },
        get default() {
          const model = opt(d.default);
          return model === undefined ? undefined : forge.model(model);
        },
      };
      return {
        kind: 'union',
        get members() {
          return members.map(type);
        },
        exclusive: t.val.exclusive,
        discriminator,
      };
    }
    case 'intersection': {
      const members = ids(t.val);
      return {
        kind: 'intersection',
        get members() {
          return members.map(type);
        },
      };
    }
    case 'model':
      return { kind: 'model', model: forge.model(t.val) };
    default: {
      // A kind the WIT gains fails to compile here until it is handled.
      const unknown: never = t;
      throw new Error(`type ${id} is of a kind this library doesn't know: ${JSON.stringify(unknown)}`);
    }
  }
}
