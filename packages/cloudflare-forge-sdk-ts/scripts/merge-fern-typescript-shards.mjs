#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const [outputDir, ...shardDirs] = process.argv.slice(2);
if (!outputDir || shardDirs.length === 0) {
  console.error('usage: merge-fern-typescript-shards.mjs <output-dir> <shard-dir>...');
  process.exit(2);
}

const allowedAggregateConflicts = new Set([
  'api/index.ts',
  'api/resources/index.ts',
  'core/exports.ts',
  'core/index.ts',
  'index.ts',
]);

const seen = new Map();
const caseInsensitivePaths = new Map();
const aggregateVariants = new Map();

async function filesUnder(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else files.push({ path, relativePath: relative(root, path) });
  }
  return files;
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const shardDir of shardDirs) {
  for (const { path, relativePath } of await filesUnder(shardDir)) {
    const normalizedPath = relativePath.toLowerCase();
    const previousPath = caseInsensitivePaths.get(normalizedPath);
    if (previousPath && previousPath !== relativePath) {
      throw new Error(`Fern shard case-only path collision: ${previousPath} and ${relativePath}`);
    }
    caseInsensitivePaths.set(normalizedPath, relativePath);
    const content = await readFile(path);
    const hash = createHash('sha256').update(content).digest('hex');
    const previous = seen.get(relativePath);
    if (previous && previous !== hash && !allowedAggregateConflicts.has(relativePath)) {
      throw new Error(`Fern shard conflict: ${relativePath}`);
    }
    if (allowedAggregateConflicts.has(relativePath)) {
      const variants = aggregateVariants.get(relativePath) ?? [];
      variants.push(content.toString('utf8'));
      aggregateVariants.set(relativePath, variants);
    }
    if (!previous) {
      seen.set(relativePath, hash);
      const destination = join(outputDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
}

// Rebuild the distributed root resource barrel in Fern order.
const resourceIndexPath = 'api/resources/index.ts';
const resources = new Map();
for (const source of aggregateVariants.get(resourceIndexPath) ?? []) {
  for (const line of source.trim().split('\n')) {
    if (!line) continue;
    const resource = line.match(/from\s+["']\.\/([^/"']+)/)?.[1];
    if (!resource) throw new Error(`Unexpected Fern resource export: ${line}`);
    const lines = resources.get(resource) ?? new Set();
    lines.add(line);
    resources.set(resource, lines);
  }
}
const rankResourceExport = (line) => {
  if (line.startsWith('export * as ')) return 0;
  if (line.includes('/client/requests')) return 1;
  if (line.includes('/types')) return 2;
  return 3;
};
const resourceLines = [];
for (const resource of [...resources.keys()].sort((a, b) => a.localeCompare(b))) {
  resourceLines.push(
    ...[...resources.get(resource)].sort((a, b) => rankResourceExport(a) - rankResourceExport(b) || a.localeCompare(b)),
  );
}
await writeFile(join(outputDir, resourceIndexPath), `${resourceLines.join('\n')}\n`);

// The remaining Fern root/core barrels are also distributed across shards.
// Preserve first-seen Fern order while retaining every unique export.
for (const aggregatePath of allowedAggregateConflicts) {
  if (aggregatePath === resourceIndexPath) continue;
  const lines = new Set();
  for (const source of aggregateVariants.get(aggregatePath) ?? []) {
    for (const line of source.trim().split('\n')) {
      if (!line) continue;
      if (!line.startsWith('export ')) {
        throw new Error(`Unexpected Fern aggregate export in ${aggregatePath}: ${line}`);
      }
      lines.add(line);
    }
  }
  await writeFile(join(outputDir, aggregatePath), `${[...lines].join('\n')}\n`);
}

// Resolve ESM paths against the complete tree.
const allFiles = await filesUnder(outputDir);
const filePaths = new Set(allFiles.map(({ path }) => path));
const relativeSpecifier = /((?:from|import)\s+["']|export\s+\*\s+from\s+["'])(\.\.?\/[^"']+?)(["'])/g;
const unresolvedSpecifiers = [];
const unresolvedLimit = 20;
for (const { path } of allFiles) {
  if (!path.endsWith('.ts')) continue;
  const source = await readFile(path, 'utf8');
  const next = source.replace(relativeSpecifier, (match, prefix, specifier, suffix) => {
    if (/\.(?:js|json|node)$/.test(specifier)) return match;
    const target = resolve(dirname(path), specifier);
    if (filePaths.has(`${target}.ts`)) return `${prefix}${specifier}.js${suffix}`;
    if (filePaths.has(join(target, 'index.ts'))) return `${prefix}${specifier}/index.js${suffix}`;
    if (unresolvedSpecifiers.length < unresolvedLimit) {
      unresolvedSpecifiers.push(`${relative(outputDir, path)}: ${specifier}`);
    }
    return match;
  });
  if (next !== source) await writeFile(path, next);
}
if (unresolvedSpecifiers.length > 0) {
  console.warn(
    `warning: unresolved ESM specifiers (showing up to ${unresolvedLimit}):\n${unresolvedSpecifiers.join('\n')}`,
  );
}

console.log(`merged ${seen.size} Fern files from ${shardDirs.length} canonical-IR shards`);
