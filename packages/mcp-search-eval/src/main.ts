/**
 * Scores how findable the tools forge generated are: searches them for each
 * task and prints where its tool ranked, as Markdown.
 *
 *   node --import ./src/register.ts src/main.ts <generated tools dir> [tasks.json] [--json] [--min-top5 <share>]
 *
 * The directory is what `forge <spec> --target mcp --out <dir>` writes. With
 * `--min-top5`, it exits 1 when fewer than that share of tasks rank their
 * tool in the top 5, for CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { markdown, score, type EvalTool, type Task } from './score.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean' }, 'min-top5': { type: 'string' } },
});
const [dir, tasksFile = new URL('../tasks/cloudflare.json', import.meta.url).pathname] = positionals;
if (!dir) {
  console.error('usage: main.ts <generated tools dir> [tasks.json] [--json] [--min-top5 <share>]');
  process.exit(2);
}

type Generated = { name: string; title?: string; description?: string };
const generated = (await import(pathToFileURL(resolve(dir, 'index.ts')).href)) as {
  tools: readonly Generated[];
  operation: (tool: Generated) => { method: string; path: string };
};
// Search what a client sees, and match on the method each tool calls.
const tools: EvalTool[] = generated.tools.map((tool) => {
  const { method, path } = generated.operation(tool);
  return {
    name: tool.name,
    ...(tool.title !== undefined && { title: tool.title }),
    ...(tool.description !== undefined && { description: tool.description }),
    method,
    path,
  };
});
const tasks = JSON.parse(readFileSync(tasksFile, 'utf8')) as Task[];
const result = score(tools, tasks);

console.log(values.json ? JSON.stringify(result, null, 2) : markdown(result));
const min = values['min-top5'] === undefined ? undefined : Number(values['min-top5']);
if (min !== undefined && result.top5 < min * result.tasks) {
  console.error(`top 5 hit ${result.top5} of ${result.tasks}, below ${min}`);
  process.exit(1);
}
