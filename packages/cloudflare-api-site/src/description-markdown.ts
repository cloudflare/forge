import { renderMarkdown } from '@cloudflare/nimbus-docs/markdown';
import { defaultSchema } from 'hast-util-sanitize';
import { markdownToMdast } from 'satteri';

interface MdastNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdastNode[];
}

const DROPPED_TAGS = new Set((defaultSchema.strip ?? []).map((name) => name.toLowerCase()));
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

function htmlRanges(node: MdastNode, ranges: [number, number][]): [number, number][] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (node.type === 'html' && start !== undefined && end !== undefined) ranges.push([start, end]);
  for (const child of node.children ?? []) htmlRanges(child, ranges);
  return ranges;
}

function escapeDroppedTags(html: string): string {
  return html.replace(/</g, (lt, offset: number) => {
    const name = TAG_NAME.exec(html.slice(offset))?.[1]?.toLowerCase();
    return name === undefined || DROPPED_TAGS.has(name) ? '&lt;' : lt;
  });
}

// Nimbus keeps unknown tags such as `metadata.<key>` as text but drops comments and `<script>`, which some descriptions use as text.
export function keepDroppedHtml(markdown: string): string {
  const trimmed = markdown.trim();
  let tree: MdastNode;
  try {
    tree = markdownToMdast(trimmed, { position: true }) as MdastNode;
  } catch {
    return trimmed;
  }
  let result = trimmed;
  for (const [start, end] of htmlRanges(tree, []).sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + escapeDroppedTags(result.slice(start, end)) + result.slice(end);
  }
  return result;
}

export const renderDescription = (markdown: string): string => renderMarkdown(keepDroppedHtml(markdown));
