# Gatekeeper generator

This document proposes a Forge target, `gatekeeper`, that generates the deterministic parts of a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) gatekeeper from an OpenAPI spec. An agent writes the rest, guided by files the target also generates. Tracked as FORGE-45.

A gatekeeper is a worker that sits between an agent and a provider's API. It gives the agent a small, curated API, sends every read through an observation log, and holds every write until a person approves it. Gatekeepers are built on `@gadgets/gatekeeper-kit`.

The first goal is to rebuild the GitHub gatekeeper this way, as if there had never been one, and to write down what could be generated and what could not.

## What is generated and what is not

Most of a gatekeeper is not in its provider's spec. Which reads a person should see, what an approval says, whether a write can be approved automatically, how a pending write shows up in later reads: these depend on what the API means, and an agent decides them with a person reviewing.

What the spec does describe is the provider's HTTP API, which every gatekeeper wraps in a hand-written client today. That client is what Forge generates.

| Forge generates                                        | An agent writes, with guidance                                |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Types and operation tables for the chosen operations   | The agent-facing contract, `types.d.ts`, reviewed by a person |
| A typed client, split into reads and writes            | Session classes, and the helper that authorizes their reads   |
| What each operation is: kind, pagination, route        | The action table: kinds, approval text, auto-approval         |
| A guide, and a worksheet of each operation's decisions | Simulation, caching and normalizers                           |
| Proposed: a fake provider that records calls           | The answers to the worksheet                                  |
| Proposed: tests of the approval rules, over that fake  | What the spec does not cover, such as GraphQL or git          |

The generator stops at the API layer. Wiring the worker, OAuth and deployment stay with the gatekeeper kit and the agent.

## Usage

```sh
forge api.github.com.json --target gatekeeper --config github.gatekeeper.json --out src/api
```

`--config` is required by this target, and no other target takes it.

Forge is run twice. The first run is the scout, which reads the document and generates nothing:

```sh
forge api.github.com.json --target gatekeeper --scout --out scout
```

