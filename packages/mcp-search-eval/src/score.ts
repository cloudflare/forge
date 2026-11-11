import { index, type Listed } from './search.ts';

/** A generated tool: what a client sees, and the method it calls. */
export interface EvalTool extends Listed {
  readonly method: string;
  readonly path: string;
}

/**
 * Something someone wants to do, in their words, and the methods that do it,
 * as `METHOD /path` with the path as forge writes it (a merged
 * `/{account_or_zone}/{account_or_zone_id}/…` path stays merged). Any one of
 * them is a hit.
 */
export interface Task {
  readonly task: string;
  readonly expect: readonly string[];
}

/** Where a task's first expected tool ranked. */
export interface TaskResult {
  readonly task: string;
  readonly expect: readonly string[];
  /** 1-based, or `undefined` when no expected tool ranked in the top {@link LIMIT}. */
  readonly rank: number | undefined;
  /** The tool that ranked first. */
  readonly top: string | undefined;
  /** The expected tools, by name; empty when none was generated. */
  readonly expected: readonly string[];
}

export interface Score {
  readonly tasks: number;
  readonly top1: number;
  readonly top5: number;
  /** Mean reciprocal rank, 0 to 1. */
  readonly mrr: number;
  readonly results: readonly TaskResult[];
}

/** How far down the ranking a task's tool is looked for. */
export const LIMIT = 20;

/** Searches `tools` for each task and scores where its tool ranked. */
export function score(tools: readonly EvalTool[], tasks: readonly Task[]): Score {
  const search = index(tools);
  const results = tasks.map(({ task, expect }): TaskResult => {
    const wanted = new Set(expect);
    const ranked = search(task).slice(0, LIMIT);
    const position = ranked.findIndex((tool) => wanted.has(`${tool.method} ${tool.path}`));
    return {
      task,
      expect,
      rank: position < 0 ? undefined : position + 1,
      top: ranked[0]?.name,
      expected: tools.filter((tool) => wanted.has(`${tool.method} ${tool.path}`)).map((tool) => tool.name),
    };
  });
  const hits = (k: number) => results.filter(({ rank }) => rank !== undefined && rank <= k).length;
  return {
    tasks: results.length,
    top1: hits(1),
    top5: hits(5),
    mrr: results.reduce((sum, { rank }) => sum + (rank ? 1 / rank : 0), 0) / Math.max(results.length, 1),
    results,
  };
}

/** The score as Markdown: the totals, then every task that missed the top 1. */
export function markdown({ tasks, top1, top5, mrr, results }: Score): string {
  const lines = [
    `| Tasks | Top 1 | Top 5 | MRR |`,
    `| ----- | ----- | ----- | --- |`,
    `| ${tasks} | ${top1} | ${top5} | ${mrr.toFixed(2)} |`,
  ];
  const misses = results.filter(({ rank }) => rank !== 1);
  if (misses.length > 0) {
    lines.push('', '| Task | Rank | Expected | Ranked first |', '| ---- | ---- | -------- | ------------ |');
    for (const { task, rank, expected, top } of misses) {
      const want = expected.length > 0 ? expected.map((name) => `\`${name}\``).join(', ') : 'no tool';
      lines.push(`| ${task} | ${rank ?? `>${LIMIT}`} | ${want} | ${top ? `\`${top}\`` : '–'} |`);
    }
  }
  return lines.join('\n');
}
