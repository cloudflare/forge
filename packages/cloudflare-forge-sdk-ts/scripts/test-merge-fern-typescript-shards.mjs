import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const mergeScript = fileURLToPath(new URL('./merge-fern-typescript-shards.mjs', import.meta.url));

for (const [name, inputPath] of [
  ['missing resource and core directories', 'api/types/Availability.ts'],
  ['missing all aggregate directories', 'marker.txt'],
]) {
  test(`creates aggregate barrels when ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-shard-merge-'));
    try {
      const shard = join(root, 'shard');
      const output = join(root, 'output');
      const source = join(shard, inputPath);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, 'fixture\n');

      await execFileAsync(process.execPath, [mergeScript, output, shard]);

      assert.equal(await readFile(join(output, inputPath), 'utf8'), 'fixture\n');
      for (const aggregate of [
        'api/resources/index.ts',
        'api/index.ts',
        'core/exports.ts',
        'core/index.ts',
        'index.ts',
      ]) {
        assert.equal(await readFile(join(output, aggregate), 'utf8'), '\n');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
