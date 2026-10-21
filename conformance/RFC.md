# RFC: A conformance suite for forge targets

## Summary

A conformance suite is an API description and a set of cases for it,
written as data, that any forge target can run to show its generated client
handles every pattern an API description can contain. A standalone runner
executes the cases against a small client the target provides.

## Motivation

If I write a new target plugin, how do I know it covers all the cases?

Today there is no answer short of reading other targets. The suite answers
it: generate a client for the suite API, wrap it in a small program that
speaks the protocol below, and run the runner. Every case that passes is a
pattern the target handles; every case that fails names the one that broke.

The runner is a tool for any target, in this repo or not. A target maintained
elsewhere uses it the same way.

## Overview

```
          cases (YAML)
               |
            runner  <-- HTTP -->  generated client
               |                        ^
               +---- JSON lines ---> target's client program
```

1. The **suite API** is an OpenAPI document that contains every pattern a
   target must handle.
2. The target generates a client from it, and wraps it in a **client
   program**.
3. The **runner** reads the cases, starts the client program, sends it each
   case, serves the HTTP exchange the case expects, and compares the result
   the client program reports.

The runner does not generate or build anything. It is given a command to
start, and knows nothing about the target's language or toolchain.

## The suite API

One OpenAPI document, written for the cases, with a fixed set of 9 methods:

| Method                     | Route                                                       | Covers                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                   | `GET /health`                                               | root method, bearer `token` header, no parameters                                                                                                             |
| `projects.create`          | `POST /orgs/{org_id}/projects`                              | SDK variable (`org_id`), object body, `date-time`, `date`, `int64`, `byte`, 201                                                                               |
| `projects.get`             | `GET /orgs/{org_id}/projects/{project_id}`                  | path parameters, declared errors (404, `4XX`), undeclared status, unknown response properties                                                                 |
| `projects.update`          | `PATCH /orgs/{org_id}/projects/{project_id}`                | path, query (repeated and special-character names) and header parameters with an object body, body property colliding with a parameter name                   |
| `projects.delete`          | `DELETE /orgs/{org_id}/projects/{project_id}`               | 204 response with no body                                                                                                                                     |
| `projects.archive`         | `POST /orgs/{org_id}/projects/{project_id}/archive`         | method and subgroup with the same name                                                                                                                        |
| `projects.archive.restore` | `POST /orgs/{org_id}/projects/{project_id}/archive/restore` | subgroup on a method                                                                                                                                          |
| `projects.members.replace` | `PUT /orgs/{org_id}/projects/{project_id}/members`          | nested group, array body, two success statuses (200 and 201) with different bodies                                                                            |
| `dnsRecords.getById`       | `POST /zones/{zone_id}/dns-records/{record_id}`             | kebab-case group (`dns-records`), camelCase method with acronym (`getByID`), primitives, enums, maps, `nullable`, `allOf`, `oneOf`, `anyOf`, recursive models |

Every method in the suite API has at least one case.

## The shape of a case

A case is one call, the HTTP exchange the server must see, and the result
the caller must get. Cases are YAML files, each a list of cases.

```yaml
- name: an object body is sent in wire names
  variables: { orgId: o1 }
  call:
    group: projects
    method: create
    body: { displayName: Demo }
  exchange:
    expect:
      method: POST
      path: /orgs/o1/projects
      headers: { content-type: application/json }
      body: { display_name: Demo }
    respond:
      status: 201
      body: { id: p1, display_name: Demo }
  result:
    kind: response
    value: { id: p1, displayName: Demo }
```

### Schema

```ts
type Case = {
  name: string; // unique across all case files
  variables?: Record<string, Value>; // SDK variables (x-fern-sdk-variable), set when the client is created
  call: {
    group: string; // property path from the root client, e.g. "projects.members"; "" for root
    method: string; // method name on that group
    path?: Record<string, Value>; // path parameters, by field name
    query?: Record<string, Value>; // query parameters, by field name
    headers?: Record<string, Value>; // header parameters, by field name
    body?: Value; // request body, with object keys in field names
  };
  exchange: Exchange;
  result: Result;
};

type Exchange = {
  expect: {
    method: string;
    path: string; // escaped, without the base URL
    query?: Record<string, string | string[]>; // one key per name; repeated name: array
    headers?: Record<string, string | string[]>; // only listed headers are checked
    body?: Json;
  };
  respond:
    | { status: number; headers?: Record<string, string | string[]>; body?: Json }
    | { status: number; headers?: Record<string, string | string[]>; text: string };
};

type Result =
  | { kind: 'response'; value?: Value } // the method returned; no value when the response has no body
  | { kind: 'api'; status: number; message?: string; details?: Value }; // an error response
```

