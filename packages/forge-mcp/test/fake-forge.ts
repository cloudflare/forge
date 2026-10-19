// Plain objects with the shapes of @cloudflare/forge/plugin's interfaces, so
// the catalogue builder runs in Node without a forge host.
import type {
  Body,
  Field,
  Forge,
  Group,
  Location,
  Method,
  Model,
  Name,
  ObjectType,
  Type,
} from '@cloudflare/forge/plugin';

export function name(text: string): Name {
  const words = text
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    words,
    isEmpty: words.length === 0,
    camel: () => words.map((word, i) => (i === 0 ? word : cap(word))).join(''),
    pascal: () => words.map(cap).join(''),
    snake: () => words.join('_'),
    kebab: () => words.join('-'),
    equals: (other) => other.words.join(' ') === words.join(' '),
    toString: () => words.join(' '),
  };
}

export const string: Type = { kind: 'scalar', scalar: 'string' };
export const integer: Type = { kind: 'scalar', scalar: 'number', number: 'int32' };

export function field(wireName: string, type: Type, extra: Partial<Field> = {}): Field {
  return {
    wireName,
    name: name(wireName),
    required: false,
    description: '',
    deprecated: false,
    readOnly: false,
    sensitive: false,
    default: undefined,
    type,
    ...extra,
  };
}

export function object(fields: Field[], extra?: Type): ObjectType {
  return { kind: 'object', fields, extra };
}

export function model(schemaName: string, type: () => Type, description = ''): Model {
  const m = { schemaName, name: name(schemaName), group: undefined, description, deprecated: false } as Model & {
    type: Type;
  };
  Object.defineProperty(m, 'type', { get: type });
  return m;
}

export function jsonBody(type: Type, required = true): Body {
  const json = { mediaType: 'application/json', isJson: true, description: '', type };
  return { required, description: '', contents: [json], json };
}

interface MethodSpec {
  name: string;
  httpMethod?: string;
  path?: string;
  summary?: string;
  description?: string;
  params?: Array<[Field, Location]>;
  headers?: Field[];
  body?: Body;
  hidden?: boolean;
  deprecated?: boolean;
  confirmation?: string;
  availability?: Method['availability'];
}

export function forge(groups: Record<string, MethodSpec[]>, baseUrl = 'https://api.example.com/v1'): Forge {
  const built: Group[] = Object.entries(groups).map(([groupName, specs]) => {
    const group = {
      name: name(groupName),
      description: '',
      path: groupName.split('.').map(name),
      parent: undefined,
      children: [],
      descendants: [],
      models: [],
    } as unknown as Group & { methods: Method[] };
    group.methods = specs.map((spec) => method(spec, group));
    return group;
  });
  return { version: '1.0.0', description: '', baseUrl, groups: built, models: [] };
}

function method(spec: MethodSpec, group: Group): Method {
  const locations = new Map(spec.params ?? []);
  return {
    name: name(spec.name),
    group,
    httpMethod: spec.httpMethod ?? 'GET',
    path: spec.path ?? '/things',
    summary: spec.summary ?? '',
    description: spec.description ?? '',
    deprecated: spec.deprecated ?? false,
    availability: spec.availability,
    hidden: spec.hidden ?? false,
    confirmation: spec.confirmation,
    request: locations.size > 0 ? object([...locations.keys()]) : undefined,
    headers: spec.headers ? object(spec.headers) : undefined,
    body: spec.body,
    responses: [],
    errors: [],
    extensions: [],
    extension: () => undefined,
    location: (f) => locations.get(f),
  };
}

export const inPath: Location = { in: 'path' };
export const inQuery: Location = { in: 'query', exploded: true };
