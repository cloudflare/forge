# RFC: Progressive Type-Feedback MCP target (`--target mcp`)

## Summary

`forge <spec> --target mcp --out <dir>` generates a Model Context Protocol (MCP) runtime (`mcp.ts` and `_/mcp.ts`) layered on top of the generated TypeScript SDK (`--target ts`).

MCP clients fall into two categories: codemode-native clients (with built-in client-side tool search or code execution) that consume direct tool catalogues, and standard MCP clients that rely on server-side `search` and `execute` tools. This RFC focuses on the server-side `search` and `execute` runtime backed by the generated TypeScript SDK.

## Motivation

For standard MCP clients without client-side tool search, large OpenAPI descriptions (thousands of operations and models) hit two bottlenecks:

1. **Exposing every operation directly in `tools/list` overflows naive client context.** Sending 3,000+ tool schemas upfront produces megabytes of JSON.
2. **Raw OpenAPI `search` + `execute` is brittle.** Exposing `search` and `execute` over raw `spec.paths` forces the model to write custom JavaScript filters against deeply nested OpenAPI JSON and hand-craft `fetch(path, body)` calls without static type checking. A single `snake_case` vs `camelCase` mistake or nested field error causes a live HTTP `400`/`404` round-trip.
   Forge already compiles OpenAPI into a hierarchical TypeScript SDK (`Group` -> `Method` -> `Model` -> `Type`). Using that SDK as both the schema representation and the execution layer solves both problems:

- **Compact 1-level `.d.ts` views.** A 1-level `.d.ts` declaration is ~300–600 tokens (~10x smaller than the equivalent dereferenced JSON Schema).
- **Pre-flight type feedback.** Validating arguments against the SDK schema before sending any HTTP request catches unknown methods, `snake_case` wire names, read-only fields, missing required parameters, and nested union/model type errors, returning compiler-style diagnostics with the relevant 1-level `.d.ts` attached in the same turn.

## Overview

```text
OpenAPI JSON ──► forge --target mcp ──► Typed TS SDK (client.ts, <group>/client.ts, models.ts)
                                    └──► MCP Runtime (mcp.ts, _/mcp.ts)
                                         ├── Tool 1: search({ code? }) ──► 1-level .d.ts (~300–600 tokens)
                                         └── Tool 2: execute({ code }) ──► Pre-flight validator
                                                                           ├── Type error ──► TS2339/TS2561/TS2540/TS2741/TS2322 + 1-level .d.ts (0 HTTP calls)
                                                                           └── Valid      ──► Calls Forge TS Transport
```

1. **`search({ code? })`** runs read-only JavaScript against the SDK's `methods`, `groups`, `models`, and `dts("<symbol>")` helper (or resolves a symbol path / HTTP route directly) and returns a 1-level `.d.ts` TypeScript declaration.
2. **`execute({ code })`** runs JavaScript/TypeScript against the wrapped `client`. Returning an uninvoked namespace or method inspects its `.d.ts`; calling `await client.<group>.<method>(...)` validates arguments before making an HTTP request.

## MCP protocol surface (`tools/list` & `tools/call`)

`tools/list` (`mcp.tools`) advertises two tools:

| Tool | Input schema | Behavior |
| --- | --- | --- |
| `search` | `{ code?: string }` | Evaluates read-only JavaScript against `methods` (`{ path, group, name, httpMethod, route, summary, description }`), `groups`, `models`, and `dts("<symbol>")` (or resolves an SDK group, method, model, or HTTP route directly) and returns a 1-level `.d.ts` TypeScript declaration and JSDoc. |
| `execute` | `{ code: string }` | Evaluates a JavaScript expression or async function body against the wrapped Forge `client`. Validates arguments pre-flight before sending any HTTP request. |

#### `tools/call` -> `search`

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "code": "dts('dns.records')" }
  }
}
```

Response (`content[0].text`):

```ts
// Group: dns.records
export namespace dns.records {
  export interface Client {
    /** Create DNS Record */
    create(request: CreateRequest, options?: RequestOptions): Promise<CreateResponse>; // POST /zones/{zoneId}/dns_records
    /** List DNS Records */
    list(request: ListRequest, options?: RequestOptions): Promise<ListResponse>; // GET /zones/{zoneId}/dns_records
  }
}
```

Drilling into `dns.records.create` (`{ "name": "search", "arguments": { "code": "dts('dns.records.create')" } }`):
```ts
// Method: client.dns.records.create (POST /zones/{zoneId}/dns_records)

/**
 * Create DNS Record
 *
 * Creates a new DNS record for a zone.
 */
create(request: CreateRequest, options?: RequestOptions): Promise<CreateResponse>; // POST /zones/{zoneId}/dns_records

export interface CreateRequest {
  /** Zone identifier. */
  zoneId: string; // path param
  /** DNS record name. */
  name: string;
  /** DNS record type. */
  type: 'A' | 'AAAA' | 'CNAME';
  /** Time to live in seconds. */
  ttl?: number;
  /** Record-specific settings. */
  settings?: dns.records.RecordSettings;
}

export type CreateResponse = dns.records.RecordResponse;

// Referenced models (use search("<model>") to inspect): dns.records.RecordResponse, dns.records.RecordSettings
```

#### `tools/call` -> `execute` (pre-flight compiler feedback)

If the caller skips `search` or passes a raw OpenAPI `snake_case` wire name (`zone_id` instead of `zoneId`) or a bad nested type (`settings.ipv4Only: "yes"`), `execute` rejects the call before any HTTP request is made and attaches the relevant 1-level `.d.ts` definitions:

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "execute",
    "arguments": {
      "code": "await client.dns.records.create({ zone_id: 'z1', name: 'api.example.com', type: 'A', settings: { ipv4Only: 'yes' } })"
    }
  }
}
```

