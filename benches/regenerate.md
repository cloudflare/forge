# Benchmark TypeScript SDK regeneration

Run this from the repository root with hyperfine 2.0 or later. The script
times the release CLI against an empty directory, a copy of the previous
SDK, and a copy of that SDK after one response-schema edit. Each case starts
a new process with warm filesystem caches. Preparing directories and comparing
the resulting file trees happen outside the timed command.

For example, download this public release asset with the GitHub CLI and use
jq to add one optional response field. Both inputs use the same JSON formatting.

```sh
cargo build --locked --release
export PATH="$PWD/target/release:$PATH"
data=$(mktemp -d)
gh release download 'openapi@86556f6f04fa6900649d487e72fb2ee5b4a31ae1' \
    --repo cloudflare/forge --pattern openapi.forge.json --dir "$data"
forge normalize "$data/openapi.forge.json" | jq -c . > "$data/base.json"
jq -c '.paths["/accounts/{account_id}/abuse-reports"].get.responses["200"]
       .content["application/json"].schema.properties.benchmarkNote = {"type":"string"}' \
    "$data/base.json" > "$data/edited.json"
RAYON_NUM_THREADS=4 sh benches/regenerate.sh \
    "$data/base.json" "$data/edited.json" "$data/timings.json"
```

You can also supply two versions of your own spec. Choose an edit that
changes the SDK. The script checks the final tree for each case against a
clean generation and exports seven samples per case. Record the generator
commit, machine, hyperfine version and thread count when comparing changes.
