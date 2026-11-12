import type { CommandArgument, CommandMetadata, CommandOption } from './command-reference/schema.ts';
import { commandTitle } from './command-reference/routing.ts';

function parameterLine(kind: 'argument' | 'option', parameter: CommandArgument | CommandOption): string {
  const name = kind === 'option' ? `--${parameter.name}` : `<${parameter.name}>`;
  const lines = [
    `- \`${name}\` (${parameter.type}, ${parameter.required ? 'required' : 'optional'})${parameter.description ? ` — ${parameter.description}` : ''}`,
  ];
  const details: string[] = [];
  if ('default' in parameter && parameter.default !== undefined) {
    details.push(`default: \`${JSON.stringify(parameter.default)}\``);
  }
  if (parameter.enum)
    details.push(`allowed: ${parameter.enum.map((value) => `\`${JSON.stringify(value)}\``).join(', ')}`);
  if (details.length > 0) lines.push(`  - ${details.join(' · ')}`);
  return lines.join('\n');
}

/** A cf command page as Markdown, in the shape of the API pages' Markdown versions. */
export function commandMarkdown(command: CommandMetadata, llmsUrl: string): string {
  const title = commandTitle(command);
  const parts = [
    `---\ntitle: ${JSON.stringify(title)}\n---`,
    `> Documentation Index\n> Fetch the complete documentation index at: ${llmsUrl}\n> Use this file to discover all available pages before exploring further.`,
    `# ${title}`,
    `\`\`\`sh\n${command.usage}\n\`\`\``,
    command.description,
  ];
  if (command.arguments.length > 0) {
    parts.push(
      `## Arguments\n\n${command.arguments.map((argument) => parameterLine('argument', argument)).join('\n')}`,
    );
  }
  if (command.options.length > 0) {
    parts.push(`## Options\n\n${command.options.map((option) => parameterLine('option', option)).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
