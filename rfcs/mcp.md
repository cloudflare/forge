# RFC: Progressive Type-Feedback MCP target (`--target mcp`)

## Summary

`forge <spec> --target mcp --out <dir>` generates a Model Context Protocol (MCP) runtime (`mcp.ts` and `_/mcp.ts`) layered on top of the generated TypeScript SDK (`--target ts`).

Instead of emitting one MCP tool per OpenAPI operation or requiring the model to filter raw OpenAPI JSON in JavaScript, the server exposes the generated TypeScript SDK through two MCP tools (`search` and `execute`) and browsable MCP resources (`resources/list`, `resources/templates/list`, `resources/read`).

## Motivation

Large OpenAPI descriptions (thousands of operations and models) break standard MCP tool generation in two ways:

1. **One tool per operation overflows context.** Emitting 3,000+ tool schemas produces megabytes of `tools/list` JSON, exceeding client tool limits and degrading tool selection accuracy.
2. **Raw OpenAPI `search` + `execute` is brittle.** Exposing `search` and `execute` over raw `spec.paths` forces the model to write custom JavaScript filters against deeply nested OpenAPI JSON and hand-craft `fetch(path, body)` calls without static type checking. A single `snake_case` vs `camelCase` mistake or nested field error causes a live HTTP `400`/`404` round-trip.

Forge already compiles OpenAPI into a hierarchical TypeScript SDK (`Group` -> `Method` -> `Model` -> `Type`). Using that SDK as both the schema representation and the execution layer solves both problems:

- **Compact 1-level `.d.ts` views.** A 1-level `.d.ts` declaration is ~300–600 tokens (~10x smaller than the equivalent dereferenced JSON Schema).
- **Pre-flight type feedback.** Validating arguments against the SDK schema before sending any HTTP request catches unknown methods, `snake_case` wire names, read-only fields, missing required parameters, and nested union/model type errors, returning compiler-style diagnostics with the relevant 1-level `.d.ts` attached in the same turn.

## Overview

```text
OpenAPI JSON ──► forge --target mcp ──► Typed TS SDK (client.ts, <group>/client.ts, models.ts)
                                    └──► MCP Runtime (mcp.ts, _/mcp.ts)
                                           ├── Resources: forge://sdk, forge://sdk/{query}
                                           ├── Tool 1:    search({ query? })        ──► 1-level .d.ts (~300-600 tokens)
                                           └── Tool 2:    execute({ code, params? }) ──► Pre-flight validator
                                                                                           ├── Type error ──► TS2339/TS2561/TS2540/TS2741/TS2322 + 1-level .d.ts (0 HTTP calls)
                                                                                           └── Valid      ──► Calls Forge TS Transport (or returns CallPlan in isolate)
```

1. **Resources (`forge://sdk`)** expose the SDK group tree (`resources/list`) and a URI template (`forge://sdk/{query}`) so MCP clients can browse groups, methods, and models directly.
2. **`search({ query? })`** inspects a 1-level `.d.ts` TypeScript declaration for any SDK group, method, or model, or searches across all SDK paths, HTTP routes, summaries, and descriptions.
3. **`execute({ code, params? })`** runs JavaScript/TypeScript against the wrapped `client`. Returning an uninvoked namespace or method inspects its `.d.ts`; calling `await client.<group>.<method>(...)` validates arguments before making an HTTP request.

## MCP protocol surface

### Resources (`resources/list`, `resources/templates/list`, `resources/read`)

- **`resources/list` (`mcp.resources`)**: Lists `forge://sdk` (top-level `Client` index) and `forge://sdk/<group>` for each top-level SDK group, with subgroup previews, method counts, and `mimeType: "application/typescript"`.
- **`resources/templates/list` (`mcp.resourceTemplates`)**: Exposes `forge://sdk/{query}` (`mimeType: "application/typescript"`) for drilling into nested groups, methods, models, or search queries.
- **`resources/read` (`mcp.readResource(uri)`)**: Reads `forge://sdk`, `forge://sdk/dns.records`, or `forge://sdk/dns/records/create` and returns its 1-level `.d.ts` declaration.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/read",
  "params": { "uri": "forge://sdk/dns.records" }
}
```

### Tools (`tools/list` & `tools/call`)

`tools/list` (`mcp.tools`) advertises two tools:

| Tool      | Input schema                                         | Behavior                                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`  | `{ query?: string }`                                 | Returns a 1-level `.d.ts` TypeScript declaration and JSDoc for an SDK group (`"dns.records"`), method (`"dns.records.create"`), model (`"dns.records.RecordSettings"`), HTTP verb + route (`"POST /zones/{zoneId}/dns_records"`), or keyword query (`"purge cache"`). |
| `execute` | `{ code: string, params?: Record<string, unknown> }` | Evaluates a JavaScript expression or async function body against the wrapped Forge `client`. Validates arguments pre-flight before sending any HTTP request.                                                                                                          |

