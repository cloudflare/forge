/**
 * Fetches what the generator reads: the provider at a release tag, and the cloudflare-go versions
 * its go.mod requires, as shallow git clones into a cache. This is the only module that uses the
 * network, and `git clone` is the only process it runs. The clones are data: symbolic links are
 * checked out as plain files, and the generator reads them through `SourceTree` without executing
 * anything in them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type SourceRepository = 'terraform-provider-cloudflare' | 'cloudflare-go';

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const REGISTRY_VERSIONS = 'https://registry.terraform.io/v1/providers/cloudflare/cloudflare/versions';

/** The highest stable `x.y.z`. Older majors still get patch releases, so publication order won't do. */
export function latestStableVersion(versions: readonly string[]): string | undefined {
  return versions
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .map((version) => ({ version, parts: version.split('.').map(Number) }))
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    })
    .at(-1)?.version;
}

/** The newest stable provider on the Terraform registry, where releases are published. */
export async function resolveLatestProviderVersion(): Promise<string> {
  const response = await fetch(REGISTRY_VERSIONS);
  if (!response.ok) {
    throw new Error(`Could not list provider versions: ${response.status} (${REGISTRY_VERSIONS})`);
  }
  const { versions } = z.object({ versions: z.array(z.object({ version: z.string() })) }).parse(await response.json());
  const latest = latestStableVersion(versions.map(({ version }) => version));
  if (!latest) {
    throw new Error('The Terraform registry lists no stable provider version');
  }
  return latest;
}

/**
 * Shallow-clones `cloudflare/<repository>` at the release `tag` into `directory`, unless a previous
 * run did. It clones into a temporary directory first, so an interrupted clone is never reused.
 */
export async function cloneRelease(repository: SourceRepository, tag: string, directory: string): Promise<string> {
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(`${repository}: ${tag} is not a release tag (vX.Y.Z)`);
  }
  if (existsSync(path.join(directory, '.git', 'HEAD'))) {
    return directory;
  }
  const temporary = `${directory}.tmp`;
  await rm(directory, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(path.dirname(directory), { recursive: true });
  console.error(`==> cloning ${repository} ${tag}`);
  execFileSync(
    'git',
    [
      '-c',
      'advice.detachedHead=false',
      '-c',
      'core.symlinks=false',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      '--branch',
      tag,
      `https://github.com/cloudflare/${repository}`,
      temporary,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  await rename(temporary, directory);
  return directory;
}
