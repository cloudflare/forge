import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDescription } from './description-markdown.ts';
import { toPlainText } from './plain-text.ts';

test('tags are dropped and whitespace collapses', () => {
  assert.equal(toPlainText('<p>Line one<br>line\n two</p>\n<ul><li>item</li></ul>'), 'Line one line two item');
});

test('named, hex and decimal entities decode', () => {
  assert.equal(toPlainText('&#x3C;key> &amp; &quot;q&quot; &#169; &LT;'), '<key> & "q" © <');
});

test('entities decode once, so escaped entity text stays literal', () => {
  assert.equal(toPlainText('&#x26;lt; and &amp;amp;'), '&lt; and &amp;');
});

test('out-of-range code points stay as written', () => {
  assert.equal(toPlainText('&#x110000;'), '&#x110000;');
});

test('rendered placeholders read as text', () => {
  assert.equal(toPlainText(renderDescription('Set metadata.<key> & more.')), 'Set metadata.<key> & more.');
});
