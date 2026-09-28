#!/usr/bin/env node
// Resolve which SDK languages the current run should generate, and emit them as
// a matrix.
//
// This exists because GitHub Actions cannot evaluate the `matrix` context in a
// job-level `if` -- jobs.<job_id>.if only sees github, needs, vars and inputs.
// So "eight languages are defined but disabled" cannot be expressed as a static
// matrix with a per-entry condition, the way .gitlab-ci.yml did it with a
// one-line `rules: [when: never]` override. Keeping the language table as data
// and computing the matrix here gets the same ergonomics back.
//
//   pull_request / push : languages with "auto": true
//   workflow_dispatch   : the selected language, or every language for "all"
//
// Writes `matrix=<json>` and `any=<bool>` to $GITHUB_OUTPUT, or to stdout when
// run locally.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = join(HERE, '..', 'sdk-languages.json');

/** @type {{ languages: Array<{ language: string, auto: boolean }> }} */
const { languages } = JSON.parse(readFileSync(TABLE, 'utf8'));

const event = process.env.GITHUB_EVENT_NAME ?? '';
const selected = (process.env.SDK_LANGUAGE ?? '').trim();

let selection;
if (event === 'workflow_dispatch') {
  selection =
    selected === '' || selected === 'all' ? languages : languages.filter((entry) => entry.language === selected);
  if (selection.length === 0) {
    console.error(`error: unknown language: ${selected} (known: ${languages.map((e) => e.language).join(', ')})`);
    process.exit(1);
  }
} else {
  selection = languages.filter((entry) => entry.auto === true);
}

// Everything the job needs derives from the language name: the workspace package
// wrapping the generator, and the directory generators.yml writes into.
const include = selection.map(({ language }) => ({
  language,
  package: `@cloudflare/forge-sdk-${language}`,
  'output-path': `packages/cloudflare-forge-sdk-${language}`,
}));

const names = include.map((entry) => entry.language);
console.log(`Generating: ${names.length > 0 ? names.join(', ') : '(none enabled for this event)'}`);

const outputs = [`matrix=${JSON.stringify(include)}`, `any=${include.length > 0}`];
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
} else {
  console.log(outputs.join('\n'));
}
