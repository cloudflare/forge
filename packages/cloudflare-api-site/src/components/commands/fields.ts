import type { ApiFieldView } from '@cloudflare/nimbus-docs/api';
import type { CommandArgument, CommandMetadata, CommandOption } from '../../command-reference/schema.ts';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A command's description as HTML: escaped, its backticks as code, its blank lines as paragraphs. */
export function proseHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`)
    .join('');
}

/** The first sentence of a description, as inline HTML: the rest is on the command's own page. */
export function summaryHtml(text: string): string {
  const first = /^(.+?[.!?])(\s|$)/s.exec(text.trim())?.[1] ?? text.trim();
  return proseHtml(first.replace(/\.$/, '')).replace(/^<p>|<\/p>$/g, '');
}

type Parameter = CommandArgument | CommandOption;

/** An argument (`<name>`) or flag (`--name`) as an API field row. */
function toField(parameter: Parameter, name: string, anchor: string): ApiFieldView {
  return {
    coordinate: `cf:${name}`,
    name,
    type: parameter.type,
    required: parameter.required,
    ...('default' in parameter && parameter.default !== undefined ? { default: parameter.default as never } : {}),
    ...(parameter.enum ? { enum: parameter.enum } : {}),
    descriptionHtml: proseHtml(parameter.description).replace(/^<p>|<\/p>$/g, ''),
    anchor,
    children: [],
    childCount: 0,
    truncated: false,
  };
}

export function argumentFields(command: CommandMetadata): ApiFieldView[] {
  return command.arguments.map((a) => toField(a, `<${a.name}>`, `argument-${a.name}`));
}

export function flagFields(command: CommandMetadata): ApiFieldView[] {
  return command.options.map((o) => toField(o, `--${o.name}`, `flag-${o.name}`));
}