`exchange` is explicit because the runner does not read the OpenAPI document
or know how a target maps `call` to HTTP: the case pins the exact wire path,
query, headers and body the SDK must send, and the exact status and wire body
the server returns (including error payloads and non-JSON text that cannot be
derived from `call`).

Of an `api` result, only the members the case lists are compared.

### Call inputs

`call` splits inputs into `path`, `query`, `headers` and `body` so a target
can pass each where its generated signature expects: one combined request
object, positional path arguments plus a body, or separate parameter and body
structs. An SDK variable in `variables` is set on the client; if the same
variable also appears in `call.path`, the call's value wins.

### Query and headers

A query parameter or header sent once is a string. One sent several times is
an array, its values in the order sent. Different keys may come in any order.
For example, `?tag=a&limit=10&tag=b` is:

```yaml
query: { tag: [a, b], limit: '10' }
```

Header names are compared without case. A header sent as several lines
matches the same values joined with `, ` on one line, as HTTP treats them
the same.

### Names

The two sides of a case use different names:

| Part                         | Names                                         |
| ---------------------------- | --------------------------------------------- |
| `exchange` (server side)     | wire names, exactly as in the API description |
| `variables`, `call`, `value` | forge field names, in camelCase               |

camelCase is the canonical form, not a requirement on targets. A target whose
language uses another convention converts case names the same way its
generator converts field names, e.g. `displayName` to `display_name`.

### Values

`Value` is JSON plus tagged values for types JSON cannot hold:

| Type        | Written as                                |
| ----------- | ----------------------------------------- |
| `date-time` | `{ "$datetime": "2024-03-01T10:00:00Z" }` |
| `date`      | `{ "$date": "2024-03-01" }`               |
| `int64`     | `{ "$int64": "9007199254740993" }`        |
| `byte`      | `{ "$bytes": "aGVsbG8=" }`                |

Tagged values compare by what they hold, so `2024-03-01T12:00:00+02:00` and
`2024-03-01T10:00:00Z` are the same `$datetime`.

## Implementing a target

A target provides one client program. It reads one case per line on standard
input and writes one result per line on standard output.

Input, the case's client side plus where to send requests:

```json
{
  "id": "an-object-body-is-sent-in-wire-names",
  "baseUrl": "http://127.0.0.1:52100/",
  "token": "conformance-token",
  "variables": { "orgId": "o1" },
  "call": { "group": "projects", "method": "create", "body": { "displayName": "Demo" } }
}
```

Output, with the same id and a `Result`, or `unexpected`:

```json
{ "id": "…", "result": { "kind": "response", "value": { "id": "p1", "displayName": "Demo" } } }
{ "id": "…", "result": { "kind": "api", "status": 404, "message": "…", "details": {} } }
{ "id": "…", "result": { "kind": "unexpected", "message": "…" } }
```

For each line the program:

1. creates a client from `baseUrl`, `token` and `variables`;
2. calls `call.method` on `call.group` with the inputs in `call`;
3. maps the return value or error to a `Result`, converting tagged values to
   and from the language's types.

The program has one handler per method of the suite API, written as a user
of the SDK would call it.

`unexpected` is an error other than an `api` error, a bug in the SDK or the
program, and always fails the case. Results may come in any order. The program
exits when standard input closes.

## The runner

```sh
forge-conformance --cases ./cases --client "node ./client.js"
```

It plays both ends of every case:

- **Server.** A request matches the exchange when the method and escaped path
  are equal, the query and the listed headers have the same values, and the
  body is the same JSON value. The server responds with the exchange's
  `respond` even on a mismatch, so the failure reports what went wrong on the
  wire, not what followed from it.
- **Caller.** It sends each case to the client program and compares the
  result.

A case fails when the request does not match the exchange, when an extra
request arrives, or when none arrives; when the result differs; or when no
result comes within a timeout. A failure shows the case's file, line and
name, and a diff.

### Skipping and expecting failures

```sh
forge-conformance --cases ./cases --client "./client" \
  --skip "an undeclared status keeps its body as text" \
  --skip @./skip.txt \
  --expect-fail ./expected-failures.txt \
  --write-failures ./failures.txt
```

- `--skip <name>` does not run the case. Repeatable. `--skip @<file>` does
  not run the cases in a case list.
- `--expect-fail <file>` is a case list of cases expected to fail. A listed
  case that fails is reported and does not fail the run. A listed case that
  passes, or a name that is no case, fails the run, so the list only shrinks.
- `--write-failures <file>` writes the cases that failed as a case list, so
  it can become the `--expect-fail` file.

A case list is plain text, one case name per line. Blank lines and lines
starting with `#` are ignored; a comment above a name gives the reason:

```
# status ranges are not generated yet
an error declared for a range is decoded
```

`--write-failures` puts each case's first failure in that comment.
