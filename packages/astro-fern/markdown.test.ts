import assert from 'node:assert/strict';
import { test } from 'node:test';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownToHtml } from 'satteri';
import { installFernMarkdownSanitizer, sanitizeFernMarkdownPlugin } from './markdown.ts';

test('the Satteri plugin neutralizes raw HTML and executable Markdown URLs', () => {
  const result = markdownToHtml(
    'safe **bold** <img src=x onerror=alert(1)> <script>alert(2)</script> [unsafe](javascript:alert(3)) `code <tag>`',
    { mdastPlugins: [sanitizeFernMarkdownPlugin] },
  );

  assert.match(result.html, /<strong>bold<\/strong>/);
  assert.match(result.html, /href="#"/);
  assert.match(result.html, /<code>code &lt;tag&gt;<\/code>/);
  assert.doesNotMatch(result.html, /<img|<script|href="javascript:/);
});

test('installs the sanitizer once on a Satteri processor', () => {
  const processor = satteri();
  assert.equal(installFernMarkdownSanitizer(processor), true);
  assert.equal(installFernMarkdownSanitizer(processor), true);
  assert.deepEqual(processor.options.mdastPlugins, [sanitizeFernMarkdownPlugin]);
});
