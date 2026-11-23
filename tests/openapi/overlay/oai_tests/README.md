# Official OAI Overlay-Specification schema-test corpus

Per-version corpora of overlay documents vendored from the official
`OAI/Overlay-Specification` repository. Each version directory has:

- `pass/*.yaml` — schema-valid overlay documents. Implementations MUST accept
  them (parse + apply successfully).
- `fail/*.yaml` — overlay documents with a structural, type, or semantic
  defect the spec forbids. Implementations MUST reject them.

The harness in [`../oai_conformance.rs`](../oai_conformance.rs) walks every file
and invokes `forge openapi overlay <trivial-spec> --overlay <test.yaml>` to assert the
expected outcome. We run each OAI document in Mode B against a trivial spec, so
`extends` is ignored (log-only) — this lets us test documents whose `extends`
URIs point at files we don't have.

## Provenance

- Upstream: https://github.com/OAI/Overlay-Specification
- Commit:   `be39b56020da12b8db56080da90fecb470701831`
- Vendored:  `v1.0/`, `v1.1/`, `v1.2-dev/`

Refresh with:

```sh
python3 -I tests/openapi/overlay/oai_tests/fetch.py <new-commit-sha>
```

The script writes the SHA into `.commit-sha` next to this README; the harness
reads directories but does not depend on the SHA at runtime.

## File counts

| Version    | pass | fail |
|------------|-----:|-----:|
| v1.0       |   12 |   20 |
| v1.1       |   13 |   22 |
| v1.2-dev   |   22 |   43 |
