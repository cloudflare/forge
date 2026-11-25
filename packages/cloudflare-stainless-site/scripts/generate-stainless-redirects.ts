/**
 * Writes the site's redirects snapshot (`stainless-redirects.json`) to `--output`: the retired
 * Stainless API reference's pages, from its HTTP SDK JSON, the spec it was built from, and its
 * model redirects. The repository root's `pnpm generate:stainless-redirects` passes the path.
 *
 * `./gitlab.ts` downloads the inputs from the Stainless docs site's project; it is the only part
 * that uses the network. `./redirects.ts` turns them into the file, offline.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  downloadArtifacts,
  findArtifacts,
  forbiddenHosts,
  type GitLabSource,
  readArtifacts,
  readArtifactSpec,
  readRepositoryFile,
} from './gitlab.ts';
import {
  buildRedirectsSnapshot,
  compareSnapshots,
  type RedirectsSdkJson,
  type RedirectsSnapshot,
} from './redirects.ts';

const USAGE = `Usage: generate-stainless-redirects --gitlab-url <url> --project <project> --output <file> [--verbose]

  --gitlab-url <url>   The GitLab instance that runs the Stainless docs site's CI
  --project <project>  The Stainless docs site's project, as an ID or a path with namespace
  --output <file>      The file to write, compared with what it holds first
  --verbose            List what the run adds, removes and remaps

GITLAB_TOKEN must hold a token that can read the project's job artifacts and repository.
Artifacts are cached in node_modules/.cache/stainless-snippets by job ID.`;

/** The language whose SDK JSON holds the old site's own pages: the unprefixed HTTP ones. */
const HTTP = 'http';

/** The docs site's file of model redirects, at its repository root. */
const MODEL_REDIRECTS = 'api-redirects.json';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'gitlab-url': { type: 'string' },
      project: { type: 'string' },
      output: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const { 'gitlab-url': gitlabUrl, project, output: outputFile } = values;
  if (!gitlabUrl || !project || !outputFile) {
    const missing = Object.entries({ 'gitlab-url': gitlabUrl, project, output: outputFile })
      .filter(([, value]) => !value)
      .map(([name]) => `--${name}`);
    throw new Error(`Missing ${missing.join(', ')}\n\n${USAGE}`);
  }
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error(
      `GITLAB_TOKEN isn't set. Set it to a GitLab token with the read_api scope; with glab logged in, ` +
        `\`glab config get token --host <gitlab host>\` prints one.\n\n${USAGE}`,
    );
  }
  const source: GitLabSource = { url: gitlabUrl, project, token };

  const { pipeline, jobs } = await findArtifacts(source, [HTTP]);
  console.log(`generate-stainless-redirects: pipeline ${pipeline.id} (commit ${pipeline.sha.slice(0, 12)})`);
  const cache = path.resolve('node_modules', '.cache', 'stainless-snippets');
  const { archive, file } = await downloadArtifacts(source, jobs[HTTP], cache);
  let sdkJson: string;
  let spec: string;
  try {
    sdkJson = readArtifacts(archive, HTTP).sdkJson;
    spec = readArtifactSpec(archive, HTTP);
  } catch (error) {
    // A zip that can't be read is most likely an interrupted download.
    if (error instanceof Error && error.message.startsWith('zip:')) {
      throw new Error(`${error.message}. Delete ${path.relative(process.cwd(), file)} and run again.`);
    }
    throw error;
  }
  const modelRedirects = JSON.parse(await readRepositoryFile(source, MODEL_REDIRECTS)) as Record<string, unknown>;

  const snapshot = buildRedirectsSnapshot({
    sdkJson: JSON.parse(sdkJson) as RedirectsSdkJson,
    spec: JSON.parse(spec) as Parameters<typeof buildRedirectsSnapshot>[0]['spec'],
    modelRedirects,
  });
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const leak = forbiddenHosts(source.url).find((needle) => content.toLowerCase().includes(needle.toLowerCase()));
  if (leak) {
    throw new Error(
      `The snapshot contains "${leak}", which must not be published. It comes from the old site's paths or the ` +
        'spec they were built from: find it in the output of a run with --verbose, fix it there, and run again.',
    );
  }

  console.log(
    `  ${snapshot.resources.length} resources, ${Object.keys(snapshot.methods).length} methods, ` +
      `${snapshot.models.length} models, ${snapshot.operations.length} operations`,
  );
  const output = path.resolve(outputFile);
  if (existsSync(output)) {
    const changes = compareSnapshots(JSON.parse(await readFile(output, 'utf8')) as RedirectsSnapshot, snapshot);
    console.log(
      `  against ${path.relative(process.cwd(), output)}: ${changes.added.length} added, ` +
        `${changes.removed.length} removed, ${changes.remapped.length} methods remapped`,
    );
    if (values.verbose) {
      for (const entry of changes.added) {
        console.log(`    + ${entry}`);
      }
      for (const entry of changes.removed) {
        console.log(`    - ${entry}`);
      }
      for (const entry of changes.remapped) {
        console.log(`    ~ ${entry}`);
      }
    }
  }
  await writeFile(output, content, 'utf8');
  console.log(`generate-stainless-redirects: wrote ${path.relative(process.cwd(), output)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (process.env.DEBUG ? error.stack : error.message) : error);
    process.exitCode = 1;
  });
}
