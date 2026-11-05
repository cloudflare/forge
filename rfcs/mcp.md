# The MCP target

`forge openapi.json --target mcp --out tools` generates the tools of an MCP server in TypeScript: one tool for each API method, with everything needed to build the method's HTTP request from a call. This document specifies the mapping of the API onto MCP and the generated output, as the generator currently implements them.

Forge generates the tools, not a server. Every server around them differs in its authentication, its own tools, resources and prompts served alongside, and its handling of API errors. So the output is data, typed for the official MCP TypeScript SDK, `@modelcontextprotocol/server`, with one function that serves it on an `McpServer`:

```ts
import { registerTools, tools } from './tools/index.js';

// Each call sent with the server's credential.
registerTools(server, tools, {
  baseUrl: 'https://api.example.com',
  fetch: (input, init) => {
    // Optional fetch override
    const request = new Request(input, init);
    request.headers.set('authorization', authorization);
    return fetch(request);
  },
});
```

## Contents

- [Generated files](#generated-files)
- [Method coverage](#method-coverage)
- [Names](#names)
- [Arguments](#arguments)
- [The request](#the-request)
- [Schemas](#schemas)
- [Description and annotations](#description-and-annotations)
- [Extensions](#extensions)
- [Response schemas](#response-schemas)
- [Output schemas](#output-schemas)
- [The runtime](#the-runtime)
- [Client visibility](#client-visibility)

## Generated files

```text
tools/
  index.ts          every tool, the API's base URL and version, and the runtime's functions
  _/tool.ts         the runtime: the Tool type, registering tools, building requests
  schemas.ts        the schema of each top-level model used in arguments
  outputs.ts        the schema of each top-level model used in responses
  <group>/tools.ts  the tools of a group's methods
  <group>/schemas.ts  the schema of each model placed in the group and used in arguments
  <group>/outputs.ts  the schema of each model placed in the group and used in responses
```

Each `tools.ts` exports `tools`, an array of the group's tools sorted by name, and `index.ts` concatenates them. A tool is MCP's Tool, as `tools/list` sends it, plus its operation (the API method it calls) under a symbol that `JSON.stringify` leaves out:

```ts
{
  name: 'stores_pets_create',
  title: 'Create Pet',
  description: '…',
  inputSchema: { type: 'object', properties: { path: { … }, body: { … } }, required: ['path', 'body'], $defs: { … } },
  outputSchema: { … , $defs: { … } },
  annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
  [OPERATION]: {
    method: 'POST',
    path: '/stores/{store_id}/pets',
    query: [{ name: 'dry_run', explode: true }],
    headers: ['content-type'],
    body: { mediaTypes: ['application/json', 'multipart/form-data'] },
    extensions: { … },
    responses: { schemas: { '200': { … }, '4XX': { … } }, $defs: { … } },
  },
}
```

## Method coverage

Every method forge reads gets a tool, except:

| Method                                                                                                 | Reason                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Deprecated (`deprecated: true`)                                                                        | The API discourages new calls to it.                                                            |
| A tool name over 128 characters                                                                        | MCP's limit.                                                                                    |
| A tool name another method of its group already has, such as `x1b` and `x_1b`, both `x1b` in camelCase | Names must be unique across the server; the first method by name keeps it. See [Names](#names). |

Operations with `x-forge-skip: true` aren't methods in forge, so they get no tool. Hidden methods (`x-forge-hidden`) get a tool.

## Names

A tool is named after its groups and its method, each in camelCase, joined by `_`:

| Group                        | Method      | Tool                                 |
| ---------------------------- | ----------- | ------------------------------------ |
| `stores.pets`                | `create`    | `stores_pets_create`                 |
| `pet_stores.inventory.items` | `bulk_edit` | `petStores_inventory_items_bulkEdit` |
| `a.b`                        | `c`         | `a_b_c`                              |
| `a`                          | `b_c`       | `a_bC`                               |

OpenAI and Anthropic only accept `[a-zA-Z0-9_-]` in tool names, which rules out `.` as the separator. `_` only separates names: forge treats `_` inside a name as a word break, so the words of a name never contain it. Group `a.b` method `c` and group `a` method `b_c` would both be `a_b_c` in snake_case; in camelCase they differ. Tools of different groups never share a name.

Two names can still have the same camelCase spelling, since a digit belongs to the word before it: `x1b` is one word and `x_1b` two, both `x1b`. When two methods of a group collide this way, the first by name keeps the tool and the other gets none. Two sibling groups that collide would share a directory, which forge refuses to write. The TypeScript SDK spells names the same way and has the same limit.

The name comes from forge's group hierarchy and method names, as for every target, so it is stable while those are. Renaming a group renames its tools.

## Arguments

`inputSchema` is always an object, with an argument for each place a value goes:

- **`path`**: an object of the path parameters, keyed by their names on the wire. Every one is required, and so is `path`.
- **`query`**: an object of the query parameters, likewise. Each is required if the spec says so, and `query` is required if one is.
- **`headers`**: an object of the header parameters, keyed by name in lower case, as HTTP/2 and `fetch` write them. Read-only headers are left out.
- **`body`**: the body, as the API takes it, with the body's description. It is required if the body is. Its schema is the spec's for its media type, except that a `format: binary` value, such as a file part, is its contents as text or `{ content, filename?, contentType? }`, as `FormData.append(name, blob, filename)` takes a file. A body in several media types is `anyOf` the schema of each, and `headers` gains `content-type`, an enum of the media types, which names the one sent.

A place without parameters has no argument. `inputSchema` and each place set `additionalProperties: false`, so the SDK, which validates the arguments before a call reaches the tool, refuses a misspelled parameter or one in the wrong place. The arguments mirror the HTTP request, so names never clash and match the API's documentation:

```json
{ "path": { "store_id": "…" }, "query": { "page": 2 }, "body": { "name": "…" } }
```

## The request

A call's request is built from the tool's operation, relative to the API's base URL, and the call's arguments:

- `method`: the HTTP method.
- `path`: the template. Each parameter is filled in from `args.path` by name and percent-encoded. A missing or empty one is an error.
- `query`: each query parameter's wire name, and whether it is exploded. Its value is in `args.query`.
- `headers`: each header parameter's name, in lower case. Its value is in `args.headers`.
- `body`: the media types the API takes `args.body` in.

The SDK first validates the arguments against `inputSchema`: an argument the tool doesn't take, a required one left out, or a value of the wrong type is an error result, with the validator's message. `registerTools` then builds the request from the operation and passes it to the server's `fetch` as a `Request`, with lower-case header names and the body as a string. It:

- serializes query parameters in OpenAPI's default `form` style (`a=1&a=2` exploded, `a=1,2` not; objects as `k=v` pairs or `name=k,v`);
- joins an array header with `,`;
- leaves out every query parameter and header that is `undefined` or `null`;
- sends `Accept: application/json`;
- sends the body in the media type a `content-type` header argument names, or else the one its value fits, picked as `fetch` would: a file's own `contentType`; for a string or file, the first that is neither JSON nor a form; for anything else, the first JSON one, else `multipart/form-data` or `application/x-www-form-urlencoded` for an object;
- encodes the body as `fetch` would: a JSON media type as JSON; an object as `multipart/form-data` parts (a `{ content, filename?, contentType? }` as a file part, another object as a JSON part, anything else as a text part) or `application/x-www-form-urlencoded` pairs; and any other string as it is. A file as the whole body is its contents, as a `Blob` is. A string sent as `multipart/form-data` is a body already encoded; its first line names the boundary. Arguments are JSON, so a body of bytes, such as an image, can only be text.

Two things the schema lets through are error results too: an empty path parameter, and a query or header value that isn't a string, number or boolean.

## Schemas

Schemas are JSON Schema 2020-12, built from forge's model of the spec rather than copied from the OpenAPI document, so every target agrees on each type.

| Forge type                             | Schema                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| unknown                                | `{}`                                                                                       |
| null, boolean, string, integer, number | the `type`                                                                                 |
| uuid, date-time, date                  | `string` with that `format`                                                                |
| bytes                                  | `string` with `contentEncoding: base64`                                                    |
| binary                                 | `string` with `format: binary`                                                             |
| enum                                   | `enum` of the values, with `type` when they share one                                      |
| array                                  | `items`, with `minItems`/`maxItems`                                                        |
| object                                 | `properties`, `required`, and `additionalProperties` when the extra properties have a type |
| exclusive union / union                | `oneOf` / `anyOf`                                                                          |
| intersection                           | `allOf`                                                                                    |
| model                                  | `{ "$ref": "#/$defs/<name>" }`                                                             |

A nullable type in the spec is already a union with `null` in forge, so it becomes `anyOf` with `{ "type": "null" }`.

A model that is only a scalar or an enum, or a union or intersection of them, such as an identifier that is a string, is written where it is used: its schema is about as small as the reference. Every other model is a `$ref` into the schema's own `$defs`, so recursive models terminate. Each tool's `$defs` holds only the models its schema reaches, so every tool's schema stands alone. A model's schema is built once, as a constant in the `schemas.ts` or `outputs.ts` of the group forge places it in, and every tool that uses it imports the constant.

The `$defs` key is the model's schema name, with each byte other than an ASCII letter, digit, `_` or `-` written as `.` and two hex digits (`Event$meta` is `Event.24meta`), so it needs no escaping in a JSON Pointer or URI fragment and no two models share one.

Arguments and responses are built separately, because a model differs between them:

|                                      | Arguments (`schemas.ts`)               | Responses (`outputs.ts`)                              |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| Read-only fields                     | left out: a client doesn't send them   | kept: the API returns them                            |
| Descriptions, defaults, `deprecated` | kept, for the model choosing arguments | left out: these schemas check data, nobody reads them |

## Description and annotations

`title` is the method's summary. `description` is the method's description, or its summary, followed by:

- `This method is alpha.` (or `beta`, `in preview`, `deprecated`) when `x-forge-availability` says so;
- `Confirm with the user before calling this tool.` and the sentence from `x-forge-require-confirmation`, when the method has one;
- the method and path, `METHOD /path`, so a model can match the tool to the API's documentation.

Descriptions are trimmed, here and in schemas.

The annotations come from the HTTP method:

|                                                | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ---------------------------------------------- | -------------- | ----------------- | ---------------- |
| `GET`, `HEAD`, `OPTIONS`                       | true           | false             | true             |
| `POST`, `PATCH`                                | false          | false             | false            |
| `PUT`, `DELETE`                                | false          | true              | true             |
| any method with `x-forge-require-confirmation` | false          | true              | as above         |

`openWorldHint` is always true: every tool calls an API. The hints describe the method; they authorize nothing.

## Extensions

`extensions` holds the operation's `x-` extensions that forge doesn't read itself. They are for the server, for example to explain a refused call or to filter tools by permission, and are never listed to clients.

## Response schemas

`responses.schemas` has the schema of every response's JSON body, success or error, by status as the API declares it: a code (`200`), an uppercase range (`4XX`), or `default`. A response without a JSON body is `null`. `responses.$defs` holds the models they reach.

They are for the server to check the API's responses against the spec: pick the status's schema, then its range, then `default`, and validate. A server can use the mismatches to find where the spec is wrong, including the output schemas it lists. They are never listed to clients.

## Output schemas

`outputSchema` is the JSON body schema of the method's successful (`2XX`) responses: the one schema when they agree, or `anyOf` the distinct ones, with `$defs` holding only the models those reach. A method with a successful response that has no JSON body gets none, since some calls would have no structured result.

It is often not an object: a `$ref`, an `allOf`, an array or a scalar. MCP `2026-07-28` allows that; `2025` clients expect an object.

Every tool is listed with its output schema. MCP clients hold a tool to its output schema: a successful result must carry `structuredContent` that matches it, or the SDK's client rejects the call. So a server returns the parsed body as `structuredContent`, through the SDK's `server.projectCallToolResult(result, tool.outputSchema)`, which wraps it as `{ result }` for `2025` clients when the schema isn't an object. A schema that doesn't match the API's responses is a fault in the spec, which the [response schemas](#response-schemas) help find.

## The runtime

`_/tool.ts` is copied into every output. It is small enough to read. `index.ts` exports the two functions below, and none of the runtime's types: the arguments are the SDK's `CallToolRequestParams['arguments']`, and the rest follow from the values, such as `(typeof tools)[number]` for a tool and `ReturnType<typeof operation>` for its operation.

- `operation(tool)` returns the API method the tool calls, as [The request](#the-request) describes it: its `method`, `path`, `query`, `headers`, `body`, `extensions` and `responses`. A tool holds it under `Symbol.for('@cloudflare/forge/mcp/operation')`, the same symbol in every copy of the runtime. `JSON.stringify` leaves a symbol out, so a server answers `tools/list` with the tools as they are, and nothing only the server should see reaches a client. `structuredClone`, which `postMessage` uses, leaves it out too, so a tool copied that way can be listed but not called. The server finds a tool for `tools/call` itself, with a `Map` by name.
- `registerTools(server, tools, { baseUrl, fetch })` registers each tool on an `McpServer`, listed as `tools/list` sends it. It gives the SDK each input schema with the SDK's JSON Schema validator, which the SDK runs on each call's arguments. The output schema is only listed, since a client that takes it checks results itself. Each call builds the request, sends it with `fetch` (the global one by default, or the server's own, to add a credential, retry or observe responses), and returns the body as the result's text, with a successful JSON body as `structuredContent` when the tool has an output schema. A response that isn't 2xx, and arguments the tool can't be called with, are error results. The SDK does the rest, such as wrapping `structuredContent` for `2025` clients.

Everything else is the server's: authenticating the client, the credential its `fetch` adds, and anything it changes about a tool, such as making a parameter optional. It can change a tool by mapping over `tools` before registering or listing them, since a tool is plain data; a spread, such as `{ ...tool, inputSchema }`, keeps the operation. A server that needs more than `registerTools` does, such as filling in arguments from the session or shaping results its own way, writes its own `tools/list` and `tools/call` handlers from the tools and their operations.
