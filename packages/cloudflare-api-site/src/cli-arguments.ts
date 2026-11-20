import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** A positional or an option of a cf command. */
export interface CliArgument {
  name: string;
  /** The position of a positional. */
  position?: number;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
}

/** A command of the cf CLI, as its metadata describes it. */
export interface CliCommand {
  /** The command, such as `cf agent-memory recall`. */
  command: string;
  /** The words after `cf`, such as `["agent-memory", "recall"]`. */
  fullPath: string[];
  /** The HTTP method of the operation it sends, in uppercase. */
  httpMethod?: string;
  /** The path template of the operation it sends. */
  apiPath?: string;
  /** The positionals. */
  arguments?: CliArgument[];
  options?: CliArgument[];
}

interface CliMetadata {
  commands: CliCommand[];
}

// The cf package doesn't export its metadata, so it is read from the
// package's directory: `dist/_meta/commands.json` lists every command with the
// positionals and options `cf <command> --help` shows.
function readCliMetadata(file: string): CliMetadata {
  const packageJson = createRequire(import.meta.url).resolve('cf/package.json');
  return JSON.parse(readFileSync(join(dirname(packageJson), 'dist', '_meta', file), 'utf8')) as CliMetadata;
}

const operationKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

let byOperation: Map<string, CliCommand[]> | undefined;

/**
 * The commands cf generates from the API, by the operation they send.
 * Hand-written commands are left out: the site documents them separately.
 */
function commandsByOperation(): Map<string, CliCommand[]> {
  if (byOperation) return byOperation;
  const handWritten = new Set(readCliMetadata('hand-written-commands.json').commands.map((c) => c.command));
  byOperation = new Map();
  for (const command of readCliMetadata('commands.json').commands) {
    if (!command.httpMethod || !command.apiPath || handWritten.has(command.command)) continue;
    const key = operationKey(command.httpMethod, command.apiPath);
    byOperation.set(key, [...(byOperation.get(key) ?? []), command]);
  }
  return byOperation;
}

// The site's accessor paths and method names are the operation's SDK names,
// which cf turns into kebab-case.
const comparable = (words: readonly string[]): string =>
  words
    .join('')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();

/**
 * Returns the cf command that sends the operation `method` `path`, or
 * `undefined` when cf generates none. When several commands send the
 * operation, returns the one named `words`, or else the first.
 */
export function cliCommandFor(method: string, path: string, words: readonly string[]): CliCommand | undefined {
  const commands = commandsByOperation().get(operationKey(method, path));
  if (!commands) return undefined;
  const wanted = comparable(words);
  return commands.find((command) => comparable(command.fullPath) === wanted) ?? commands[0];
}
