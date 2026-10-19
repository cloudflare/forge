import type { Field, Model, Type } from '@cloudflare/forge/plugin';

import type { JsonSchema } from './catalogue.ts';

type Schema = { [key: string]: unknown };

/**
 * Turns forge types into JSON Schema 2020-12.
 *
 * A model becomes a `$ref` to `#/$defs/<key>`, so recursive models work. Each
 * model's schema is built once for the whole catalogue; {@link defs} gives a
 * tool only the models it can reach, so every tool's schema stands alone.
 */
export class SchemaBuilder {
  readonly #keys = new Map<Model, string>();
  readonly #usedKeys = new Set<string>();
  readonly #schemas = new Map<Model, Schema>();
  readonly #deps = new Map<Model, Set<Model>>();

  /** The schema of a type. Models it refers to are recorded in `refs`. */
  type(type: Type, refs: Set<Model>): Schema {
    switch (type.kind) {
      case 'scalar':
        return scalar(type);
      case 'enum': {
        const kinds = new Set(type.values.map((value) => typeof value));
        const [only] = kinds;
        return kinds.size === 1 && only !== undefined
          ? { type: only, enum: [...type.values] }
          : { enum: [...type.values] };
      }
      case 'array':
        return {
          type: 'array',
          items: this.type(type.elem, refs),
          ...(type.minItems !== undefined && { minItems: type.minItems }),
          ...(type.maxItems !== undefined && { maxItems: type.maxItems }),
        };
      case 'object':
        return this.object(type.fields, refs, type.extra);
      case 'union':
        return { [type.exclusive ? 'oneOf' : 'anyOf']: type.members.map((member) => this.type(member, refs)) };
      case 'intersection':
        return { allOf: type.members.map((member) => this.type(member, refs)) };
      case 'model':
        refs.add(type.model);
        return { $ref: `#/$defs/${this.#key(type.model)}` };
    }
  }

  /** An object schema of fields, keyed by `key`. Read-only fields, which the server sets, are left out. */
  object(fields: readonly Field[], refs: Set<Model>, extra?: Type, key = (field: Field) => field.wireName): Schema {
    const properties: Schema = {};
    const required: string[] = [];
    for (const field of fields) {
      if (field.readOnly) {
        continue;
      }
      properties[key(field)] = this.field(field, refs);
      if (field.required) {
        required.push(key(field));
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
      ...(extra && { additionalProperties: this.type(extra, refs) }),
    };
  }

  /** A field's schema, with its description, default and deprecation. */
  field(field: Field, refs: Set<Model>): Schema {
    return {
      ...this.type(field.type, refs),
      ...(field.description && { description: field.description }),
      ...(field.default !== undefined && { default: field.default }),
      ...(field.deprecated && { deprecated: true }),
    };
  }

  /** The `$defs` for `refs`: each model they refer to, directly or through other models. */
  defs(refs: Iterable<Model>): Record<string, JsonSchema> | undefined {
    const seen = new Set<Model>();
    const queue = [...refs];
    for (let model = queue.pop(); model !== undefined; model = queue.pop()) {
      if (seen.has(model)) {
        continue;
      }
      seen.add(model);
      this.#model(model);
      queue.push(...(this.#deps.get(model) ?? []));
    }
    if (seen.size === 0) {
      return undefined;
    }
    const entries = [...seen].map((model) => [this.#key(model), this.#model(model)] as const);
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** A model's schema, built the first time it is asked for. */
  #model(model: Model): Schema {
    let schema = this.#schemas.get(model);
    if (schema) {
      return schema;
    }
    const deps = new Set<Model>();
    schema = {
      ...this.type(model.type, deps),
      ...(model.description && { description: model.description }),
      ...(model.deprecated && { deprecated: true }),
    };
    this.#schemas.set(model, schema);
    this.#deps.set(model, deps);
    return schema;
  }

  /**
   * A model's key in `$defs`: its schema name, with characters a JSON Pointer
   * or URI fragment would need escaped replaced by `_`, and made unique.
   */
  #key(model: Model): string {
    let key = this.#keys.get(model);
    if (key) {
      return key;
    }
    const base = model.schemaName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'model';
    key = base;
    for (let i = 2; this.#usedKeys.has(key); i++) {
      key = `${base}_${i}`;
    }
    this.#keys.set(model, key);
    this.#usedKeys.add(key);
    return key;
  }
}

function scalar(type: Extract<Type, { kind: 'scalar' }>): Schema {
  switch (type.scalar) {
    case 'number':
      return { type: type.number === 'float' || type.number === 'double' ? 'number' : 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'unknown':
      return {};
    case 'string':
      return { type: 'string' };
    case 'date-time':
      return { type: 'string', format: 'date-time' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'bytes':
      return { type: 'string', contentEncoding: 'base64' };
    case 'binary':
      return { type: 'string', format: 'binary' };
  }
}
