import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepDroppedHtml, renderDescription } from './description-markdown.ts';

const ASTRO_FERN_PROBE = '<i data-astro-fern-probe></i> [probe](javascript:probe)';

test('placeholders and closing tags outside code render as text', () => {
  assert.equal(renderDescription('Set metadata.<key> to a value.'), '<p>Set metadata.&#x3C;key> to a value.</p>\n');
  assert.equal(
    renderDescription('Uppercase <Key> and closing </Key>.'),
    '<p>Uppercase &#x3C;Key> and closing &#x3C;/Key>.</p>\n',
  );
});

test('placeholders inside code are left alone', () => {
  for (const markdown of [
    'Code `metadata.<key>` stays.',
    '```\nmetadata.<key>\n```',
    '~~~\nmetadata.<key>\n~~~',
    'Para\n\n    metadata.<key>\n\nafter',
  ]) {
    assert.equal(keepDroppedHtml(markdown), markdown);
  }
});

test('a leading indent or blank lines are trimmed, as Nimbus does, so the comment is escaped', () => {
  assert.equal(keepDroppedHtml('    <!--sse--> leading indent'), '&lt;!--sse--> leading indent');
  assert.equal(keepDroppedHtml('\n\n<!--sse--> after blank lines'), '&lt;!--sse--> after blank lines');
});

test('escaped backticks around a placeholder still escape it', () => {
  assert.equal(renderDescription('Escaped \\`<key>\\` backticks'), '<p>Escaped `&#x3C;key>` backticks</p>\n');
});

test('already-escaped placeholders, autolinks and angle-bracket links are unchanged', () => {
  for (const markdown of [
    'Already \\<key> escaped',
    'Autolink <https://www.cloudflare.com/learning/dns/dns-records/dns-txt-record/> ok',
    'Link [a](<https://x>) ok',
  ]) {
    assert.equal(keepDroppedHtml(markdown), markdown);
  }
  assert.match(
    renderDescription('<https://www.cloudflare.com/learning/dns/dns-records/dns-txt-record/>'),
    /<a href="https:\/\/www\.cloudflare\.com\/learning\/dns\/dns-records\/dns-txt-record\/">/,
  );
});

test('HTML comments render as text', () => {
  assert.equal(
    renderDescription('SSE tags: <!--sse--><!--/sse-->. For example: x'),
    '<p>SSE tags: &#x3C;!--sse-->&#x3C;!--/sse-->. For example: x</p>\n',
  );
});

test('a placeholder inside a raw HTML block renders as text', () => {
  assert.equal(renderDescription('<pre>\nmetadata.<key>\n</pre>'), '<pre>metadata.&#x3C;key>\n</pre>\n');
});

test('allowed tags still render, including a placeholder named like one', () => {
  assert.equal(renderDescription('Line one<br/>line two'), '<p>Line one<br>line two</p>\n');
  assert.equal(renderDescription('metadata.<b>bold</b>'), '<p>metadata.<b>bold</b></p>\n');
});

test('offsets count string characters, so text before a comment can be non-ASCII', () => {
  assert.equal(keepDroppedHtml('Ünïcödé — “quotes” then <!--sse-->'), 'Ünïcödé — “quotes” then &lt;!--sse-->');
});

test('unsafe HTML and links stay inert', () => {
  assert.equal(renderDescription('<script>alert(1)</script>'), '<p>&#x3C;script>alert(1)&#x3C;/script></p>\n');
  assert.equal(renderDescription('<img src=x onerror=alert(1)>'), '<img src="x">\n');
  assert.equal(renderDescription('[click](javascript:alert(1))'), '<p><a>click</a></p>\n');
});

test("astro-fern's sanitizer probe passes", () => {
  const html = renderDescription(ASTRO_FERN_PROBE);
  assert.doesNotMatch(html, /<i\b[^>]*data-astro-fern-probe/i);
  assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i);
});
