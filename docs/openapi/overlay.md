# `forge openapi overlay`

Applies one or more [OpenAPI Overlay](https://spec.openapis.org/overlay/latest)
documents to an OpenAPI spec and prints the result (or writes it to a file
with `--out`).

```
forge openapi overlay <overlay>                             # Mode A: overlay drives the spec via its `extends`
forge openapi overlay <spec> --overlay <overlay>...         # Mode B
forge openapi overlay <spec> --overlay <overlay> --out <path>
```

With `forge generate`, overlays are a preprocessing step before SDK generation,
not a separate print mode:

```
forge generate <spec> --overlay <overlay>... --target <t> --out <dir>
forge generate <overlay-with-extends> [--overlay <ov>]... --target <t> --out <dir>
```

Use `forge openapi overlay` when you want to inspect or write the merged spec
itself; use `forge generate` when you want an SDK built from a preprocessed
spec.

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
update twice and `remove` would try to delete the same index twice. The
`matched` count reported by `--explain` is the deduped count.

## Root removal is rejected

`{"target": "$", "remove": true}` is rejected with a clear error naming
the two intended alternatives: use `update` with a wholesale replacement
value, or tighten the target (e.g. `$.servers` instead of `$`). The
Overlay spec is silent on this, but silently replacing the root with an
empty object is overwhelmingly a typoed JSONPath nuking the whole spec
— the resulting empty object is unusable downstream. Matches Redocly.

## Strictness choices adopters trip on

Two cases where forge is stricter than some other overlay tools. The behavior
is intentional and tracks the spec; the fixes are small overlay edits.

- **RFC 9535 JSONPath.** The Overlay spec (all three versions) references
  RFC 9535 for `target`. Legacy Goessner constructs that are not valid RFC 9535
  — such as dot-bracket forms (`.['key']`), regex filters (`=~`), unquoted
  string literals, or script expressions (`@.length-1`) — are rejected.
  Parenthesized filter expressions (`[?(expr)]`) are valid RFC 9535
  (`paren-expr`) and are accepted. As a small concession to the official OAI
  conformance corpus, dot-shorthand names containing hyphens or starting with
  digits (e.g. `@.x-oai-traits.paged`, `$.responses.200`) are normalized to
  bracket form before parsing.

- **Overlay §5 `update` targets.** In 1.0, `update` must select objects or
  arrays only; primitive targets are rejected. In 1.1+, a primitive target is
  replaced wholesale by a primitive value. A filter that sweeps extension
  keys (e.g. `x-internal: true`) into an operation-level selection fires this
  rule. The error now lists sibling primitive paths; narrow the filter so it
  selects only the operation objects.

## Conformance corpora

The normative baselines forge is tested against live in the repo:

- `tests/openapi/overlay/oai_tests/` — the OAI's own pass/fail fixtures across
  versions 1.0, 1.1, and 1.2-dev.
- `tests/openapi/overlay/compliant_sets/` — end-to-end apply scenarios from the
  OAI compliant-sets corpus.
- `tests/openapi/overlay/real_world/` — vendored `(spec, overlay, expected)`
  triples from real-world projects, as byte-stable regression gates.

## Linting

`forge openapi overlay --check <overlay>...` validates one or more overlay
documents without applying them. Each overlay is parsed through the full
validator pipeline (required fields, allowed keys per version, RFC 9535
JSONPath parse of every `target`, `components.actions` shape, `$ref` validity,
URI allow-list, action uniqueness, future-minor warnings). `extends` is
NOT resolved — lint is about the overlay document itself, not the files
it points at. `-` reads one overlay from standard input.

```
forge openapi overlay --check overlays/*.yaml
cat ov.yaml | forge openapi overlay --check -
```

Exits 0 when every overlay is valid. On failure, each file's diagnostics
are printed to stderr (prefixed with the file path) and the exit code is
non-zero. All files are checked even when earlier ones fail, so CI gets
every problem in one run. `--check` cannot be combined with `--overlay`
or `--out`.

## Diagnostics

`--explain` prints one line to stderr per overlay action as it runs,
naming the overlay path, action index, verb, target, and node counts.
It is available on both `forge openapi overlay` and `forge generate`
(where overlays are a preprocessing step before SDK generation). Stdout
and generated files are unchanged.

```
forge openapi overlay spec.yaml --overlay fix.yaml --explain
forge generate spec.yaml --overlay fix.yaml --target ts --out sdk --explain
```

The line shape is:

```
<overlay-path>:<action-index> [ref=<name> ]<verb> <target> — <result>
```

Example results:

- `matched 0 nodes — no-op (zero-match actions are silent per spec)`
- `updated 1 node`
- `matched 1 node, mutated 0 nodes` (target existed but update was a no-op)
- `removed 2 nodes`
- `copied 1 node from <source> to <target>`

Reusable actions (1.2 `$ref` into `components.actions`) also include
`ref=<component-name>` after the action index.
