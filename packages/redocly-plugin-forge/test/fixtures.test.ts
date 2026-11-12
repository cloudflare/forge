import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fullName, ruleDefinitions } from '../index.ts';
import { lintCase, listDirectories, readExpected, shouldUpdate, writeExpected } from './harness.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

const definitionByBaseName = new Map(ruleDefinitions.map((definition) => [definition.name, definition]));

describe('rule fixtures', () => {
  for (const ruleName of listDirectories(FIXTURES)) {
    describe(ruleName, () => {
      for (const caseName of listDirectories(join(FIXTURES, ruleName))) {
        const caseDirectory = join(FIXTURES, ruleName, caseName);
        test(caseName, async () => {
          const definition = definitionByBaseName.get(ruleName);
          const ruleId = definition === undefined ? `generators/${ruleName}` : `generators/${fullName(definition)}`;
          const problems = await lintCase(caseDirectory, {
            [ruleId]: 'error',
          });
          if (shouldUpdate) {
            writeExpected(caseDirectory, problems);
            return;
          }
          const expected = readExpected(caseDirectory);
          expect(expected, `${caseDirectory}/output.json is missing; run pnpm test:update`).toBeDefined();
          expect(problems).toEqual(expected);
        });
      }
    });
  }
});

describe('fixture coverage', () => {
  const fixtureRules = new Set(listDirectories(FIXTURES));

  test('every fixture directory is a registered rule', () => {
    const registered = new Set(ruleDefinitions.map((definition) => definition.name));
    expect([...fixtureRules].filter((name) => !registered.has(name))).toEqual([]);
  });

  for (const definition of ruleDefinitions) {
    test(`${definition.name} has passing and failing fixtures`, () => {
      const cases = listDirectories(join(FIXTURES, definition.name));
      const outputs = cases.map((caseName) => readExpected(join(FIXTURES, definition.name, caseName)) ?? []);
      expect(
        outputs.some((problems) => problems.length === 0),
        'needs a case with no problems',
      ).toBe(true);
      expect(
        outputs.some((problems) => problems.some((problem) => problem.ruleId === `generators/${fullName(definition)}`)),
        'needs a case that reports the rule',
      ).toBe(true);
    });
  }
});
