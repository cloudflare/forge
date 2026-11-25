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

/** The tooling directory as Markdown: the commands `cf` implements itself, by group, each linking to its own Markdown. */
export function commandDirectoryMarkdown(
  commands: readonly CommandMetadata[],
  descriptions: Readonly<Record<string, string>>,
  href: (command: CommandMetadata) => string,
  llmsUrl: string,
): string {
  const line = (command: CommandMetadata) =>
    `- [\`${command.command}\`](${href(command)}) — ${command.description.split('\n')[0]}`;
  const groups = new Map<string, CommandMetadata[]>();
  for (const command of commands) {
    const group = command.fullPath.length === 1 ? '' : command.fullPath[0]!;
    groups.set(group, [...(groups.get(group) ?? []), command]);
  }
  const parts = [
    `---\ntitle: "Developer Tooling"\n---`,
    `> Documentation Index\n> Fetch the complete documentation index at: ${llmsUrl}\n> Use this file to discover all available pages before exploring further.`,
    '# Developer Tooling',
    '```sh\ncf --help\n```',
    'Commands built into `cf` itself, rather than generated from the API. API operations have `cf` commands too, in their code samples.',
    ...[...groups].map(([group, members]) => {
      const title = group ? commandTitle({ name: group }) : 'Commands';
      const description = group && descriptions[group] ? `\n\n${descriptions[group]}` : '';
      return `## ${title}${description}\n\n${members.map(line).join('\n')}`;
    }),
  ];
  return `${parts.join('\n\n')}\n`;
}
