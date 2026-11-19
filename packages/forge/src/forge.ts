/**
 * Reads a forge's groups, methods, models and types, as forge's Rust API
 * has them. Plugins read this API, and `parse` returns it.
 *
 * A plugin reads the records from the host it runs in, and `parse` reads
 * them from forge compiled to WebAssembly in the same process. The WIT's
 * `forge` interface types both. Each part is fetched the first time it is
 * read, and kept, so reading a part again returns the same object.
 *
 * @module
 */

import type { StructArrayView } from 'capnstruct';
import {
  type ContentInfo,
  type FieldInfo,
  ForgeDoc,
  type GroupInfo,
  type MethodInfo,
  type ModelInfo,
  type ResponseInfo,
} from './schema.js';
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
  /** Every group, depth first, starting with the root. Siblings are sorted by name. */
  readonly groups: readonly Group[];
}

/**
 * A named collection of subgroups, methods and models.
 *
 * Every forge has a root group, which every other group is inside, and
 * which `Forge.groups` has first. It is the only group with an empty name,
 * and the only one without a `parent`. It holds the methods without a group
 * name, and the models that methods in more than one of its subgroups use.
 */
export interface Group {
  /** Empty for the root, and only for the root. */
  readonly name: Name;
  /** A short description, or an empty string. */
  readonly description: string;
  /**
   * The names of the groups from the top level down to this one, ending
   * with its own. The root is not included, so its path is empty.
   */
  readonly path: readonly Name[];
  /** The group this one is in, which is the root for a top-level group, or undefined for the root. */
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
  /** The stage of the API the method is in, from `x-forge-availability`, or undefined if it doesn't say. */
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

/** The stage of the API a method is in, as `x-forge-availability` writes it. */
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
  /**
   * The group it is placed in: the deepest one every method using it
   * shares, which is the root for a model used in more than one top-level
   * group, or by a method of the root.
   */
  readonly group: Group;
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
  /** Whether the value is a secret, such as a password or a token, to keep out of logs: `x-forge-sensitive`. */
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
export type ScalarType =
  | {
      readonly kind: 'scalar';
      readonly scalar: 'unknown' | 'null' | 'boolean' | 'string' | 'date-time' | 'date' | 'bytes' | 'binary' | 'uuid';
    }
  | { readonly kind: 'scalar'; readonly scalar: 'number'; readonly number: NumberFormat };

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

// ---------------------------------------------------------------------------
// The implementation.
// The implementation, reading directly from a single capnstruct `ForgeDoc` buffer.

/** Reads the JSON text stored in the capnstruct buffer for a value. */
function parseJson(text: string): Json {
  return JSON.parse(text) as Json;
}

/** Returns a list of u32 ids as a plain number array. */
function ids(list: ArrayLike<number>): number[] {
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

/** Returns what `cache` has at index `id`, making it with `make` if it has nothing. */
function cached<T>(cache: (T | undefined)[], id: number, make: () => T): T {
  let value = cache[id];
  if (value === undefined) {
    value = make();
    cache[id] = value;
  }
  return value;
}

class NameImpl implements Name {
  readonly words: readonly string[];

  constructor(words: readonly string[]) {
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

/**
 * Returns the forge backed by a single `capnstruct` `ForgeDoc` buffer, plus
 * an optional `dispose` callback that releases the underlying buffer reference.
 *
 * @internal
 */
export function forgeOf(bytes: Uint8Array): Forge & { /** @internal */ _dispose(): void } {
  return new ForgeImpl(bytes);
}

class ForgeImpl implements Forge {
  private doc: typeof ForgeDoc.$view | undefined;
  private groupsCur: typeof GroupInfo.$view | undefined;
  private methodsCur: typeof MethodInfo.$view | undefined;
  private modelsCur: typeof ModelInfo.$view | undefined;
  private fieldCur: typeof FieldInfo.$view | undefined;
  private respCur: typeof ResponseInfo.$view | undefined;
  private contentCur: typeof ContentInfo.$view | undefined;

  private _version: string | undefined;
  private _description: string | undefined;
  private _baseUrl: string | undefined;
  private readonly groupCache: (GroupImpl | undefined)[] = [];
  private readonly methodCache: (MethodImpl | undefined)[] = [];
  private readonly modelCache: (ModelImpl | undefined)[] = [];
  private readonly typeCache: (Type | undefined)[] = [];
  private readonly allGroups = lazy(() => ids(this.requireDoc().groupOrder).map((id) => this.group(id)));

  constructor(bytes: Uint8Array) {
    this.doc = ForgeDoc.view(bytes);
  }

  /** @internal */
  _dispose(): void {
    this.doc = undefined;
    this.groupsCur = undefined;
    this.methodsCur = undefined;
    this.modelsCur = undefined;
    this.fieldCur = undefined;
    this.respCur = undefined;
    this.contentCur = undefined;
  }

  private requireDoc(): typeof ForgeDoc.$view {
    if (this.doc === undefined) {
      throw new Error('handle is not a valid "Forge" resource');
    }
    return this.doc;
  }

  rawGroup(id: number): typeof GroupInfo.$view {
    return (this.groupsCur ??= this.requireDoc().groups.cursor()).seek(id);
  }

  rawMethod(id: number): typeof MethodInfo.$view {
    return (this.methodsCur ??= this.requireDoc().methods.cursor()).seek(id);
  }

  rawModel(id: number): typeof ModelInfo.$view {
    return (this.modelsCur ??= this.requireDoc().models.cursor()).seek(id);
  }

  rawType(id: number) {
    return this.requireDoc().types.at(id);
  }

  fieldAt(list: StructArrayView<typeof FieldInfo.schema>, index: number): typeof FieldInfo.$view {
    return this.fieldCur ? list.at(index, this.fieldCur) : (this.fieldCur = list.at(index));
  }

  respAt(list: StructArrayView<typeof ResponseInfo.schema>, index: number): typeof ResponseInfo.$view {
    return this.respCur ? list.at(index, this.respCur) : (this.respCur = list.at(index));
  }

  contentAt(list: StructArrayView<typeof ContentInfo.schema>, index: number): typeof ContentInfo.$view {
    return this.contentCur ? list.at(index, this.contentCur) : (this.contentCur = list.at(index));
  }

  get version(): string {
    return (this._version ??= this.requireDoc().version);
  }

  get description(): string {
    return (this._description ??= this.requireDoc().description);
  }

  get baseUrl(): string {
    return (this._baseUrl ??= this.requireDoc().baseUrl);
  }

  get groups(): readonly Group[] {
    return this.allGroups();
  }

  group(id: number): GroupImpl {
    return cached(this.groupCache, id, () => new GroupImpl(this, id));
  }

  method(id: number): MethodImpl {
    return cached(this.methodCache, id, () => new MethodImpl(this, id));
  }

  model(id: number): ModelImpl {
    return cached(this.modelCache, id, () => new ModelImpl(this, id));
  }

  type(id: number): Type {
    return cached(this.typeCache, id, () => makeType(this, id));
  }
}

class GroupImpl implements Group {
  private _name: Name | undefined;
  private _description: string | undefined;
  private _pathIds: number[] | undefined;
  private _parentId: number | null | undefined;
  private _childIds: number[] | undefined;
  private _methodIds: number[] | undefined;
  private _modelIds: number[] | undefined;

  constructor(
    private readonly forge: ForgeImpl,
    private readonly id: number,
  ) {}

  get name(): Name {
    return (this._name ??= new NameImpl(this.forge.rawGroup(this.id).name));
  }

  get description(): string {
    return (this._description ??= this.forge.rawGroup(this.id).description);
  }

  get path(): readonly Name[] {
    const list = (this._pathIds ??= ids(this.forge.rawGroup(this.id).path));
    return list.map((id) => this.forge.group(id).name);
  }

  get parent(): Group | undefined {
    if (this._parentId === undefined) {
      this._parentId = this.forge.rawGroup(this.id).parent;
    }
    return this._parentId === null ? undefined : this.forge.group(this._parentId);
  }

  get children(): readonly Group[] {
    const list = (this._childIds ??= ids(this.forge.rawGroup(this.id).children));
    return list.map((id) => this.forge.group(id));
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
    const list = (this._methodIds ??= ids(this.forge.rawGroup(this.id).methods));
    return list.map((id) => this.forge.method(id));
  }

  get models(): readonly Model[] {
    const list = (this._modelIds ??= ids(this.forge.rawGroup(this.id).models));
    return list.map((id) => this.forge.model(id));
  }
}

const httpMethodNames: Record<string, string> = {
  Get: 'GET',
  Put: 'PUT',
  Post: 'POST',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
  Patch: 'PATCH',
  Trace: 'TRACE',
  Query: 'QUERY',
  Connect: 'CONNECT',
};

const availabilityNames: Record<string, Availability | undefined> = {
  None: undefined,
  Alpha: 'alpha',
  Beta: 'beta',
  Preview: 'preview',
  GenerallyAvailable: 'generally-available',
  Deprecated: 'deprecated',
};

const numberFormatNames: Record<string, NumberFormat> = {
  Int: 'int',
  Int8: 'int8',
  Int16: 'int16',
  Int32: 'int32',
  Int64: 'int64',
  Uint8: 'uint8',
  Uint16: 'uint16',
  Uint32: 'uint32',
  Uint64: 'uint64',
  Float: 'float',
  Double: 'double',
};

class MethodImpl implements Method {
  private _name: Name | undefined;
  private _group: number | undefined;
  private _httpMethod: string | undefined;
  private _path: string | undefined;
  private _summary: string | undefined;
  private _description: string | undefined;
  private _deprecated: boolean | undefined;
  private _availability: Availability | undefined | false = false;
  private _hidden: boolean | undefined;
  private _confirmation: string | undefined | false = false;
  private _request: number | null | undefined;
  private _paramsType: number | null | undefined;
  private _paramLocations: readonly Location[] | undefined;
  private _headers: number | null | undefined;
  private _body: Body | undefined | false = false;
  private _responses: Response[] | undefined;
  private _errors: Response[] | undefined;
  private _extensions: (readonly [string, Json])[] | undefined;

  constructor(
    private readonly forge: ForgeImpl,
    private readonly id: number,
  ) {}

  get name(): Name {
    return (this._name ??= new NameImpl(this.forge.rawMethod(this.id).name));
  }

  get group(): Group {
    const gid = (this._group ??= this.forge.rawMethod(this.id).group);
    return this.forge.group(gid);
  }

  get httpMethod(): string {
    if (this._httpMethod === undefined) {
      const hm = this.forge.rawMethod(this.id).httpMethod;
      this._httpMethod = hm.tag === 'Other' ? hm.value : httpMethodNames[hm.tag]!;
    }
    return this._httpMethod;
  }

  get path(): string {
    return (this._path ??= this.forge.rawMethod(this.id).path);
  }

  get summary(): string {
    return (this._summary ??= this.forge.rawMethod(this.id).summary);
  }

  get description(): string {
    return (this._description ??= this.forge.rawMethod(this.id).description);
  }

  get deprecated(): boolean {
    return (this._deprecated ??= this.forge.rawMethod(this.id).deprecated);
  }

  get availability(): Availability | undefined {
    if (this._availability === false) {
      this._availability = availabilityNames[this.forge.rawMethod(this.id).availability.tag];
    }
    return this._availability;
  }

  get hidden(): boolean {
    return (this._hidden ??= this.forge.rawMethod(this.id).hidden);
  }

  get confirmation(): string | undefined {
    if (this._confirmation === false) {
      this._confirmation = this.forge.rawMethod(this.id).confirmation ?? undefined;
    }
    return this._confirmation;
  }

  get request(): Type | undefined {
    if (this._request === undefined) {
      this._request = this.forge.rawMethod(this.id).request;
    }
    return this._request === null ? undefined : this.forge.type(this._request);
  }

  get headers(): ObjectType | undefined {
    if (this._headers === undefined) {
      this._headers = this.forge.rawMethod(this.id).headers;
    }
    if (this._headers === null) {
      return undefined;
    }
    const type = this.forge.type(this._headers);
    return type.kind === 'object' ? type : undefined;
  }

  get body(): Body | undefined {
    if (this._body === false) {
      const body = this.forge.rawMethod(this.id).body;
      this._body = body
        ? {
            required: body.required,
            description: body.description,
            ...contents(this.forge, body.contents, body.json ?? undefined),
          }
        : undefined;
    }
    return this._body;
  }

  get responses(): readonly Response[] {
    if (this._responses === undefined) {
      const list = this.forge.rawMethod(this.id).responses;
      const len = list.length;
      const out: Response[] = new Array(len);
      for (let i = 0; i < len; i++) {
        const cur = this.forge.respAt(list, i);
        out[i] = new ResponseImpl(this.forge, list, i, cur.contents, cur.json ?? undefined);
      }
      this._responses = out;
    }
    return this._responses;
  }

  get errors(): readonly Response[] {
    if (this._errors === undefined) {
      const list = this.forge.rawMethod(this.id).errors;
      const len = list.length;
      const out: Response[] = new Array(len);
      for (let i = 0; i < len; i++) {
        const cur = this.forge.respAt(list, i);
        out[i] = new ResponseImpl(this.forge, list, i, cur.contents, cur.json ?? undefined);
      }
      this._errors = out;
    }
    return this._errors;
  }

  get extensions(): readonly (readonly [string, Json])[] {
    if (this._extensions === undefined) {
      const out: (readonly [string, Json])[] = [];
      for (const ext of this.forge.rawMethod(this.id).extensions) {
        out.push([ext.key, parseJson(ext.value)] as const);
      }
      this._extensions = out;
    }
    return this._extensions;
  }

  extension(name: string): Json | undefined {
    return this.extensions.find(([n]) => n === name)?.[1];
  }

  location(field: Field): Location | undefined {
    if (!(field instanceof FieldImpl) || field.forge !== this.forge) {
      return undefined;
    }
    if (this._paramsType === undefined) {
      this._paramsType = this.forge.rawMethod(this.id).paramsType;
    }
    if (this._paramsType !== field.object) {
      return undefined;
    }
    if (this._paramLocations === undefined) {
      this._paramLocations = this.forge
        .rawMethod(this.id)
        .paramLocations.map((loc) => (loc.tag === 'Path' ? { in: 'path' } : { in: 'query', exploded: loc.value }));
    }
    return this._paramLocations[field.index];
  }
}

class ResponseImpl implements Response {
  private _status: string | undefined;
  private _description: string | undefined;
  readonly contents: readonly Content[];
  readonly json: Content | undefined;

  constructor(
    private readonly forge: ForgeImpl,
    private readonly list: StructArrayView<typeof ResponseInfo.schema>,
    private readonly index: number,
    rawContents: StructArrayView<typeof ContentInfo.schema>,
    jsonIndex: number | undefined,
  ) {
    const res = contents(forge, rawContents, jsonIndex);
    this.contents = res.contents;
    this.json = res.json;
  }

  get status(): string {
    return (this._status ??= this.forge.respAt(this.list, this.index).status);
  }

  get description(): string {
    return (this._description ??= this.forge.respAt(this.list, this.index).description);
  }
}

function contents(
  forge: ForgeImpl,
  list: (typeof ResponseInfo.$view)['contents'],
  jsonIndex: number | undefined,
): { contents: Content[]; json: Content | undefined } {
  const len = list.length;
  const all: Content[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const cur = forge.contentAt(list, i);
    all[i] = new ContentImpl(forge, list, i, cur.ty);
  }
  return { contents: all, json: jsonIndex === undefined ? undefined : all[jsonIndex] };
}

class ContentImpl implements Content {
  private _mediaType: string | undefined;
  private _description: string | undefined;

  constructor(
    private readonly forge: ForgeImpl,
    private readonly list: (typeof ResponseInfo.$view)['contents'],
    private readonly index: number,
    private readonly ty: number,
  ) {}

  get mediaType(): string {
    return (this._mediaType ??= this.forge.contentAt(this.list, this.index).mediaType);
  }

  get description(): string {
    return (this._description ??= this.forge.contentAt(this.list, this.index).description);
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
  private _schemaName: string | undefined;
  private _name: Name | undefined;
  private _group: number | undefined;
  private _description: string | undefined;
  private _deprecated: boolean | undefined;
  private _ty: number | undefined;

  constructor(
    private readonly forge: ForgeImpl,
    private readonly id: number,
  ) {}

  get schemaName(): string {
    return (this._schemaName ??= this.forge.rawModel(this.id).schemaName);
  }

  get name(): Name {
    return (this._name ??= new NameImpl(this.forge.rawModel(this.id).name));
  }

  get group(): Group {
    const gid = (this._group ??= this.forge.rawModel(this.id).group);
    return this.forge.group(gid);
  }

  get description(): string {
    return (this._description ??= this.forge.rawModel(this.id).description);
  }

  get deprecated(): boolean {
    return (this._deprecated ??= this.forge.rawModel(this.id).deprecated);
  }

  get type(): Type {
    const ty = (this._ty ??= this.forge.rawModel(this.id).ty);
    return this.forge.type(ty);
  }

  toString(): string {
    return this.schemaName;
  }
}

class FieldImpl implements Field {
  private _wireName: string | undefined;
  private _name: Name | undefined;
  private _required: boolean | undefined;
  private _description: string | undefined;
  private _deprecated: boolean | undefined;
  private _readOnly: boolean | undefined;
  private _sensitive: boolean | undefined;
  private _default: Json | undefined | false = false;

  constructor(
    readonly forge: ForgeImpl,
    readonly object: number,
    readonly index: number,
    private readonly list: StructArrayView<typeof FieldInfo.schema>,
    private readonly ty: number,
  ) {}

  get wireName(): string {
    return (this._wireName ??= this.forge.fieldAt(this.list, this.index).wireName);
  }

  get name(): Name {
    return (this._name ??= new NameImpl(this.forge.fieldAt(this.list, this.index).name));
  }

  get required(): boolean {
    return (this._required ??= this.forge.fieldAt(this.list, this.index).required);
  }

  get description(): string {
    return (this._description ??= this.forge.fieldAt(this.list, this.index).description);
  }

  get deprecated(): boolean {
    return (this._deprecated ??= this.forge.fieldAt(this.list, this.index).deprecated);
  }

  get readOnly(): boolean {
    return (this._readOnly ??= this.forge.fieldAt(this.list, this.index).readOnly);
  }

  get sensitive(): boolean {
    return (this._sensitive ??= this.forge.fieldAt(this.list, this.index).sensitive);
  }

  get default(): Json | undefined {
    if (this._default === false) {
      const def = this.forge.fieldAt(this.list, this.index).default;
      this._default = def !== null ? parseJson(def) : undefined;
    }
    return this._default;
  }

  get type(): Type {
    return this.forge.type(this.ty);
  }
}

/** Returns the type `id`. Types it refers to are made when first read. */
function makeType(forge: ForgeImpl, id: number): Type {
  const t = forge.rawType(id);
  const type = (ty: number) => forge.type(ty);
  switch (t.tag) {
    case 'Scalar': {
      const s = t.value;
      switch (s.tag) {
        case 'Unknown':
          return { kind: 'scalar', scalar: 'unknown' };
        case 'Null':
          return { kind: 'scalar', scalar: 'null' };
        case 'Boolean':
          return { kind: 'scalar', scalar: 'boolean' };
        case 'String':
          return { kind: 'scalar', scalar: 'string' };
        case 'Number':
          return { kind: 'scalar', scalar: 'number', number: numberFormatNames[s.value.tag]! };
        case 'DateTime':
          return { kind: 'scalar', scalar: 'date-time' };
        case 'Date':
          return { kind: 'scalar', scalar: 'date' };
        case 'Bytes':
          return { kind: 'scalar', scalar: 'bytes' };
        case 'Binary':
          return { kind: 'scalar', scalar: 'binary' };
        case 'Uuid':
          return { kind: 'scalar', scalar: 'uuid' };
      }
      throw new Error(`unknown scalar tag`);
    }
    case 'Enum':
      return { kind: 'enum', values: t.value.map((v) => v.value) };
    case 'Array': {
      const elem = t.value.elem;
      const minItems = t.value.minItems;
      const maxItems = t.value.maxItems;
      return {
        kind: 'array',
        get elem() {
          return type(elem);
        },
        minItems: minItems === null ? undefined : Number(minItems),
        maxItems: maxItems === null ? undefined : Number(maxItems),
      };
    }
    case 'Object': {
      const fieldList = t.value.fields;
      const len = fieldList.length;
      const fields: FieldImpl[] = new Array(len);
      for (let i = 0; i < len; i++) {
        const cur = forge.fieldAt(fieldList, i);
        fields[i] = new FieldImpl(forge, id, i, fieldList, cur.ty);
      }
      const extra = t.value.extra ?? undefined;
      return {
        kind: 'object',
        fields,
        get extra() {
          return extra === undefined ? undefined : type(extra);
        },
      };
    }
    case 'Union': {
      const members = ids(t.value.members);
      const d = t.value.discriminator;
      const discriminator: Discriminator | undefined = d
        ? (() => {
            const wireName = d.wireName;
            const name = new NameImpl(d.name);
            const rawCases: [string, number][] = [];
            for (const c of d.cases) {
              rawCases.push([c.value, c.ty]);
            }
            const defaultModel = d.defaultModel ?? undefined;
            return {
              wireName,
              name,
              get cases() {
                return rawCases.map(([value, ty]) => [value, type(ty)] as const);
              },
              get default() {
                return defaultModel === undefined ? undefined : forge.model(defaultModel);
              },
            };
          })()
        : undefined;
      return {
        kind: 'union',
        get members() {
          return members.map(type);
        },
        exclusive: t.value.exclusive,
        discriminator,
      };
    }
    case 'Intersection': {
      const members = ids(t.value);
      return {
        kind: 'intersection',
        get members() {
          return members.map(type);
        },
      };
    }
    case 'Model': {
      const modelId = t.value;
      return {
        kind: 'model',
        get model() {
          return forge.model(modelId);
        },
      };
    }
  }
}
