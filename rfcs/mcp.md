# The MCP target

`forge openapi.json --target mcp --out server` generates an MCP server in TypeScript: one tool for each API method, with the code that turns a tool call into the method's HTTP request. This document says how forge maps the API onto MCP, what it generates, and what a server built on it does. It describes the generator as it is.

The server targets the official MCP TypeScript SDK, `@modelcontextprotocol/server`, and the `2026-07-28` revision of the protocol, which also serves `2025` clients.

## Contents

- [What it generates](#what-it-generates)
- [Which methods get a tool](#which-methods-get-a-tool)
- [Names](#names)
- [Arguments](#arguments)
- [The request](#the-request)
- [Schemas](#schemas)
- [Description and annotations](#description-and-annotations)
- [Extensions](#extensions)
- [Response schemas](#response-schemas)
- [Output schemas](#output-schemas)
- [The runtime](#the-runtime)
- [What clients see](#what-clients-see)

## What it generates

```text
server/
  index.ts          every tool, the API's base URL and version, and the runtime's tool half
  README.md         the number of tools, and each method without one and why
  _/                the runtime library, copied in as it is
    tool.ts         the Tool type, building requests, listing tools; no imports at runtime
    server.ts       serving tools on an McpServer, calling them, an HTTP handler
    index.ts        both
  <group>/tools.ts  the tools of a group's methods
  <group>/schemas.ts  the schema of each model used in arguments, placed in its group
  <group>/outputs.ts  the schema of each model used in responses
```

Each `tools.ts` exports `tools`, an array of the group's tools sorted by name, and `index.ts` concatenates them. A tool is plain data plus one function:

```ts
{
  name: 'dns_records_create',
  title: 'Create DNS Record',
  description: '…',
  inputSchema: { type: 'object', properties: { … }, required: [ … ], $defs: { … } },
  annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
  method: 'POST',
  path: '/zones/{zone_id}/dns_records',
  extensions: { 'x-api-token-group': [ … ] },
  responses: { schemas: { '200': { … }, '4XX': { … } }, $defs: { … } },
  outputSchema: { … , $defs: { … } },
  request: (args) => ({ path: `/zones/${pathParam(args, 'zone_id')}/dns_records`, body: { value: args['body'], mediaType: 'application/json' } }),
}
```

`index.ts` re-exports only `_/tool.ts`, which imports nothing at runtime. A server can load the tools without the MCP SDK, for example in a process that only plans requests, and import `_/server.ts` where it serves them.

## Which methods get a tool

Every method forge reads gets a tool, except:

| Method                                                                                                               | Why                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Deprecated (`deprecated: true`)                                                                                      | Left out silently.                                                                                          |
| A required request body with no JSON media type (`multipart/form-data`, `application/octet-stream`, `text/plain`, …) | A tool's arguments are JSON. An optional non-JSON body is left off the tool, and the method still gets one. |
| A tool name over 128 characters                                                                                      | MCP's limit.                                                                                                |
| A tool name another method already has                                                                               | Names must be unique across the server; the first method keeps it.                                          |
| Two arguments with the same name, even after [prefixing](#arguments)                                                 | The tool can't take both.                                                                                   |
| A path parameter with no argument                                                                                    | The tool couldn't fill the path.                                                                            |

Each of these except deprecation is listed in `README.md` with the method, path and reason, so a change to the spec that loses a tool shows in review. Operations forge itself doesn't read, such as those with `x-fern-ignore`, never reach the generator. Hidden methods (`x-forge-hidden`) get a tool.

## Names

A tool is named after its groups and its method, each in snake_case, joined by `_`:

| Group              | Method   | Tool                    |
| ------------------ | -------- | ----------------------- |
| `dns.records`      | `create` | `dns_records_create`    |
| `accounts.members` | `list`   | `accounts_members_list` |

The name comes from `x-fern-sdk-group-name` and `x-fern-sdk-method-name`, as for every target, so it is stable while those are. Renaming a group renames its tools.

## Arguments

`inputSchema` is always an object. Its properties are:

- **Path parameters**, named after the parameter in snake_case, always required.
- **Query parameters**, likewise, required if the spec says so.
- **Header parameters**, likewise. Read-only headers are left out.
- **The JSON body**, as one argument named `body` that takes the body as the API does, with the body's description. If a parameter is already called `body`, it is `request_body`. It is required if the body is.

A parameter whose snake_case name is empty takes its wire name. When two parameters in different places would share a name, the later one gets its place in front: `query_name`, `header_name`.

## The request

`request(args)` returns the request relative to the API's base URL:

- `path`: the template with each parameter substituted. `pathParam` percent-encodes it and throws `InvalidArguments` if it is missing or empty.
- `query`: each parameter's wire name, value and whether it is exploded.
- `headers`: each header's wire name and value.
- `body`: the value and its media type.

`buildRequest(tool, args, baseUrl)` turns that into a `Request`. It checks the required arguments are present, then:

- serializes query parameters in OpenAPI's default `form` style (`a=1&a=2` exploded, `a=1,2` not; objects as `k=v` pairs or `name=k,v`);
- joins an array header with `,`;
- leaves out every query parameter and header that is `undefined` or `null`;
- sends `Accept: application/json`, and the body as JSON with its media type.

It doesn't validate values against the schema. The API does that, and its error says more than ours would.

## Schemas

Schemas are JSON Schema 2020-12, built from forge's model of the spec rather than copied from the OpenAPI document, so every target agrees on what a type is.

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

Models are `$ref`s into the schema's own `$defs`, so recursive models terminate, and each tool's `$defs` holds only the models its schema reaches, so every tool's schema stands alone. A model's schema is built once, as a constant in its group's `schemas.ts` or `outputs.ts`, and every tool that uses it refers to the constant. The `$defs` key is the model's schema name with characters that a JSON Pointer or URI fragment would need escaped replaced by `_`, and a number added if two models would share one.

Arguments and responses are built separately, because a model differs between them:

|                                      | Arguments (`schemas.ts`)               | Responses (`outputs.ts`)                              |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| Read-only fields                     | left out: a client doesn't send them   | kept: the API returns them                            |
| Descriptions, defaults, `deprecated` | kept, for the model choosing arguments | left out: these schemas check data, nobody reads them |

## Description and annotations

`title` is the method's summary. `description` is the method's description, or its summary, or `METHOD /path`, followed by:

- `This method is alpha.` (or `beta`, `in preview`, `deprecated`) when `x-fern-availability` says so;
- `Confirm with the user before calling this tool.` and the sentence from `x-forge-require-confirmation`, when the method has one.

The annotations come from the HTTP method:

|                                                | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ---------------------------------------------- | -------------- | ----------------- | ---------------- |
| `GET`, `HEAD`, `OPTIONS`                       | true           | false             | true             |
| `POST`, `PATCH`                                | false          | false             | false            |
| `PUT`, `DELETE`                                | false          | true              | true             |
| any method with `x-forge-require-confirmation` | false          | true              | as above         |

`openWorldHint` is always true: every tool calls an API. The hints describe the method; they authorize nothing.

## Extensions

`extensions` holds the operation's `x-` extensions that forge doesn't read itself, as forge's `Method::extensions` returns them, such as `x-api-token-group`. They are for the server, for example to explain a refused call or to filter tools by permission, and are never listed to clients.

## Response schemas

`responses.schemas` has the schema of every response's JSON body, success or error, by status as the API declares it: a code (`200`), an uppercase range (`4XX`), or `default`. A response without a JSON body is `null`. `responses.$defs` holds the models they reach.

They are for the server to check what the API returns against what the spec says: pick the status's schema, then its range, then `default`, and validate. A server can use the mismatches to find where the spec is wrong before it promises clients an output schema. They are never listed to clients.

## Output schemas

`outputSchema` is the JSON body schema of the method's successful (`2XX`) responses: the one schema when they agree, or `anyOf` the distinct ones, with `$defs` holding only the models those reach. A method with a successful response that has no JSON body gets none, since some calls would have no structured result.

It is often not an object: a `$ref`, an `allOf`, an array or a scalar. MCP `2026-07-28` allows that; `2025` clients expect an object.

`listTools` leaves output schemas out unless called with `{ outputSchema: true }`, and `serveTools` and `callTool` never send them or `structuredContent`. A server that wants them lists them for `2026-07-28` requests and returns the parsed body as `structuredContent` itself. Until the spec's response schemas match what the API returns, an output schema can make a strict client reject a correct result, so serving them is the server's choice.

## The runtime

`_/` is copied into every server. It is small enough to read:

- `listTools(tools, { outputSchema })` returns the tools as `tools/list` sends them, without `request`, `method`, `path`, `extensions` and `responses`, and without `outputSchema` unless asked. The listing is built once per array of tools.
- `toolsByName(tools)` indexes them, once per array.
- `buildRequest(tool, args, baseUrl)` is described in [The request](#the-request).
- `serveTools(server, tools, call, extra)` serves the tools on an `McpServer` with one `tools/list` and one `tools/call` handler, rather than registering each tool, which for thousands of tools costs more than the request. It declares `tools.listChanged: false`. `extra` lists tools the server serves itself, first.
- `callTool(tool, args, context)` builds the request, adds the context's headers (such as `Authorization`), sends it, and returns the body as text: JSON pretty-printed, text as it is, anything else as a sentence giving its size and type. A non-2xx response is a result with `isError: true`, starting with the status, so the model reads what the API said. An `InvalidArguments` is an error result too.
- `createHandler(options)` returns a `fetch` that serves the tools over Streamable HTTP, with a fresh stateless server for each request. `authorize(request)` returns the headers the API requests send, or a `Response` that refuses the request.

Servers with their own policy, such as making a parameter optional or filling it from the session, build on `listTools`, `toolsByName` and `buildRequest` and leave the rest.

## What clients see

| Field                                                        | `tools/list` | Server only |
| ------------------------------------------------------------ | ------------ | ----------- |
| `name`, `title`, `description`, `inputSchema`, `annotations` | ✓            |             |
| `outputSchema`                                               | when asked   |             |
| `method`, `path`, `request`                                  |              | ✓           |
| `extensions`                                                 |              | ✓           |
| `responses`                                                  |              | ✓           |
