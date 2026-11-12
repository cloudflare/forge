#!/bin/sh
# Compare three TypeScript SDK generation workloads. See regenerate.md.
set -eu

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 BASE.json EDITED.json RESULTS.json" >&2
    exit 2
fi
if [ -e "$3" ]; then
    echo "Choose a new results path: $3" >&2
    exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$1" "$work/base.json"
cp "$2" "$work/edited.json"
(
    cd "$work"
    forge base.json --target ts --out reference
    forge edited.json --target ts --out expected
    if diff -qr reference expected >/dev/null; then
        echo "The edit must change the generated SDK." >&2
        exit 1
    fi

    hyperfine --shell=none --warmup 1 --runs 7 --export-json samples.json \
        --prepare 'rm -rf fresh' \
        --prepare 'rm -rf unchanged && cp -Rp reference unchanged' \
        --prepare 'rm -rf edited && cp -Rp reference edited' \
        -n clean 'forge base.json --target ts --out fresh' \
        -n unchanged 'forge base.json --target ts --out unchanged' \
        -n edited 'forge edited.json --target ts --out edited'

    diff -qr reference fresh
    diff -qr reference unchanged
    diff -qr expected edited
)
cp "$work/samples.json" "$3"
