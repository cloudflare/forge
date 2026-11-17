# OpenAPI Overlay compliant-sets fixtures

These eight scenario directories are vendored verbatim from the official
`OAI/Overlay-Specification` repository on GitHub. They are the canonical
compliant-sets corpus, used here as a black-box conformance suite for
`forge overlay`.

## Provenance

- Upstream: https://github.com/OAI/Overlay-Specification/tree/main/compliant-sets
- Commit: `58f5fe684d4723224cdeb960098c69f43d7f4575`
- Date: 2025-11-18

Refresh the fixtures by re-vendoring from the same path at the newest commit
and updating the SHA above. See `../compliant_sets.rs` for the harness that
runs each scenario.

## Scenarios

Six scenarios apply an overlay to the input `openapi.yaml` and MUST produce a
document structurally equal to `output.yaml`:

- `add-a-license`
- `description-and-summary`
- `remove-example`
- `remove-matching-responses`
- `replace-servers-for-sandbox`
- `update-root`

Two scenarios use the older Goessner `[?(...)]` JSONPath filter syntax,
which RFC 9535 forbids; `forge overlay` rejects them and MUST point authors
at RFC 9535 in the diagnostic:

- `remove-property`
- `remove-server`
