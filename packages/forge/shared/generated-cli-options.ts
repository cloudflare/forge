/**
 * Generated CLI Option Definitions
 *
 * Single source of truth for options injected into generated CLI commands.
 * Consumed by transformers (command generation, shell tab-completion,
 * and metadata generation).
 */

export interface GeneratedOption {
  name: string;
  alias?: string;
  type: 'string' | 'boolean' | 'number';
  description: string;
  default?: string | boolean | number;
}

/**
 * Options added to EVERY generated command.
 * All output is JSON by default. These options control output filtering and format.
 */
export const UNIVERSAL_OPTIONS = [
  {
    name: 'fields',
    type: 'string',
    description: 'Comma-separated list of fields to include in output',
  },
  {
    name: 'ndjson',
    type: 'boolean',
    description: 'Output as newline-delimited JSON (one object per line)',
    default: false,
  },
] as const satisfies readonly GeneratedOption[];

/**
 * Options added only to mutating commands (POST, PUT, PATCH, DELETE).
 */
export const MUTATING_OPTIONS = [
  {
    name: 'dry-run',
    type: 'boolean',
    description: 'Validate and show what would happen without executing',
    default: false,
  },
] as const satisfies readonly GeneratedOption[];

/**
 * Options added only to commands with request bodies (POST, PUT, PATCH).
 */
export const BODY_OPTIONS = [
  {
    name: 'body',
    type: 'string',
    description: 'Raw JSON request body (bypasses individual flags)',
  },
] as const satisfies readonly GeneratedOption[];

/**
 * Options added only to commands with non-JSON request bodies (multipart/form-data, application/octet-stream, etc.).
 * These commands accept file input instead of (or in addition to) raw JSON --body.
 */
export const FILE_OPTIONS = [
  {
    name: 'file',
    type: 'string',
    description: 'Path to a file to upload as the request body',
  },
] as const satisfies readonly GeneratedOption[];

/**
 * CLI-level global options for completions generation.
 * These are the hand-written options that apply to every command.
 */
export const GLOBAL_OPTIONS = [
  { name: 'quiet', alias: 'q', type: 'boolean', description: 'Suppress non-essential output' },
  { name: 'account-id', alias: 'a', type: 'string', description: 'Cloudflare account ID' },
  { name: 'zone', alias: 'z', type: 'string', description: 'Cloudflare zone name or ID' },
  { name: 'help', alias: 'h', type: 'boolean', description: 'Show help' },
  { name: 'version', alias: 'v', type: 'boolean', description: 'Show version' },
] as const satisfies readonly GeneratedOption[];

/**
 * Hand-written command tree for shell completions.
 * Keys are parent command paths, values are child command names.
 * Generated commands are merged into this tree by the completions transformer.
 */
export const HAND_WRITTEN_COMMANDS: Record<string, readonly string[]> = {
  '': ['auth', 'completions', 'context', 'schema', 'agent-context'],
  auth: ['login', 'logout', 'whoami'],
  completions: ['install', 'uninstall'],
  context: ['show', 'set', 'clear'],
} as const;
