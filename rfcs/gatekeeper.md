# Gatekeeper generator

This document proposes a Forge target, `gatekeeper`, that generates the deterministic parts of a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) gatekeeper from an OpenAPI spec. An agent writes the rest, guided by files the target also generates. Tracked as FORGE-45.

A gatekeeper is a worker that sits between an agent and a provider's API. It gives the agent a small, curated API, sends every read through an observation log, and holds every write until a person approves it. Gatekeepers are built on `@gadgets/gatekeeper-kit`.

The first goal is to rebuild the GitHub gatekeeper this way, as if there had never been one, and to write down what could be generated and what could not.

## What is generated and what is not

Most of a gatekeeper is not in its provider's spec. Which reads a person should see, what an approval says, whether a write can be approved automatically, how a pending write shows up in later reads: these depend on what the API means, and an agent decides them with a person reviewing.

What the spec does describe is the provider's HTTP API, which every gatekeeper wraps in a hand-written client today. That client is what Forge generates.

| Forge generates                                      | An agent writes, with guidance                                |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Types and operation tables for the chosen operations | The agent-facing contract, `types.d.ts`, reviewed by a person |
| A typed client, split into reads and writes          | Session classes, and the helper that authorizes their reads   |
| What each operation is: kind, pagination, route      | The action table: kinds, approval text, auto-approval         |
| A fake provider that records calls, for tests        | Simulation, caching and normalizers                           |
| Tests of the approval rules, over that fake          | What the spec does not cover, such as GraphQL or git          |

The generator stops at the API layer. Wiring the worker, OAuth and deployment stay with the gatekeeper kit and the agent.

## Usage

```sh
forge api.github.com.json --target gatekeeper --config github.gatekeeper.json --out src/api
```

`--config` is required by this target, and no other target takes it.

## The config

The config says which operations the gatekeeper covers, and what the spec does not say about them. It holds facts about the API, not judgements, and a person reviews it before anything is generated. An agent can draft it from a prompt such as "cover issues, pull requests and checks".

```json
{
  "operations": {
    "issues/get": { "group": "issues", "name": "get" },
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
  - `kind` is `read` or `write`. Without it, `GET` and `HEAD` read and every other method writes. It is there for cases such as a search sent with `POST`.
  - `pagination` says how the operation pages. The one `style` so far is `link-header`. `items` names the property that holds the items when the response is not the array itself.
- **`properties`** gives a field name to properties whose wire names do not make one, by wire name. GitHub's `+1` and `-1` are both the name "1" otherwise, which is an error.

Unknown keys are errors, so a typo is not silently ignored.

## How the config is applied

The config is applied to the spec before Forge links it, as a change to the document:

- A listed operation gets `x-forge-group-name` and `x-forge-method-name`, and an `x-gatekeeper` extension with its `operationId`, `kind` and `pagination`.
- Every other operation gets `x-forge-skip: true`.
- Every operation loses its `x-forge-aliases`, since the config is what names methods.
- A listed property gets `x-forge-property-name`, unless it has one.
- A string loses its `date-time` or `date` format.

Doing this before linking means the operations left out, and the models only they use, are never part of the generated code. It also means the target needs nothing new from Forge's model of the API or from the plugin interface: the generator reads `x-gatekeeper` the way any plugin reads an extension.

Dates are strings because the TypeScript SDK otherwise decodes them to `Temporal` values, which Cap'n Web cannot send. A gatekeeper's agent-facing types use strings for dates anyway.

## Output

The target writes the TypeScript SDK of the chosen operations, as the `ts` target does, and `operations.json`:

```json
{
  "operations": [
    {
      "operationId": "issues/list-for-repo",
      "group": ["issues"],
      "name": "list",
      "method": "GET",
      "path": "/repos/{owner}/{repo}/issues",
      "kind": "read",
      "pagination": { "style": "link-header" }
    }
  ]
}
```

`operations.json` is what the rest of the target will be built from, and what an agent reads to see which decisions each operation needs.

For GitHub's spec, which has 1,272 operations, a config of 19 operations generates about 4,400 lines in five groups.

## Status

Implemented:

- The `gatekeeper` target and `--config`.
- Applying the config: selection, naming, property names and string dates.
- The SDK of the chosen operations, and `operations.json`.

Proposed, in the order they would be built:

1. **A client over the kit's transport.** The SDK's own transport takes one token, treats a 304 as an error, and returns only the decoded body. A gatekeeper needs the kit's credential source, conditional requests, response headers, and provider rules such as GitHub's rewrite to `/repositories/<id>`. The generated client would call an interface the gatekeeper implements, and return the body with the status and headers.
2. **Reads and writes as two clients.** Session code gets the client of reads. The client of writes is given only to an action's `apply`, so a session method cannot change anything outside an approved action.
3. **A fake provider that records calls.** It is generated from `operations.json`, and answers the routes of the chosen operations in the kit's worker tests.
4. **Tests of the approval rules**, over the recorder: no write reaches the provider before an action is applied, every session read authorizes an observation with subresources before it returns, and an action that deletes is not approved automatically unless it says why. The agent gives the session methods and example arguments.
5. **Guidance for the agent**: a worksheet of the decisions each operation needs, and the steps of the kit's `write-gatekeeper` skill that the generated files change.

## Decisions

**The approval plumbing is not generated.** It was considered, as a guard around each read and a draft action for each write. Existing gatekeepers show why not. A read is authorized once per session method, after its provider calls, often with subresources taken from the response, and reads that only prepare an action are not logged at all. An action's payload is the agent's type, not the provider's request, several kinds of action share one endpoint, and its tag is permanent once shipped. What Forge can do deterministically is enforce the rules by how the client is split, and check them with tests.

**The contract is not generated.** `types.d.ts` is the API an agent sees and the first thing a person reviews. It is designed above the provider's API, not derived from it. A later step could take an existing contract as an input, to keep a gatekeeper's API when it is regenerated.

**The config is a file of its own, not an OpenAPI overlay.** Forge has no overlay support, and a gatekeeper needs to say less than an overlay can: which operations, their names, and a few facts. A list keyed by `operationId` is small enough to review line by line.

**Generated files are committed and reviewed.** They hold no security logic, but they are what `apply` and the session reads call, and a spec update should show up as a diff a person and an agent can read.

## Open questions

- **Pinning the spec.** The config should name the spec it was written for, by URL and hash, so that an update is deliberate.
- **Properties the SDK leaves out.** The SDK drops a property whose wire name is not a valid name, such as `+1`, even when it is given a field name. It is still in the response, untyped.
- **`Temporal` in the runtime library.** The models no longer use it, but the library's date codecs still name it, so a project needs a TypeScript `lib` that declares it until the client stops using that library.
- **Operations that are not JSON.** The SDK leaves them out, and listing one in the config is an error. GitHub's logs, diffs and `git` endpoints are of this kind, along with what it only offers through GraphQL. They stay hand-written.
- **Path parameters with slashes**, such as a file path or a branch name. The SDK percent-encodes the whole value. Whether each provider accepts that has to be checked against the real API.
- **The kit's assembly layer.** The kit plans base classes for the vendor, user, account and resource objects. Once they exist, the target can generate against them, and the scaffold it needs becomes much smaller.
