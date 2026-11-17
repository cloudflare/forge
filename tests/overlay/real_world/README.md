# Real-world overlay regression fixtures

Each subdirectory here is an end-to-end `(spec, overlay, expected)` triple that
`real_world.rs` applies and compares. The goal is to catch any silent drift in
`forge overlay`'s apply semantics against known-good baselines.

Comparison is YAML tree-based (parse both sides, compare `serde_yml::Value`),
not byte-exact: the output of forge's YAML serializer is allowed to re-shape
whitespace/quoting without breaking the regression gate.

## Fixtures

### `convos/` — object merge on `components.schemas.*.properties.*`

- Source: <https://github.com/convos-chat/convos>, `pkg/api/overlay.yaml` applied
  to `pkg/server/public/convos-api3.yaml`.
- Upstream commits:
  - overlay: `b19c6f99089f67144b2371af2cf859959d2390ee`
  - spec: `a76d5ff75a4ed99d3e3fb7b33fe0fcdd8fd888f8`
- License: Artistic License 2.0 (`LICENSE` file at the convos repo root).
- Exercises: object-merge `update` against several schema-property targets
  (adding `x-go-type` / `x-go-type-import` extensions).

### `add_tags_and_security/` — array concatenation (Overlay 1.1+)

- Source: synthesized. The pattern — appending tags, appending `security`
  requirements, and merging a new scheme into `components.securitySchemes`
  — is drawn from
  <https://github.com/elastic/elasticsearch-specification/blob/main/docs/overlays/elasticsearch-openapi-overlays.yaml>,
  which couples the same shape with a large (multi-MB) spec that would
  dominate this vendored tree.
- Exercises: Overlay 1.1 §5 array-under-property concatenation and direct
  array-target concatenation.

### `strip_internal/` — `remove` on filter-selected operations and schemas

- Source: synthesized. The pattern — removing operations and schemas marked
  with `x-internal: true` before publishing — is used by many OpenAPI
  pipelines (Stoplight, Fern, Speakeasy, Redocly).
- Exercises: `remove` under an RFC 9535 filter that selects multiple
  objects across two parents.

## Updating a fixture

If forge's apply semantics intentionally change, regenerate the expected
output with:

```
cargo build --bin forge --features cli
./target/debug/forge overlay <dir>/spec.yaml --overlay <dir>/overlay.yaml \
  > <dir>/expected.yaml
```

Then review the diff carefully: the point of this directory is that a silent
change to `expected.yaml` is a red flag during code review.
