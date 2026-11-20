/**
 * Downloads the Stainless docs site's SDK JSON files: the job artifacts of its
 * `generate-sdk-jsons:production: [<language>]` CI jobs. This is the only part that uses the
 * network, and it only reads from the GitLab API.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LANGUAGES, type Language } from './snippets.ts';
import { readZipEntry } from './zip.ts';

export interface GitLabSource {
  /** The GitLab instance, such as `https://gitlab.example.com`. */
  url: string;
  /** The Stainless docs site's project: its ID or its path with namespace. */
  project: string;
  token: string;
}

interface Pipeline {
  id: number;
  sha: string;
}

interface Job {
  id: number;
  name: string;
  status: string;
  artifacts_expire_at: string | null;
  artifacts?: { file_type: string }[];
}

/** The CI job that writes a language's SDK JSON for the production site. */
export function jobName(language: Language): string {
  return `generate-sdk-jsons:production: [${language}]`;
}

/**
 * The newest successful pipeline whose production jobs for every language still have their
 * artifacts, with those jobs' IDs. GitLab's first page holds the newest 20 pipelines, newest
 * first; schedules alternate staging and production, so it always holds a production one.
 */
export async function findArtifacts(
  source: GitLabSource,
  now = new Date(),
): Promise<{ pipeline: Pipeline; jobs: Record<Language, number> }> {
  const pipelines = await api<Pipeline[]>(source, 'pipelines?ref=main&status=success');
  for (const pipeline of pipelines) {
    // Over GitLab's default page of 20, so a growing pipeline can't push a job off the page.
    const listed = await api<Job[]>(source, `pipelines/${pipeline.id}/jobs?per_page=100`);
    const jobs = {} as Record<Language, number>;
    for (const language of LANGUAGES) {
      const job = listed.find(
        (candidate) =>
          candidate.name === jobName(language) &&
          candidate.status === 'success' &&
          candidate.artifacts?.some((artifact) => artifact.file_type === 'archive') &&
          (!candidate.artifacts_expire_at || new Date(candidate.artifacts_expire_at) > now),
      );
      if (job) {
        jobs[language] = job.id;
      }
    }
    if (LANGUAGES.every((language) => jobs[language] !== undefined)) {
      return { pipeline, jobs };
    }
  }
  throw new Error(
    `None of the ${pipelines.length} newest successful pipelines on main has unexpired artifacts for ${LANGUAGES.map(jobName).join(', ')}. ` +
      'Check that --project is the docs site, and in its pipelines that those jobs still exist under these names and ' +
      'have run in the last day. If they were renamed, update jobName in scripts/gitlab.ts.',
  );
}

/** A job's artifact archive, downloaded into `cache` once and reused after, and the file it's cached in. */
export async function downloadArtifacts(
  source: GitLabSource,
  job: number,
  cache: string,
): Promise<{ archive: Buffer; file: string }> {
  const file = path.join(cache, `job-${job}.zip`);
  if (existsSync(file)) {
    return { archive: await readFile(file), file };
  }
  const response = await request(source, `jobs/${job}/artifacts`);
  const archive = Buffer.from(await response.arrayBuffer());
  await mkdir(cache, { recursive: true });
  await writeFile(`${file}.partial`, archive);
  await rename(`${file}.partial`, file);
  return { archive, file };
}

/** What one language's artifact archive holds: its SDK JSON and the api-schemas commit it was built from. */
export function readArtifacts(archive: Buffer, language: Language): { sdkJson: string; apiSchemasSha: string } {
  const entry = (name: string) => {
    const content = readZipEntry(archive, name);
    if (!content) {
      throw new Error(
        `${jobName(language)}: the artifacts have no ${name}. If the job now writes it elsewhere, update readArtifacts ` +
          'in scripts/gitlab.ts with the path the job lists under its artifacts.',
      );
    }
    return content;
  };
  const sdkJson = entry(`.sdk-json-cache/cloudflare/${language}.json`);
  const sha = (JSON.parse(entry('.schemas/BUILD_INFO.json').toString('utf8')) as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `${jobName(language)}: .schemas/BUILD_INFO.json has no 40-character "sha". If the commit is recorded under ` +
        'another key, update readArtifacts in scripts/gitlab.ts to read it.',
    );
  }
  return { sdkJson: sdkJson.toString('utf8'), apiSchemasSha: sha };
}

async function api<T>(source: GitLabSource, resource: string): Promise<T> {
  return (await (await request(source, resource)).json()) as T;
}

async function request(source: GitLabSource, resource: string): Promise<Response> {
  const url = `${source.url.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(source.project)}/${resource}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${source.token}` }, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `GitLab API: ${response.status} ${response.statusText} for ${resource}. ${requestHint(response.status)}`,
    );
  }
  return response;
}

/** What to check when the GitLab API refuses a request. */
function requestHint(status: number): string {
  switch (status) {
    case 401:
      return 'GITLAB_TOKEN is invalid or expired: create a new token and run again.';
    case 403:
      return "GITLAB_TOKEN works but can't read this project: it needs the read_api scope and access to the project.";
    case 404:
      return "Check --gitlab-url and --project; GitLab also answers 404 for projects the token can't see.";
    default:
      return status >= 500 ? 'GitLab is failing: run again later.' : 'Check --gitlab-url, --project and GITLAB_TOKEN.';
  }
}