It needs no config, and takes one if there is one. See [The scout](#the-scout). Forge does not fetch the document in either run: the agent downloads it and pins it.

## The scout

The config holds facts about the API, and somebody has to find them. Building a gatekeeper for Sentry with no scout showed how that goes: the agent read a document of several megabytes to choose operations, guessed how they page, and found out what the document does not say only when its code met it. The scout does the reading, and says what is left to ask.

It reads the document as JSON and does not link it, so it works on a document Forge cannot generate from yet, and it says why not. It writes two files, `CATALOG.md` for the agent and `catalog.json` with the same facts:

- **The API**: its title and version, its servers with their variables, and its security schemes with their flows and scopes.
- **What will limit the clients**: a document that is not OpenAPI 3, one with no shared schemas, whose types are written in place, and `$ref`s Forge does not follow.
- **Every operation**: its `operationId`, method, path, tags and summary, whether it reads or writes, its parameters by where they go, the scopes it asks for, its success and error statuses, and whether it can be generated. A `POST` whose name or summary reads like a search is marked as a candidate for a read.
- **How each operation pages**, with its basis. `declared` is for a `Link` header the document declares on the response. `guessed` is for the rest, from the names of parameters and of properties of the response, and the evidence is listed. A guess is checked against the provider's documentation before the config says it.
- **What a response gives no type to rely on**: parts with no type, objects none of whose fields are required, and path parameters with a closed set of values.

Then it lists **questions**: what the document leaves open and a person has to answer. They are not a fixed list. Each is asked only when the document gives cause:

| Asked when                                                    | Question                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| There are several servers, or one with variables              | Which server a connection uses, and what chooses it                        |
| There are several security schemes, or an OAuth flow, or none | How a connection authenticates, and with which scopes                      |
| No operation looks like "who am I"                            | What identifies the account of a credential                                |
| No response declares a rate-limit header                      | How the API says a caller is limited                                       |
| Always                                                        | What a rejected credential looks like, and whether a 404 can hide a denial |

With a config, it asks about the operations of the config too: which path parameters a connection is bound to, how a listing pages when nothing could be guessed, whether a `POST` that looks like a read is one, what a path parameter with a closed set of values is, and what the last page of a `link-header` listing looks like. A question the config answers is not asked.

The agent drafts the config from the catalog, asks the person the questions, and writes the answers into the config where it has a key for them. The rest are answered in the worksheet, which repeats them.

## The config

The config says which operations the gatekeeper covers, and what the spec does not say about them. It holds facts about the API, not judgements, and a person reviews it before anything is generated. An agent can draft it from a prompt such as "cover issues, pull requests and checks".

```json
{
  "operations": {
    "issues/get": { "group": "issues", "name": "get", "conditional": true },
    "issues/list-for-repo": {
      "group": "issues",
      "name": "list",
      "pagination": { "style": "link-header" }
    },
    "actions/list-workflow-runs-for-repo": {
      "group": "actions",
      "name": "listWorkflowRuns",
      "pagination": { "style": "link-header", "items": "workflow_runs" }
    },
    "search/issues-and-pull-requests": { "group": "search", "name": "issues", "kind": "read" }
  },
  "properties": { "+1": "plus_one", "-1": "minus_one" }
}
```

- **`operations`** is keyed by `operationId`. An operation that is not listed is not generated. An `operationId` the spec does not have is an error.
  - `name` is the method name, and `group` is its group path, with dots between group names. Without `group`, the method is in the root.
  - `kind` is `read` or `write`. Without it, `GET` and `HEAD` read and every other method writes. It is there for a search or a query sent with `POST`, which is the one other method that can be a read: the code of a session has every read, and may send one twice.
  - `conditional` says that a request can ask for the response only if it has changed, with `If-None-Match` or `If-Modified-Since`. Its method returns a 304 response, which is otherwise thrown. An operation that writes cannot be conditional.
  - `pagination` says how the operation pages, and only a read can page. `items` names the property that holds the items when the response is not the array itself, and a response of the operation must have that array. The `style` is one of:
    - `link-header`: the next page is the `rel="next"` URL of the `Link` header.
    - `offset`: a request says how many items to leave out. `offset` and `limit` name the parameters, which are `offset` and `limit` without them.
    - `cursor`: a request has the cursor that the response before it gave. `cursor` names the parameter, which can be a property of the body, and `next` names the property of the response, which can be a path such as `response_metadata.next_cursor`. `limit` names the parameter for the size of a page, if there is one.

    For `offset` and `cursor`, `more` names the property of the response that is true when there is another page, or `last` the one that is true when the page is the last. The operation must have everything its pagination names. Where the document gives a response no type, a property is taken to be there.

    For `link-header`, `more` names a parameter of the `rel="next"` link, not a property: the one that is `true` when there is another page. Sentry sends the link with every page, as `<url>; rel="next"; results="false"` with the last.

  - `parameters` gives a parameter of the operation a schema, by name, in place of the document's. It is for a document that is wrong: Sentry's declares the id of an event as one of two words, where it is any id. A name the operation does not have is an error.
  - `omitParameters` lists parameters of the operation to leave out, by name.
  - `failure` says what marks a 2XX response of the operation as a failure, in place of the config's.
- **`properties`** gives a name to properties whose wire names do not make one, by wire name. GitHub's `+1` and `-1` are both the name "1" otherwise, which is an error when the document is read. The name only tells them apart: the generated field keeps the wire name.

- **`omitParameters`** lists parameters to leave out of every operation that has them, by name. It is for a parameter that takes a credential, as Slack's `token` does: the provider has the credentials, and a request type should have no field for one. A path parameter cannot be left out, and a name that no operation has is an error.
- **`failure`** says what marks a 2XX response as a failure, for an API that answers one with a 2XX: `{ "property": "ok", "equals": false }` for Slack. Such a response is thrown like one whose status is not 2XX.
- **`bound`** lists the path parameters a connection is bound to, by name, such as Sentry's `organization_id_or_slug`. A session passes those itself and never takes them from a caller. The clients do not change: `operations.json` and the worksheet list them for each operation. A name that no operation of the config has is an error.
- **`int64`** is `"number"` to make an `int64` a `number` in the generated types, and not a `bigint`. It is for an API whose `int64`s are counts and positions, as Jira's `startAt` is.

Unknown keys are errors, so a typo is not silently ignored.

## How the config is applied

The config is applied to the spec before Forge links it, as a change to the document:

- A listed operation gets `x-forge-group-name` and `x-forge-method-name`, and an `x-gatekeeper` extension with its `operationId`, `kind`, `conditional`, `pagination`, `failure` and `bound`, and the header parameters it declares.
- Every other operation gets `x-forge-skip: true`, and a listed one loses it.
- That covers the path items under `components.pathItems`, which a path can refer to.
- Every operation loses its `x-forge-aliases`, since the config is what names methods.
- A listed property gets `x-forge-property-name`, unless it has one.
- A string loses its `date-time` or `date` format, and so does a string that can be null. An integer loses its `int64` format when the config says so.
- The parameters of a path item are given to each of its operations, and an operation loses those the config leaves out. A parameter the config gives a schema gets it.

Doing this before linking means the operations left out, and the models only they use, are never part of the generated code. It also means the target needs nothing new from Forge's model of the API or from the plugin interface: the generator reads `x-gatekeeper` the way any plugin reads an extension.

Dates are strings because the TypeScript SDK otherwise decodes them to `Temporal` values, which Cap'n Web cannot send. A gatekeeper's agent-facing types use strings for dates anyway.

## Output

The target writes TypeScript clients for the chosen operations, a pager for each one that pages, `operations.json`, and two files for the agent that writes the rest: `GUIDE.md` and `WORKSHEET.md`.

### The clients

The clients have the types, the operation tables and the layout of the `ts` target's SDK, with another transport. They do not send requests themselves. They hand each one to a provider, which the gatekeeper implements:

```ts
import type { Provider } from './api/index.js';
import { createReadClient } from './api/read.js';
import { createWriteClient } from './api/write.js';

// One provider for each use of the credentials, with the token it was given.
function provider(token: string): Provider {
  return {
    async send(request) {
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${token}`);
      const url = new URL(`https://api.github.com${request.path}`);
      url.search = request.query.toString();
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
      // A gatekeeper limits the size of the body here.
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
  };
}

