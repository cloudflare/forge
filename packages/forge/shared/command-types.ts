/**
 * CLI Command Metadata Types
 *
 * Shared type definitions for command metadata used by both the CLI help system
 * and transformer code generators. Lives in @cloudflare/forge to avoid cross-package
 * boundary violations.
 */

/**
 * Metadata for a single CLI argument (positional parameter).
 */
export interface ArgumentMeta {
  /** Argument name */
  name: string;
  /** Zero-based position in the command */
  position: number;
  /** Data type */
  type: 'string' | 'number' | 'boolean';
  /** Whether the argument is required */
  required: boolean;
  /** Human-readable description */
  description: string;
  /** Allowed values for enumerated types */
  enum?: string[];
  /** Dynamic completion source for this argument */
  completion?: { type: 'dynamic'; operation: string; displayField: string };
}

/**
 * Metadata for a single CLI option (flag).
 */
export interface OptionMeta {
  /** Option name (without dashes) */
  name: string;
  /** Data type */
  type: 'string' | 'number' | 'boolean';
  /** Whether the option is required */
  required: boolean;
  /** Default value if not provided */
  default?: unknown;
  /** Human-readable description */
  description: string;
  /** Allowed values for enumerated types */
  enum?: string[];
}

/**
 * Metadata for a command example.
 */
export interface ExampleMeta {
  /** Brief description of what the example demonstrates */
  description: string;
  /** The full command to run */
  command: string;
}

/**
 * Complete metadata for a CLI command.
 * Used by the help formatter to generate brief, full, and agent help.
 */
export interface CommandMeta {
  /** Full command string (e.g., "cf dns records create") */
  command: string;
  /** Command name (e.g., "create") */
  name: string;
  /** Path segments (e.g., ["dns", "records", "create"]) */
  fullPath: string[];
  /** Human-readable description */
  description: string;
  /** Usage string showing syntax */
  usage: string;
  /** Positional arguments */
  arguments: ArgumentMeta[];
  /** Command-specific options */
  options: OptionMeta[];
  /** Method category (read, create, update, delete, action) */
  category?: 'read' | 'create' | 'update' | 'delete' | 'action';
  /** HTTP method (GET, POST, PUT, PATCH, DELETE) */
  httpMethod?: string;
  /** API path template (e.g., /zones/{zone_id}/dns_records) */
  apiPath?: string;
  /** OpenAPI operation ID */
  operationId?: string;
  /** Whether the operation accepts a request body */
  hasRequestBody?: boolean;
  /** Whether this command is hidden by default (requires CF_HIDE_COMMANDS=false to show) */
  hideCommand?: boolean;
}
