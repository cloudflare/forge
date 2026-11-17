# `forge overlay`

Applies one or more [OpenAPI Overlay](https://spec.openapis.org/overlay/latest)
documents to an OpenAPI spec and prints the result (or writes it to a file
with `--out`).

```
forge overlay <overlay>                             # Mode A: overlay drives the spec via its `extends`
forge overlay <spec> --overlay <overlay>...         # Mode B
forge overlay <spec> --overlay <overlay> --out <path>
```

At the top level, overlays are a preprocessing step before SDK generation,
not a separate print mode:

```
forge <spec> --overlay <overlay>... --target <t> --out <dir>
forge <overlay-with-extends> [--overlay <ov>]... --target <t> --out <dir>
```

Use `forge overlay` (the subcommand) when you want to inspect or write the
merged spec itself; use the top-level `forge` when you want an SDK built
from a preprocessed spec.

Without `--out` the `forge overlay` subcommand prints the overlaid document
to standard output. `--out <path>` writes it to `<path>` instead; if
`<path>` is the same file as the Mode B spec, the file is rewritten
atomically (temp file + rename in the same directory) and left
byte-identical when no action mutated it.

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

## Strictness choices adopters trip on

Two cases where forge is stricter than some other overlay tools. The behavior
is intentional and tracks the spec; the fixes are small overlay edits.

- **RFC 9535 JSONPath only.** The Overlay spec (all three versions) references
  RFC 9535 for `target`. Goessner filter syntax `[?(expr)]` must be rewritten
  without the parentheses: `[?expr]`. Dot-bracket forms like `.['key']` are
  not valid RFC 9535 — use either `['key']` or `.key`.

- **Overlay §5 `update` targets.** In 1.0, `update` must select objects or
  arrays only; primitive targets are rejected. In 1.1+, a primitive target is
  replaced wholesale by a primitive value. A filter that sweeps extension
  keys (e.g. `x-internal: true`) into an operation-level selection fires this
  rule. The error now lists sibling primitive paths; narrow the filter so it
  selects only the operation objects.

## Conformance corpora

The normative baselines forge is tested against live in the repo:

- `tests/overlay/oai_tests/` — the OAI's own pass/fail fixtures across
  versions 1.0, 1.1, and 1.2-dev.
- `tests/overlay/compliant_sets/` — end-to-end apply scenarios from the
  OAI compliant-sets corpus.
- `tests/overlay/real_world/` — vendored `(spec, overlay, expected)` triples
  from real-world projects, as byte-stable regression gates.

## Linting

`forge overlay --check <overlay>...` validates one or more overlay documents
without applying them. Each overlay is parsed through the full validator
pipeline (required fields, allowed keys per version, RFC 9535 JSONPath
parse of every `target`, `components.actions` shape, `$ref` validity,
URI allow-list, action uniqueness, future-minor warnings). `extends` is
NOT resolved — lint is about the overlay document itself, not the files
it points at. `-` reads one overlay from standard input.

```
forge overlay --check overlays/*.yaml
cat ov.yaml | forge overlay --check -
```

Exits 0 when every overlay is valid. On failure, each file's diagnostics
are printed to stderr (prefixed with the file path) and the exit code is
non-zero. All files are checked even when earlier ones fail, so CI gets
every problem in one run. `--check` cannot be combined with `--overlay`
or `--out`.

## Diagnostics

`--explain` prints one line to stderr per overlay action as it runs,
naming the overlay path, action index, verb, target, and node counts.
It is available on both the `forge overlay` subcommand and the top-level
`forge` (where overlays are a preprocessing step before SDK generation).
Stdout and generated files are unchanged.

```
forge overlay spec.yaml --overlay fix.yaml --explain
forge spec.yaml --overlay fix.yaml --target ts --out sdk --explain
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
