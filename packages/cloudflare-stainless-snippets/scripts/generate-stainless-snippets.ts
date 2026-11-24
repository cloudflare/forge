/**
 * Ports the retired Stainless API reference's TypeScript, Python and Go snippets into `--output`,
 * keyed by the old pages in `--snapshot` (the site's `stainless-redirects.json`). The repository
 * root's `pnpm generate:stainless-snippets` passes both paths.
 *
 * `./gitlab.ts` downloads the snippets from the Stainless docs site's CI; it is the only part that
 * uses the network. `./snippets.ts` turns them into the file, offline.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { downloadArtifacts, findArtifacts, type GitLabSource, readArtifacts } from './gitlab.ts';
import { buildSnippetsFile, extractSnippets, LANGUAGES, type Language, type SdkJson } from './snippets.ts';

const USAGE = `Usage: generate-stainless-snippets --gitlab-url <url> --project <project> --snapshot <file> --output <file> [--verbose]

  --gitlab-url <url>   The GitLab instance that runs the Stainless docs site's CI
  --project <project>  The Stainless docs site's project, as an ID or a path with namespace
  --snapshot <file>    The site's stainless-redirects.json, whose method pages are kept
  --output <file>      The file to write
  --verbose            List the pages skipped or left without a snippet

GITLAB_TOKEN must hold a token that can read the project's job artifacts.
Artifacts are cached in node_modules/.cache/stainless-snippets by job ID.`;

/** What no snippet may contain: the GitLab host, and the domain it belongs to. */
export function forbiddenHosts(gitlabUrl: string): string[] {
  const host = new URL(gitlabUrl).hostname;
  const domain = host.split('.').slice(-2).join('.');
  return [...new Set([host, domain])];
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'gitlab-url': { type: 'string' },
      project: { type: 'string' },
      snapshot: { type: 'string' },
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
  const { 'gitlab-url': gitlabUrl, project, snapshot: snapshotFile, output: outputFile } = values;
  if (!gitlabUrl || !project || !snapshotFile || !outputFile) {
    const missing = Object.entries({ 'gitlab-url': gitlabUrl, project, snapshot: snapshotFile, output: outputFile })
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

  const snapshot = JSON.parse(await readFile(path.resolve(snapshotFile), 'utf8')) as { methods?: object };
  if (!snapshot.methods) {
    throw new Error(
      `${snapshotFile} has no "methods". Pass the site's src/stainless-redirects.json as --snapshot, as the ` +
        "repository root's pnpm generate:stainless-snippets does.",
    );
  }

  const { pipeline, jobs } = await findArtifacts(source);
  console.log(`generate-stainless-snippets: pipeline ${pipeline.id} (commit ${pipeline.sha.slice(0, 12)})`);
  const cache = path.resolve('node_modules', '.cache', 'stainless-snippets');
  const snippets = {} as Record<Language, Map<string, string>>;
  const shas = new Set<string>();
  for (const language of LANGUAGES) {
    const { archive, file } = await downloadArtifacts(source, jobs[language], cache);
    let artifacts: ReturnType<typeof readArtifacts>;
    try {
      artifacts = readArtifacts(archive, language);
    } catch (error) {
      // A zip that can't be read is most likely an interrupted download.
      if (error instanceof Error && error.message.startsWith('zip:')) {
        throw new Error(`${error.message}. Delete ${path.relative(process.cwd(), file)} and run again.`);
      }
      throw error;
    }
    const { sdkJson, apiSchemasSha } = artifacts;
    shas.add(apiSchemasSha);
    snippets[language] = extractSnippets(JSON.parse(sdkJson) as SdkJson, language);
  }
  const [apiSchemasSha, ...otherShas] = shas;
  if (!apiSchemasSha || otherShas.length > 0) {
    throw new Error(
      `The languages were built from different api-schemas commits (${[...shas].join(', ')}), so their snippets ` +
        "wouldn't match. The jobs come from one pipeline, so its prep step changed mid-run: wait for the next pipeline " +
        'and run again.',
    );
  }

  const result = buildSnippetsFile({
    snippets,
    methods: Object.keys(snapshot.methods),
    forbidden: forbiddenHosts(source.url),
    source: { apiSchemasSha, generatedAt: new Date().toISOString() },
  });

  const pages = Object.keys(result.file.snippets).length;
  for (const language of LANGUAGES) {
    const kept = snippets[language].size - result.unknown[language].length;
    console.log(
      `  ${language}: ${kept} kept, ${result.unknown[language].length} skipped (not in the snapshot), ${result.missing[language].length} old pages without one`,
    );
    if (values.verbose) {
      for (const page of result.unknown[language]) {
        console.log(`    skipped ${page}`);
      }
      for (const page of result.missing[language]) {
        console.log(`    missing ${page}`);
      }
    }
  }

  const output = path.resolve(outputFile);
  await writeFile(output, `${JSON.stringify(result.file, null, 2)}\n`, 'utf8');
  console.log(`generate-stainless-snippets: wrote ${path.relative(process.cwd(), output)} (${pages} pages)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (process.env.DEBUG ? error.stack : error.message) : error);
    process.exitCode = 1;
  });
}