const reads = createReadClient({ provider: provider(token) });
const issue = await reads.issues.get({ owner, repo, issueNumber: 1 });
if (!issue.notModified) {
  issue.data; // the decoded body
  issue.status; // 200
  issue.headers.get('etag');
}

const writes = createWriteClient({ provider: provider(token) });
await writes.issues.update({ owner, repo, issueNumber: 1, title: 'New title' });
```

Every group has two clients. The client of reads has the operations whose `kind` is `read`, and the client of writes has the rest. Neither has the methods of the other, as types or as values, and a client gives no way to its transport or its provider.

Each is created from a file of its own, `read.ts` and `write.ts`. A gatekeeper's session code imports the first, and only the module with the apply handlers imports the second. That is a convention the generated files make checkable, by a lint rule on imports or in review, and not a guarantee: code that has a provider and imports `write.ts` can write. The tests of the approval rules, below, are what would check the behaviour.

The provider owns what the spec does not describe and what differs between gatekeepers: the URL of the API, the credentials and what happens when they are rejected, redirects, timeouts, and limits on the size of a body. The clients never see a token. A provider returns the status, the headers and the body as text, not a `Response`, so that it is the one place a body is read, and a fake provider in a test is three fields. The gatekeeper kit can then have one function that sends a request this way, with a provider as a thin adapter over it.

A request has the `operationId` and the `kind` of its operation, its `method`, its `path`, its `query`, and its `headers` and `body`. The path and the query are apart, so a provider changes one without parsing the other. A request also has the `route` of its operation, such as `/repos/{owner}/{repo}/issues/{issueNumber}`, and the values of its path parameters before they are encoded. A provider that rewrites paths, as GitHub's does to address a repository by its id, can do so from those, and not by matching the encoded path. With the `kind` and the `method`, a provider can refuse a write that does not come from an applied action.

A path parameter that is `.` or `..` is refused before anything is sent. It is the one value percent-encoding leaves as it is, and a URL resolves it away with the segment before it, so the request would be another operation's than the one its `operationId` names.

A call can add query parameters the spec does not declare, in its options. One replaces the parameter of the request that has its name.

The clients keep every property and query parameter that has a name. The `ts` target leaves out one whose wire name has a character other than a letter, a digit, `-` or `_`, such as `name.exact` or `+1`, and lets it be sent untyped. A gatekeeper covers few operations and is written against all of what they take and return, so its clients have `"name.exact"` and `"+1"`.

A query parameter whose name ends in `[]` is a list, even where the document gives it the schema of one value, as PagerDuty's does for `statuses[]` and `include[]`. The clients set no header but `content-type` for a body: the provider sets `accept`, since an API can take a version in it.

The fields have the provider's names. The `ts` target names a field in camel case and renames it as it encodes and decodes. The clients of a provider do not: a request has `team_ids[]` and a response has `created_at`, as the provider documents them. With dates as strings and an `int64` as a number, nothing in a body is converted, so the models have no codecs and a body is what `JSON.parse` returns.

A method returns the decoded body with the status and the headers of the response, so that a gatekeeper can read an `ETag` or a `Link` header. The method of a conditional operation returns a 304 as a result whose `notModified` is true, with the headers and no body, and the gatekeeper answers from its own cache. Caching itself is not generated: among today's gatekeepers only GitHub's revalidates.

A response whose status is not 2XX is thrown. By default the error is an `ApiError`, with the `operationId`, the status, the headers and the body as `details`, parsed when it is JSON and as text when it is not. Its message is the status and at most the first 200 characters of the message the API sent, and it does not hold the `Response`. The kit tells errors apart by a numeric `status`, which this has, so the runtime does not import the kit.

A gatekeeper that has an error class of its own gives the clients an `error` function, which gets the same facts and returns what to throw:

```ts
const reads = createReadClient({
  provider: provider(token),
  error: (failure) => new GitHubApiError(failure.operationId, failure.status),
});
```

When the config says what marks a 2XX response as a failure, such a response is thrown the same way. The error has its 2XX status and `source: 'body'`, so that code which tells failures apart by status sees that it has to read the body.

A 2XX response whose body is not JSON, or is empty where the operation has one, is thrown as a `DecodeError`. It has no `status`, so nothing reads it as an answer of the API, and it has neither the body nor the parser's error, which quotes it. The clients do not validate a body against its type: JSON with other fields is returned as it is. A write is the exception for an empty body: a 2XX says that the change was made, and an error would let it be taken for one that may not have been. Its `data` is `undefined`, which the return type of a write says.

### pages.ts

Every gatekeeper wrote by hand how to find the items of a page and how to ask for the next one, and those that page by a `Link` header each wrote a parser of it. `pages.ts` has that for every operation that pages, as one line that gives a pager of the runtime the types of the operation and what its pagination names:

```ts
export const issuesList = linkPages<IssuesListRequest, IssuesListResponse, ''>({ more: 'results' });
export const incidentsList = offsetPages<IncidentsListRequest, IncidentsListResponse, 'incidents'>({
  items: 'incidents',
  offset: 'offset',
  limit: 'limit',
  more: 'more',
});
```

A pager has two functions. `page(result, request)` returns the items, with their type, and `next`, which names the page after it and is undefined for the last. `resume(request, next)` returns the request and the options that get that page. `next` is JSON, so that it fits in one of the kit's cursors: the query of the `rel="next"` link, an offset, or the provider's cursor.

```ts
const { request, options } = pages.issuesList.resume(first, next);
const result = await reads.issues.list(request, options);
const page = pages.issuesList.page(result, request);
```

A pager does not call the client, so the session method still decides when a page is read and authorizes it. It does not loop, and it does not check a `next` that a caller gives back: the guide says to seal it or check it. The file is written only when an operation pages.

### operations.json

```json
{
  "api": {
    "servers": [{ "url": "https://api.github.com" }],
    "security": []
  },
  "operations": [
    {
      "operationId": "issues/list-for-repo",
      "group": ["issues"],
      "name": "list",
      "method": "GET",
      "path": "/repos/{owner}/{repo}/issues",
      "kind": "read",
      "pagination": { "style": "link-header" },
      "bound": ["owner", "repo"],
      "errors": [
        { "status": "404", "body": "json" },
        { "status": "422", "body": "json" }
      ]
    }
  ]
}
```

`operations.json` is what the rest of the target will be built from, and what an agent reads to see which decisions each operation needs. A `pagination` has the names the config gave, which are those of the generated fields. An operation whose response the document gives no type is marked `untyped`, and one whose body can say it failed has the `failure` property.

The scout's facts about the chosen operations are here too, so that the agent does not go back to the document for them: the servers and security schemes of the API under `api`, and for each operation the path parameters the binding fixes (`bound`), what it asks of a credential (`security`), the errors it declares (`errors`), and what of its response has no type to rely on (`trust`). A key with nothing to say is left out.

An operation that declares header parameters has them in `headers`, each with its `name`, whether it is `required` and its `default`. Forge's model of an API has no header parameters, so a request type has no field for one and the clients do not send it. `Content-Type` and `Authorization` are left out, as OpenAPI says to. `Accept` is kept, since an API can ask for a media type of its own in it, as PagerDuty does for its version. The worksheet asks, for each, whether the provider sets it or each call does.

### The guide and the worksheet

`GUIDE.md` is the same for every gatekeeper. It does not repeat the kit's `write-gatekeeper` skill. It says what the generated files change in the skill's steps: the operations are already chosen, there is no API helper to write, and the contract is still designed by hand and reviewed before anything is implemented. It then gives the rules the clients cannot enforce by themselves:

- How to write a provider, and that it is made for each use of a credential.
- That the `error` function classifies a failure and keeps what the provider sent out of errors an agent reads, and that only a definite denial means an observer has no access.
- That a session passes what its binding fixes, and never takes it from a caller.
- That generated types stay out of `types.d.ts` and out of action payloads.
- That an observation is authorized once for each session method, not for each call of a client.
- That the client of writes is created only in an apply handler.
- How to revalidate a conditional operation, how to page by a `Link` header or by an offset, and where a declared header is set.

It ends by asking the agent to keep a `GAPS.md` of what it had to work around, which is the gap write-up FORGE-45 asks for.

`WORKSHEET.md` has the decisions the spec cannot make. It starts with the scout's questions about the provider. It then asks the questions every read has once, then lists the operations that read, each with a line for the answers that are its own and the questions only it has. The operations that write follow in the same way. An observation is authorized once for each session method, not for each operation, so most answers are shared, and the worksheet has a place for those.

```md
## Reads

