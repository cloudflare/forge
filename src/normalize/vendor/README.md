# The vendor tables

`forge normalize` rewrites the extensions other tools write (Cloudflare's
`x-sensitive`, Fern's `x-fern-*`, and Stainless's `x-stainless-*`) into the
native `x-forge-*` vocabulary. This folder owns those normalization mappings:
their source, native replacement, and value form.

The parser still reads the compatibility extensions directly. Moving it to the
native vocabulary is a separate change, so vendor names remain in `src/link/`
for now. Normalization is explicit; `forge` does not run it before parsing.

## Rules

- **Normalization mappings live only here.** The current parser still names
  compatibility extensions in `src/link/`; do not add another normalization
  table outside this folder. Normalization tests live in `tests/normalize/`.
- **Mapping, not semantics.** A source implements the `Source` trait and
  returns its normalizers for definitions, parameters, and schemas. A
  normalizer says which native key a key becomes and rewrites its value.
  Anything structural, such as how aliases become methods, belongs to the
  builder, not here. The one value that is written again is a group path, which
  becomes the names joined by dots (`walk.rs`).
- **One adapter per source.** `--from` selects the `cloudflare`, `fern`, and
  `stainless` adapters, and no `--from` selects them all.
- **A key is rewritten only at the level where Forge reads the corresponding
  metadata**: an operation or an alias, a parameter, or a schema. The same key
  on another kind of object is left alone, since rewriting it would give it a
  meaning it did not have.
- **Native wins.** When a document has the native key, the vendor one is
  dropped, whatever order they appear in. When a vendor key has no native form, it is left as it is written: on a
  property, `x-stainless-skip: true` and `false` become `x-forge-skip` with the
  same value, but a list of targets such as `["terraform"]` says "skip for
  these targets", which `x-forge-skip` cannot, as it is for every target. On an
  operation, `x-stainless-skip` is not read at all.

## Adding a vendor key

1. Identify the Forge primitive the vendor key represents and the native
   `x-forge-*` key for that primitive. Normalization does not introduce new
   semantics; native parser support belongs in a separate change.
2. Map it in the adapter for its source. To add a source, implement `Source` in
   a module beside `cloudflare.rs`, `fern.rs`, and `stainless.rs`, then register
   that implementation in `mod.rs`.
3. Add a test in `tests/normalize/` showing the exact native document produced
   from the vendor-keyed input.

Until the parser moves to the native vocabulary, parser support for a new
compatibility key remains a separate concern from adding its normalization
mapping.