#### `tools/call` -> `search`

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "query": "dns.records" }
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

Drilling into `dns.records.create` (`{ "name": "search", "arguments": { "query": "dns.records.create" } }`):

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
| Root index      | `search()` or `search("client")`                                          | Top-level groups on `Client` with subgroup previews and method counts.                                                                                                                       |
| Group           | `search("dns.records")`                                                   | 1-level `dns.records.Client` interface with child groups, method signatures, and HTTP route comments.                                                                                        |
| Method          | `search("dns.records.create")`                                            | Method JSDoc (including OpenAPI `x-*` extensions), signature, 1-level `CreateRequest` and `CreateResponse`, and nominal referenced model names.                                              |
| Model           | `search("dns.records.RecordSettings")` or `search("RecordSettings")`      | 1-level `RecordSettings` declaration and its referenced model names.                                                                                                                         |
| Route / keyword | `search("POST /zones/{zoneId}/dns_records")` or `search("create bucket")` | Ranked method match(es). Single match expands its 1-level method `.d.ts`; <=12 matches render grouped method signatures; >12 matches across >2 groups roll up into `SearchMatches` by group. |

- **Inline primitives, nominal complex models.** Scalar, enum, and primitive-array `$ref`s are inlined directly into `CreateRequest`, while nested object/union models (`settings?: dns.records.RecordSettings`) stay nominal until inspected.
- **Flat union request bodies.** When an operation's flat request body is a union of object models, common and branch fields are merged into a single 1-level `CreateRequest` interface (with path/query parameters and required fields listed first).

## Pre-flight validation diagnostics

Before `execute()` or `plan()` sends an HTTP request, `validateMethodCall` checks the argument object against `MethodSchema`:

| Diagnostic code     | Condition                                                                                                      | Attached `.d.ts` context                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TS2339`            | Unknown group or method on `client` (e.g. `client.dns.records.add`)                                            | Scoped fuzzy suggestions (`Did you mean 'create'?`) + parent group `.d.ts` (or keyword search results). |
| `TS2561`            | OpenAPI `snake_case` wire name passed instead of SDK `camelCase` property (e.g. `zone_id` instead of `zoneId`) | Exact `camelCase` suggestion + method `.d.ts` (and nested model `.d.ts` if nested).                     |
| `TS2540`            | Assignment to a `readonly` property in a request payload                                                       | Method `.d.ts` + offending model `.d.ts`.                                                               |
| `TS2741`            | Missing required path, query, or body property                                                                 | Method `.d.ts` + offending model `.d.ts`.                                                               |
| `TS2322` / `TS2554` | Type mismatch (scalar, enum, array bounds, object, union, intersection) or wrong argument count                | Method `.d.ts` + offending nested model `.d.ts`.                                                        |

## Credential-free isolate planning (`plan()`)

For multi-tenant runtimes where untrusted agent code runs inside a credential-free isolate and a host service attaches credentials and enforces policy:

```ts
const callPlan = await mcp.plan(
  `await client.storage.buckets.create({ name: 'media-assets', storageClass: 'InfrequentAccess' })`,
  {
    defaultParams: { orgId: 'org_auto_123' },
    unresolvedParams: { orgId: 'Select an organization first with orgs.list.' },
  },
);
```

`plan()` executes the snippet against `client` without making network requests and returns a `CallPlan`:

```ts
type CallPlan =
  | {
      readonly kind: 'request';
      readonly method: string;
      readonly url: string;
      readonly route: string;
      readonly methodPath: string;
      readonly headers: Record<string, string>;
      readonly body?: string | undefined;
      readonly extensions?: Readonly<Record<string, unknown>> | undefined;
      readonly pathParams?: Readonly<Record<string, string>> | undefined;
    }
  | {
      readonly kind: 'missing_param';
      readonly param: string;
      readonly message: string;
      readonly methodPath: string;
    }
  | {
      readonly kind: 'invalid';
      readonly error: string;
      readonly issues?: readonly ValidationIssue[] | undefined;
      readonly typeDefinition?: string | undefined;
    };
```

- **`defaultParams` & `unresolvedParams`**: Automatically injects session default parameters (such as `orgId` or `accountId`) into methods that declare a matching required parameter when omitted by the caller, or returns `missing_param` with custom guidance when unresolved.
- **OpenAPI `extensions` passthrough**: Preserves operation `x-*` extensions on `MethodSchema`, `CallPlan`, and `401`/`403` error results so the host can check required scopes/permissions without provider-specific hardcoding.
