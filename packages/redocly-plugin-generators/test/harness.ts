import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createConfig, lint, parseYaml } from '@redocly/openapi-core';
import generatorsPlugin from '../index.ts';

export interface FixtureProblem {
  ruleId: string;
  severity: string;
  message: string;
  location: string;
  from?: string;
}

const ENTRY_FILES = ['openapi.yaml', 'openapi.json', 'swagger.yaml'];

export function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isDirectory())
    .sort();
}

export function entryFile(caseDirectory: string): string {
  const entry = ENTRY_FILES.find((file) => existsSync(join(caseDirectory, file)));
  if (entry === undefined) {
    throw new Error(`${caseDirectory} has no ${ENTRY_FILES.join(' / ')}`);
  }
  return join(caseDirectory, entry);
}

/**
 * Lints a fixture case. The case's `redocly.yaml` (optional) supplies rule settings; by default
 * only `generators/<ruleName>` is enabled, at `error`, and no built-in rules run.
 */
export async function lintCase(
  caseDirectory: string,
  defaultRules: Record<string, unknown>,
): Promise<FixtureProblem[]> {
  const configPath = join(caseDirectory, 'redocly.yaml');
  const caseConfig = existsSync(configPath)
    ? (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : { rules: defaultRules };
  const config = await createConfig(
    { extends: [], ...caseConfig, plugins: [generatorsPlugin()] } as Parameters<typeof createConfig>[0],
    { configPath },
  );
  const problems = await lint({ ref: entryFile(caseDirectory), config });
  const toLocation = (location: { source: { absoluteRef: string }; pointer?: string; reportOnKey?: boolean }) =>
    `${relative(caseDirectory, location.source.absoluteRef)}${location.pointer ?? ''}${location.reportOnKey === true ? ' (key)' : ''}`;
  return problems
    .map((problem) => {
      const result: FixtureProblem = {
        ruleId: problem.ruleId,
        severity: problem.severity,
        message: problem.message.replaceAll(caseDirectory, '<fixture>'),
        location: problem.location[0] === undefined ? '' : toLocation(problem.location[0] as never),
      };
      if (problem.from !== undefined) {
        result.from = toLocation(problem.from as never);
      }
      return result;
    })
    .sort(
      (left, right) =>
        left.location.localeCompare(right.location) ||
        left.ruleId.localeCompare(right.ruleId) ||
        left.message.localeCompare(right.message),
    );
}

export const shouldUpdate = process.env.UPDATE_FIXTURES === '1';

export function readExpected(caseDirectory: string): FixtureProblem[] | undefined {
  const outputPath = join(caseDirectory, 'output.json');
  return existsSync(outputPath) ? (JSON.parse(readFileSync(outputPath, 'utf8')) as FixtureProblem[]) : undefined;
}

export function writeExpected(caseDirectory: string, problems: FixtureProblem[]): void {
  writeFileSync(join(caseDirectory, 'output.json'), `${JSON.stringify(problems, null, 2)}\n`);
}
