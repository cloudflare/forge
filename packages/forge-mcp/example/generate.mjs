// Generates example/generated/mcp-tools.json: downloads the latest
// openapi.forge.json release and runs the default plugin on it with forge.
//
// forge is FORGE_BINARY, or the repository's release build
// (cargo build --release --features wasm).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(pkg, 'example', 'generated');
const spec = join(out, 'openapi.forge.json');
const plugin = join(pkg, 'dist', 'forge-mcp.wasm');
const forge = process.env.FORGE_BINARY ?? join(pkg, '..', '..', 'target', 'release', 'forge');

if (!existsSync(forge)) {
  throw new Error(`No forge at ${forge}. Run cargo build --release --features wasm, or set FORGE_BINARY.`);
}
if (!existsSync(plugin)) {
  throw new Error(`No plugin at ${plugin}. Run pnpm build:plugin.`);
}

mkdirSync(out, { recursive: true });
const url = 'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json';
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`${url}: ${response.status}`);
}
writeFileSync(spec, Buffer.from(await response.arrayBuffer()));

execFileSync(forge, [spec, '--target', `wasm://${plugin}`, '--out', out], { stdio: 'inherit' });
console.log(`Wrote ${join(out, 'mcp-tools.json')}`);