Response (`isError: true`, 0 HTTP requests sent):

```text
TS2741 at request.zoneId: Property 'zoneId' (string) is missing in type 'CreateRequest' but required.
TS2561 at request.zone_id: Object literal may only specify known properties, but 'zone_id' does not exist in type 'CreateRequest'. Did you mean 'zoneId' (the SDK's camelCase name for wire field 'zone_id')?
TS2322 at request.settings.ipv4Only: Type '"yes"' is not assignable to type 'boolean'.

--- TypeScript Definition (.d.ts) ---
// Method: client.dns.records.create (POST /zones/{zoneId}/dns_records)
export interface CreateRequest {
  zoneId: string; // path param
  name: string;
  type: 'A' | 'AAAA' | 'CNAME';
  ttl?: number;
  settings?: dns.records.RecordSettings;
}

// Model: dns.records.RecordSettings (OpenAPI schema 'RecordSettings')
export interface RecordSettings {
  /** Only resolve IPv4. */
  ipv4Only?: boolean;
  /** Flatten CNAME at apex. */
  flattenCname?: boolean;
}
```

## Progressive 1-level `.d.ts` rules

To keep every `search()` response and error payload bounded (~300–600 tokens) regardless of specification size:

| View            | Query example                                                             | Rendered output                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root index | `search()` or `search("dts()")` | Top-level groups on `Client` with subgroup previews and method counts. |
| Group | `search("dts('dns.records')")` | 1-level `dns.records.Client` interface with child groups, method signatures, and HTTP route comments. |
| Method | `search("dts('dns.records.create')")` | Method JSDoc (including OpenAPI `x-*` extensions), signature, 1-level `CreateRequest` and `CreateResponse`, and nominal referenced model names. |
| Model | `search("dts('dns.records.RecordSettings')")` | 1-level `RecordSettings` declaration and its referenced model names. |
| Code filter / HTTP route | `search("methods.filter(m => m.route.includes('/dns_records'))")` or `search("POST /zones/{zoneId}/dns_records")` | Matching method signature(s) grouped by namespace, or full 1-level `.d.ts` when a single method matches. |

- **Inline primitives, nominal complex models.** Scalar, enum, and primitive-array `$ref`s are inlined directly into `CreateRequest`, while nested object/union models (`settings?: dns.records.RecordSettings`) stay nominal until inspected.
- **Flat union request bodies.** When an operation's flat request body is a union of object models, common and branch fields are merged into a single 1-level `CreateRequest` interface (with path/query parameters and required fields listed first).

## Pre-flight validation diagnostics

Before `execute()` sends an HTTP request, `validateMethodCall` checks the argument object against `MethodSchema`:

| Diagnostic code     | Condition                                                                                                      | Attached `.d.ts` context                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TS2339` | Unknown group or method on `client` (e.g. `client.dns.records.add`) | Scoped fuzzy suggestions (`Did you mean 'create'?`) + parent group `.d.ts`. |
| `TS2561` | OpenAPI `snake_case` wire name passed instead of SDK `camelCase` property (e.g. `zone_id` instead of `zoneId`) | Exact `camelCase` suggestion + method `.d.ts` (and nested model `.d.ts` if nested). |
| `TS2540`            | Assignment to a `readonly` property in a request payload                                                       | Method `.d.ts` + offending model `.d.ts`.                                                               |
| `TS2741`            | Missing required path, query, or body property                                                                 | Method `.d.ts` + offending model `.d.ts`.                                                               |
| `TS2322` / `TS2554` | Type mismatch (scalar, enum, array bounds, object, union, intersection) or wrong argument count | Method `.d.ts` + offending nested model `.d.ts`. |

## Runtime options (`include` & `evaluator` sandbox)

```ts
const mcp = createMcp(
  { token: 'session-token', baseUrl: 'https://api.example.com/v1', fetch: hostTransportFetch },
  {
    include: (method) => !method.deprecated && method.httpMethod === 'GET',
    evaluator: (code, globals, functionBody) => sandbox.eval(functionBody, globals),
  },
);
```

- **`include?: (method: MethodSchema) => boolean`**: Filters which SDK methods are exposed in `search()`, `dts()`, and `execute()` (and prunes groups that have no remaining methods). Each `MethodSchema` includes `httpMethod`, `route`, `deprecated`, and OpenAPI `extensions` (`x-*`), so servers can scope the visible surface by HTTP verb, deprecation status, or caller permissions.
- **`evaluator?: CodeEvaluator | false`**: Pluggable JavaScript evaluator for string snippets passed to `search()` and `execute()` so untrusted agent code runs in an isolated sandbox (such as a Cloudflare Dynamic Worker isolate, `@cloudflare/codemode`, QuickJS, or Node `vm.runInNewContext`) and works in runtimes that disallow dynamic code generation (`new Function` / `eval`). Direct symbol paths (`"dns.records.create"`, `'dts("dns.records")'`) and HTTP routes (`"POST /zones/{zoneId}/dns_records"`) in `search()` resolve via pure static lookup without invoking `evaluator` or `new Function`. Passing `evaluator: false` disables dynamic string evaluation while keeping static `search()` lookups and callback-form `execute(async (client) => ...)` active.
