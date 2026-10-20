# TypeScript SDK

This document proposes the design for the TypeScript SDK that Forge generates from an OpenAPI spec. The design is meant to work for any API described by an OpenAPI spec with forge supported annotations mainly groups and method.

## Contents

- [Discovery](#discovery)
  - [What about tree shaking?](#what-about-tree-shaking)
  - [Why not classes instead of these create functions?](#why-not-classes-instead-of-these-create-functions)
- [Naming](#naming)
  - [Where names come from](#where-names-come-from)
  - [Names that can't be identifiers](#names-that-cant-be-identifiers)
  - [Conflicts](#conflicts)
- [Modules](#modules)
  - [Where models live](#where-models-live)
- [Client configuration](#client-configuration)
- [Client shape](#client-shape)
- [Methods](#methods)
  - [List](#list)
  - [Options](#options)
- [Request and Response shapes](#request-and-response-shapes)
  - [Requests](#requests)
  - [Responses](#responses)
- [Types](#types)
  - [Schemas](#schemas)
  - [Compositions](#compositions)
  - [Objects](#objects)
  - [Models](#models)
- [Non-JSON operations](#non-json-operations)
- [Errors](#errors)
- [Runtime requirements](#runtime-requirements)
- [Versioning](#versioning)
- [Future scope](#future-scope)
- [Conclusion](#conclusion)

## Discovery

```ts
import { createClient } from "@cloudflare/sdk";

const cf = createClient({token: ...});
```

There should be a single entry point for all of an API's operations. This makes it really simple for humans and AI alike to discover endpoints:

```ts
const retentionLog = await cf.logs.control.retention.get(...);
```

The property path follows the groups Forge derives from the spec. The SDK will normalize to use camelCase for sub-group accessors.

### What about tree shaking?

Such a client is not tree-shakable. However, we can make the SDK fully tree-shakable by exporting each client on a different path:

```ts
import { createClient } from "@cloudflare/sdk/logs/control/retention";

const retention = createClient({...});
const retentionLog = await retention.get(...);
```

Notice that the import path is the same as the property access. We also retain the function name.

### Why not classes instead of these create functions?

Classes tie us to a concrete implementation. Using a function and exposing an interface allows us to swap out the implementation. This allows us to keep the SDK API stable while allowing us to choose and change the implementation as we see fit. We may very well choose a class internally, but the public API should be a function that returns an interface.

## Naming

Groups, methods and fields are camelCase. Types are PascalCase. Forge splits them into words at `-`, `_` and case changes, each word is lower-cased, and the words are joined again:

| Name | camelCase | PascalCase |
| --- | --- | --- |
| `pet-store` | `petStore` | `PetStore` |
| `created_at` | `createdAt` | `CreatedAt` |
| `XMLDocument` | `xmlDocument` | `XmlDocument` |
| `GraphQL` | `graphQl` | `GraphQl` |
| `ipv4_cidr` | `ipv4Cidr` | `Ipv4Cidr` |

Each name then has exactly one camelCase and one PascalCase spelling, whatever its casing in the spec.

### Where names come from

| Name | Source |
| --- | --- |
| group | `x-fern-sdk-group-name` |
| method | `x-fern-sdk-method-name` |
| model | `x-fern-type-name`, or the schema name |
| field | `x-fern-property-name` or `x-fern-parameter-name`, or the property or parameter name |

### Names that can't be identifiers

A name that starts with a digit gets a `_` in front: `2fa` becomes `_2fa`.

A property or query parameter whose name has a character other than a letter, digit, `-` or `_`, such as `name.eq`, `@type` or `filter[status]`, is left out of the types. Such query parameters can still be sent through the `query` option, and an object that leaves out a property accepts other keys (`[key: string]: unknown`), so the property can still be sent.

### Conflicts

When two methods of one group, two sibling groups, or two models in one group end up with the same name, the SDK is not generated. Only the API author knows which one deserves the name, so they have to fix it in the spec.

Name conflicts with generated symbols like `Client` and `ClientOptions` are resolved by appending a `$` to the conflicting name.

## Modules

Every group is a module, and its import path is its property path:

| Import path | Client |
| --- | --- |
| `@cloudflare/sdk` | `cf` |
| `@cloudflare/sdk/zones` | `cf.zones` |
| `@cloudflare/sdk/logs/control/retention` | `cf.logs.control.retention` |

Every module exports:

- `createClient` and `ApiError`, as values;
- `Client`, `ClientOptions` and `RequestOptions`, as types;
- each method's `<Method>Request` and `<Method>Response`, as types;
- the models that live in the group, as types.

`ApiError` is the same class whichever module it is imported from, so `instanceof` works across modules.

### Where models live

A model lives in the deepest group shared by every method that uses it. A model used only by `cf.zones.dns.records` is imported from `@cloudflare/sdk/zones/dns/records`. A model used by both `cf.zones` and `cf.accounts` is imported from `@cloudflare/sdk`. A module doesn't re-export its ancestors' models.

Importing a module loads the clients of that group and its subgroups and the models they depend upon.

## Client configuration

```ts
const cf = createClient({
    token: env.CLOUDFLARE_API_TOKEN, // Required
    baseUrl: "https://...", // optional
});
```

Credentials are required and are never read from the environment implicitly. Reading them from an env var is trivial for users, and keeping them required surfaces missing credentials as an explicit error instead of a runtime failure later. The shape of the credentials follows the security schemes declared in the spec; a bearer token, as in the example, is the common case. `baseUrl` is optional and defaults to the server URL declared in the spec. Per-module clients accept the same configuration.

The full set of options:

```ts
interface ClientOptions {
    token: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: HeadersInit;
    query?: URLSearchParams;
}
```

- `token` is sent as `Authorization: Bearer <token>`.
- `fetch` replaces the global `fetch`. This is useful for testing, proxies and instrumentation.
- `headers` and `query` are sent with every request.

## Client shape

A client is a plain object. Its methods and subgroups don't depend on `this`, so they can be destructured:

```ts
const { zones } = cf;
const { list } = cf.zones;
await list();
```

A subgroup accessor returns the same client every time, so `cf.zones === cf.zones`.

A group can have a method and a subgroup with the same name, such as an `archive` method next to an `archive` group that contains `restore`. The property is then both: it can be called, and it has the subgroup's members.

```ts
await cf.projects.archive({ ... });         // the method
await cf.projects.archive.restore({ ... }); // the subgroup
```

## Methods

Each method corresponds to an operation in the OpenAPI spec. Every method will have corresponding types defined as `<Method>Request` and `<Method>Response`. They will be available to import from their respective modules:

```ts
import type { GetRequest, GetResponse } from "@cloudflare/sdk/logs/control/retention";
```

For the most part, these will not be needed, as the clients are fully typed. But in the odd cases where they are needed, they should be available.

The general signature of a method:

```ts
interface Client {
    method(params: MethodRequest, options?: RequestOptions): Promise<MethodResponse>;
}
```

There are some exceptions to this rule:

- If the operation has no response body, the return type is `Promise<void>`.
- If every field of the request is optional, `params` is optional too: `cf.zones.list()`.
- APIs that support pagination will have a special signature, see below.

### List

This applies to any operation that supports pagination. Such methods can be used like any other method, but they also offer another way to use them:

```ts
for await (const zone of cf.zones.list({perPage: 10})) {
    console.log(zone.name);
}
```

The response of `list` is both a `Promise<ListResponse>` and an `AsyncIterable<Item>`. This is a nice way to do pagination without having to think about it. Users who don't want to use this can always simply await the promise and get the response:

```ts
const zones = await cf.zones.list({perPage: 10});
```

APIs paginate in different ways (page numbers, offsets, cursors), so the generator needs to know which style an operation uses and where the items are in the response. The iterator hides that difference from users.

We can extend this later to support page wise iterators as well.

### Options

The second argument is an options object. It is used to pass in things like `signal` for aborting, `headers` for custom headers, callbacks for response headers, etc. All the options, and the parameter itself, are optional. Any new parameters added to it must also be optional. We can start simple with something like headers and keep adding new ones as we see fit.

The options to start with:

```ts
interface RequestOptions {
    signal?: AbortSignal;
    headers?: HeadersInit;
    query?: URLSearchParams;
    onResponse?: (response: Response) => void;
}
```

- `signal` aborts the request.
- `headers` replace headers of the same name set in the client options, including `Authorization`.
- `query` is appended after the client's `query`, so a key can repeat: `tag=a&tag=b`.
- `onResponse` is called with the raw `Response` of a successful request, before its body is read. This is how response headers are read.

## Request and Response shapes

The request and response shapes will always use camelCase fields. This is more idiomatic in JS/TS. Many APIs use snake\_case on the wire, or mix conventions, so the client transforms the fields at the transport layer. This is not a blanket conversion of every key; we will generate per-type conversion code for each request and response type, so user-defined maps are left untouched. The SDK doesn't require the API to accept camelCase.

Only fields declared in the spec are converted. A field the spec doesn't declare, such as one added after the SDK was generated, keeps its wire name, e.g. `created_at`, and an extra key sent through an index signature must use its wire name.

Only path parameters, query parameters, and body properties are considered part of a request. Header parameters are not part of the request shape; they can be passed via the optional headers param available on every method. This is intentional: headers are not a good way to model required inputs, and leaving them out encourages API authors to move away from them.

### Requests

A request is one object. It lists the path parameters in the order they appear in the path, then the query parameters, then the body. Path parameters are always required, and a query parameter is required when the spec says so.

When the body is an object, its properties sit next to the parameters:

```ts
await cf.projects.update({
    orgId: "...",          // path
    projectId: "...",      // path
    dryRun: true,          // query
    displayName: "Docs",   // body
});
```

The body is nested under `body` instead when it is an array, a primitive, a map or nullable:

```ts
await cf.projects.members.remove({ orgId: "...", body: ["alice", "bob"] });
```

The body is also nested when one of its properties has the same name as a parameter, so that both can be set. Adding such a parameter to an operation later moves its body under `body`, which changes the request type.

Some names get a `$` suffix to stay distinct: a query parameter with the same name as a path parameter, and a parameter named `body` when the body is nested.

A body's required properties stay required even when the spec doesn't mark the body itself as required. Specs often leave out `requestBody.required`, and treating that as "every property is optional" would hide what the API expects.

Request types leave out `readOnly` properties, such as an `id` or a `createdAt` that the server sets, at any depth: the body's own properties, and those of every model nested inside it.

Arrays in the query repeat their key (`tag=a&tag=b`), or are joined with `,` when the parameter sets `explode: false`. `undefined` and `null` values are left out of the query.

### Responses

The response type is the body the spec declares for the operation's 2XX responses:

| Success responses | `<Method>Response` |
| --- | --- |
| none have a body | `void` |
| all have a body | a union of the body types |
| some have a body | a union of the body types `\| undefined` |

The body is returned as declared. Envelopes such as `{ result, success, errors, messages }` are not unwrapped. Each API names its envelope differently, so unwrapping would need a guess per API, and would drop the metadata next to the payload, such as pagination info. An API that wants unwrapped responses declares the unwrapped body in its spec.

The response type holds the body only. Response headers are read through `options.onResponse`.

## Types

All model types should be available in their own modules. For example, `Zone` should be importable from `@cloudflare/sdk/zones`. All of the generated models should be type-only, so they are erased at runtime. Enums will be represented as string-literal unions (e.g. `type ZoneStatus = "active" | "pending" | "moved"`).

The types compile under `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Descriptions in the spec appear as JSDoc on the model, field or method they describe.

### Schemas

| Schema | Type |
| --- | --- |
| `format: date-time` | `Temporal.Instant` |
| `format: date` | `Temporal.PlainDate` |
| `format: byte` | `Uint8Array` |
| `type: string`, any other `format` | `string` |
| `format: int64` | `bigint` |
| `type: integer` or `number`, any other `format` | `number` |
| `type: boolean` | `boolean` |
| `type: null` | `null` |
| several types | a union of each |
| `enum: [active, pending]` | `"active" \| "pending"` |
| `items: X` | `X[]` |
| `nullable: true` | `T \| null` |
| no `type` and no other keyword | `unknown` |

The client converts dates, bytes and `int64` values in both directions, so callers pass and receive these types, not strings or numbers:

```ts
await cf.tokens.create({ expiresOn: Temporal.Now.instant().add({ hours: 1 }), maxUses: 10n });
```

#### Why Temporal instead of `Date`?

Temporal is the replacement for `Date`. It has separate types for an instant and a calendar date, which `Date` mixes up.

#### Why `bigint` for `int64`?

An `int64` can exceed `Number.MAX_SAFE_INTEGER`, and a `number` silently loses precision past it. The client reads and writes these values from the raw JSON text, so they round-trip exactly.

### Compositions

`allOf` becomes an intersection, `A & B`. `oneOf` and `anyOf` both become a union, `A | B`. Properties declared next to a composition are intersected with it: `{ id: string } & (A | B)`.

A TypeScript union matches a value that fits any of its members, which is exactly what `anyOf` means. TypeScript can't say that a value fits only one member, as `oneOf` requires. A union still narrows on a discriminator property when each variant declares it as a single-value enum.

Unions are flattened: each member appears once, nested unions are merged, and a union left with one member is that member.

### Objects

A required property is `name: T`, and an optional one is `name?: T`. Optional and nullable are different: `name?: T` may be left out, and `name: T | null` must be present but can be `null`.

`additionalProperties` adds an index signature. An object with no properties becomes a map, `{ [key: string]: T }`. An object with properties gets `[key: string]: unknown` next to them.

### Models

Every schema in `components/schemas` that a method uses is a model, including schemas that only other models refer to, so every type a method mentions can be imported by name. An object model is an `interface`, and every other model, such as an enum or a union, is a `type`.

#### Why literal unions for enums?

TypeScript's `enum` is a runtime value, and models are type-only. `enum` and `declare const enum` also don't work with isolated-module tooling such as Node's type stripping. A union of literals is erased, and callers write the plain value: `status: "active"`.

## Non-JSON operations

Some operations send or receive something other than JSON on success, e.g. multipart uploads, binary bodies, plain text, and streaming. These are excluded from this document and will be covered in a follow-up. This is to ensure each type gets the required attention it needs.

Until then, these operations are left out of the client. Generating them with loose types, such as `body: BodyInit` and `Promise<Response>`, would commit to an API the follow-up hasn't designed yet. A group whose operations are all left out still has a client, so the tree keeps its shape when they are added.

A media type is JSON when it is `application/json` or ends in `+json`, such as `application/merge-patch+json`. An operation whose body offers both JSON and another type, such as multipart, is included and sends JSON with that media type.

## Errors

All errors returned by the API should be thrown as `ApiError` with a `status` property. The error message should come from the error response body when the spec describes one, and fall back to the HTTP status text otherwise. The error should also have the raw response along with the body when available. This will make it easier to debug.

```ts
class ApiError extends Error {
    readonly status: number;
    readonly response: Response;
    readonly details: unknown;
}
```

`ApiError` is thrown for every response outside 200-299. It is also thrown for a success response whose body isn't valid JSON, with the `SyntaxError` as its `cause`.

`details` is the error body. When the spec declares a JSON error response for the status, and the body parses, `details` is the body converted like a success response, with camelCase fields. The declared response is looked up by the exact status first, then its range, such as `4XX`, then `default`. Otherwise `details` is the body as text, so a proxy's HTML page or an undocumented status still says what went wrong. It is `undefined` when the body is empty.

`details` is typed `unknown`, since the same `ApiError` is thrown by every method and a `catch` block can't supply a type parameter. The error models are exported like every other model, so callers narrow with the status:

```ts
try {
    await cf.zones.get({ zoneId });
} catch (e) {
    if (e instanceof ApiError && e.status === 404) {
        const details = e.details as NotFound;
    }
}
```

For a JSON body, the message is the first of:

1. a non-empty string `message`, `error`, `detail` or `title`;
2. `error.message` or `error.detail`, when `error` is an object;
3. the messages of an `errors` array, joined with `"; "`.

Otherwise it is the status line, such as `404 Not Found`.

Failures that happen before a response is received (network errors, aborts, timeouts) are not wrapped in `ApiError`; they are thrown as-is. Invalid input that the client catches before sending, such as missing credentials, is thrown as a `TypeError`.

`ApiError` is the only class the SDK exports.

## Runtime requirements

The SDK uses web-standard APIs only: `fetch`, `URL`, `Headers`, `Response`, `AbortSignal` and `Temporal`. It also needs `JSON.rawJSON` and the source text access of `JSON.parse` to read and write `int64` values exactly. It has no dependencies, so it runs in Node, Deno, Bun, edge runtimes and browsers that support these APIs. Runtimes without `Temporal` need a polyfill.

## Versioning

The client and the API are versioned independently, but linked: each client version is generated from exactly one version of the spec. For example, client `v1.2.3` might map to API `2026-09-01`. Because the client has its own version, we can release client fixes against the same API version. We can always tag releases in such a way that the API version they map to is easy to see.

## Future scope

The client should be able to handle things like rate-limiting and retries. This can be done in the transport layer. The `fetch` client option is the first step; we can expand from there.