For every read:

1. Request fields the binding fixes, and those a caller gives, with how each of those is checked.
2. Session methods that return its data. Or that it only prepares an action, and is not an observation.
3. Subresources each of those methods reports.
4. How `verifyObserverAccess` checks each kind of those for an observer, or that the data is private-only.
5. Whether the observation sets `containsRestrictedData` or `ownerInvitesOnly`.
6. Statuses and bodies that mean no access, and those that are indeterminate and are thrown again.
7. Cache: a TTL or none, and what the cache is partitioned by.

### Shared answers

### `reads.actions.listWorkflowRuns`

`actions/list-workflow-runs-for-repo`: `GET /repos/{owner}/{repo}/actions/runs`

List workflow runs for a repository

- Answers, by number, that are not among the shared ones:
- Paging: it pages by `link-header`: the items are in `data.workflowRuns`. The kit cursor that wraps it, and what each page reports:
```

Every write is asked for the session methods that stage it, its action definitions and their kinds, the `autoApprovable` verdict with the rule of the skill's opt-out policy, what the approver sees, how pending reads show it, what a retry does, and its revert. An operation has a line of its own when it is conditional, pages, is a read sent with `POST`, is sent with `DELETE`, has a response with no type, can fail in its body, or declares headers, and one for the parts of its response the scout found no type for.

The agent copies the worksheet next to `types.d.ts` and fills it in there, since the generated copy is replaced on every run. A person reviews it with the contract.

For GitHub's spec, which has 1,272 operations, a config of 19 operations generates about 4,400 lines in five groups.

## Status

Implemented:

- The `gatekeeper` target and `--config`.
- Applying the config: selection, naming, property names and string dates.
- The clients of the chosen operations, which send through a provider and return the status and headers of a response, and `operations.json`.
- A client of reads and a client of writes for every group.
- The provider interface: a response as status, headers and text, the operation and the split path and query on a request, conditional operations, the error function, and `DecodeError`.
- `GUIDE.md` and `WORKSHEET.md`.
- The scout, its catalog and its questions, and its facts in `operations.json` and the worksheet.
- `bound`, a schema for a parameter, and the last page of a `link-header` listing, in the config.
- `pages.ts`, with a pager for every operation that pages, and a parser of the `Link` header.

Two gatekeepers were built by an agent on these files in Cloudflare OS, to show what they lack: a port of the PagerDuty one, and a new one for Sentry. The scout and the three config keys come from the second.

Proposed, in the order they would be built:

1. **A fake provider that records calls.** It is generated from `operations.json`, and answers the routes of the chosen operations in the kit's worker tests.
1. **Tests of the approval rules**, over the recorder: no write reaches the provider before an action is applied, every session read authorizes an observation with subresources before it returns, and an action that deletes is not approved automatically unless it says why. The agent gives the session methods and example arguments.

## Decisions

**The approval plumbing is not generated.** It was considered, as a guard around each read and a draft action for each write. Existing gatekeepers show why not. A read is authorized once per session method, after its provider calls, often with subresources taken from the response, and reads that only prepare an action are not logged at all. An action's payload is the agent's type, not the provider's request, several kinds of action share one endpoint, and its tag is permanent once shipped. What Forge can do deterministically is enforce the rules by how the client is split, and check them with tests.

**The fields keep the provider's names.** The first clients renamed fields to camel case, as the SDK does. Porting the PagerDuty gatekeeper to them showed what that costs. Its normalizers, its simulation, its caches and its test fake are written against the provider's names, and a webhook delivers the same objects under them, so a file was needed only to map the names back. A property the document does not declare where it appears cannot be renamed, so one object arrived with names of both kinds, and a later document that declares it would change its key with no compile error.

**The scout asks; it does not sample.** It was considered to have Forge call the API with a credential and see how it answers: what a denial looks like, how the last page is marked. That would settle most of the questions without a person. It needs a credential and network access in a code generator, the answers depend on the account, and a call that looks like a read may not be one. The scout reads only the document, and the questions go to a person.

**The contract is not generated.** `types.d.ts` is the API an agent sees and the first thing a person reviews. It is designed above the provider's API, not derived from it. A later step could take an existing contract as an input, to keep a gatekeeper's API when it is regenerated.

**The config is a file of its own, not an OpenAPI overlay.** Forge has no overlay support, and a gatekeeper needs to say less than an overlay can: which operations, their names, and a few facts. A list keyed by `operationId` is small enough to review line by line.

**Generated files are committed and reviewed.** They hold no security logic, but they are what `apply` and the session reads call, and a spec update should show up as a diff a person and an agent can read.

## Open questions

- **Pinning the spec.** The config should name the spec it was written for, by URL and hash, so that an update is deliberate.
- **Parameters whose names collide.** The config names properties, not parameters. Two parameters of one operation with the same name, such as `account_id` and `accountId`, are an error until the config can name them.
- **`Temporal` in the runtime library.** The models no longer use it, but the date codecs the clients share with the SDK still name it, so a project needs a TypeScript `lib` that declares it.
- **The transport is a copy.** The clients' transport builds paths and bodies and reads error messages as the SDK's does, in code of its own. The two should share that code once the provider interface has settled.
- **Sending a request, in the kit.** Every gatekeeper writes its own `fetch` wrapper today. One function in the kit that returns the status, the headers and the capped text, with hooks for the URL, redirects and headers, would make a provider a few lines.
- **`$ref`s into `paths`.** Forge follows a `$ref` to a schema in `components.schemas`, and to the schema of a parameter, a request body or a response in `components`, such as `#/components/responses/Conflict/content/application~1json/schema`, which PagerDuty's document has on every operation. It does not follow one into `paths`. PagerDuty's document has two schemas with one, which no operation tried so far uses. This is a limit of Forge, not of this target.
- **Other ways to page.** A page number cannot be declared yet.
- **Swagger 2.0.** Forge does not read it. Slack's document is one, and was tried from a conversion.
- **Documents that say little.** Jira's issue fields and most of Notion's responses have no type. The clients return them as they are, and the worksheet says so, but the types help little there.
- **Paging by `Link`.** GitHub's `next` link carries a cursor the spec does not declare, next to the page number. A cursor should follow the link, not count pages, which needs a way to send a request to a URL the provider gave.
- **Operations that are not JSON.** The SDK leaves them out, and listing one in the config is an error. GitHub's logs, diffs and `git` endpoints are of this kind, along with what it only offers through GraphQL. They stay hand-written.
- **Path parameters with slashes**, such as a file path or a branch name. The SDK percent-encodes the whole value. Whether each provider accepts that has to be checked against the real API.
- **A method and a group with one name.** The printers the clients share with the SDK give them one property, and its type does not compile. The config makes that easy to write.
- **A filled worksheet as an input.** The worksheet is prose today. If its answers settle into a shape, such as an action's name, kind and verdict, they could move into the config and be checked.
- **The kit's assembly layer.** The kit plans base classes for the vendor, user, account and resource objects. Once they exist, the target can generate against them, and the scaffold it needs becomes much smaller.
