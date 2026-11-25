# `forge openapi overlay`

Applies one or more [OpenAPI Overlay](https://spec.openapis.org/overlay/latest)
documents to an OpenAPI spec and prints the result (or writes it to a file
with `--out`).

```
forge openapi overlay <overlay>                             # Mode A: overlay drives the spec via its `extends`
forge openapi overlay <spec> <overlay>...                   # Mode B
forge openapi overlay <spec> <overlay> --out <path>
```

Pipe the merged spec into `forge generate` to generate from an overlaid
document:

```
forge openapi overlay <overlay> | forge generate - --target <t> --out <dir>
forge openapi overlay <spec> <overlay>... | forge generate - --target <t> --out <dir>
```

Without `--out` the `forge openapi overlay` subcommand prints the overlaid
document to standard output. `--out <path>` writes it to `<path>` instead; if
`<path>` is the same file as the target spec (in either Mode A or Mode B), the
file is rewritten atomically (temp file + rename in the same directory) and
left byte-identical when no action mutated it.

## Supported Overlay versions

Overlay 1.0, 1.1, and 1.2. Behavior is version-dispatched where the spec
differs between versions — notably array handling under `update` (1.0
replaces, 1.1+ concatenates) and primitive `update` targets (1.0 rejects,
1.1+ replaces).

## Security profile

No network access. `$self` and `extends` resolve `file:` URIs under the
overlay's retrieval directory, `urn:` identifiers (name-only; not fetched),
and relative references. Non-local `file:` authorities, `http(s):`, and
other schemes are rejected before any apply runs.

## `$ref` resolution in inserted content

The Overlay specification is silent on how `$ref` strings embedded in an
`update` payload should resolve once the overlay is applied. (`copy` copies
values from the target spec itself, whose relative `$ref`s are already
spec-relative.) forge resolves relative `$ref`s in `update` payloads against
the overlay's retrieval base URI and then re-expresses the result as a path
relative to the spec's retrieval base, so the merged spec is self-contained and
portable (no absolute build-environment paths leak into committed artifacts).
Absolute URIs and pure-fragment references (`#/components/...`) pass through
unchanged.

```yaml
# overlays/x.yaml inserting a $ref relative to itself, applied to
# ./openapi.yaml:
actions:
  - target: $.paths['/a'].get.responses['200'].content['application/json']
    update:
      schema:
        $ref: './schemas/Foo.yaml#/X' # emitted as overlays/schemas/Foo.yaml#/X
```

When a spec-relative expression is impossible — different schemes, Windows
cross-drive, or a target that would walk up more than two `..` segments
and thus be fragile — forge falls back to the resolved absolute `file:`
URI. That fallback preserves correctness at the cost of portability for
the uncommon pathological case.

The Reusable Action Reference (`components.actions.*.$ref`) is an overlay-
internal pointer and is not rebased; it is validated separately as a
same-document JSON Pointer.

## Nodelist uniqueness

RFC 9535 §2.5.1 says a selector like `$['a', 'a']` yields two outputs.
forge dedups selected nodes by JSON Pointer before applying, so each node
is visited at most once — otherwise 1.1 array-concat would append the
update twice and `remove` would try to delete the same index twice.

## Root removal is rejected

`{"target": "$", "remove": true}` is rejected with a clear error naming
the two intended alternatives: use `update` with a wholesale replacement
value, or tighten the target (e.g. `$.servers` instead of `$`). The
Overlay spec is silent on this, but silently replacing the root with an
empty object is overwhelmingly a typoed JSONPath nuking the whole spec
— the resulting empty object is unusable downstream. Matches Redocly.

## Conformance corpora

The normative baselines forge is tested against live in the repo:

- `tests/openapi/overlay/oai_tests/` — the OAI's own pass/fail fixtures across
  versions 1.0, 1.1, and 1.2-dev.
- `tests/openapi/overlay/compliant_sets/` — end-to-end apply scenarios from the
  OAI compliant-sets corpus.
- `tests/openapi/overlay/real_world/` — vendored `(spec, overlay, expected)`
  triples from real-world projects, as byte-stable regression gates.

## Logging

Use the global `--log-level <level>` flag (`error`, `warn`, `info`, `debug`,
`trace`; also configurable via `FORGE_LOG`) to emit diagnostic logs to stderr
without affecting stdout:

- `warn` (default) — warnings such as future `1.x` overlay versions.
- `info` — zero-match no-op actions and per-overlay summaries.
- `debug` — per-action execution details (verb, target, ref name,
  matched/mutated counts) and `extends` resolution.

```
forge openapi overlay spec.yaml fix.yaml --log-level info
forge openapi overlay spec.yaml fix.yaml --log-level debug
```

Log output is for humans and its wording is not a stable format.
