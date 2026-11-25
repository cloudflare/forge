import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiAuthView } from '@cloudflare/nimbus-docs/api';
import { authSection } from './components/ui/api-layout/auth.ts';

const scheme = (name: string, scopes: string[] = []): ApiAuthView =>
  ({ scheme: name, type: 'apiKey', in: 'header', headerName: name, scopes }) as ApiAuthView;
const token = scheme('api_token');
const email = scheme('api_email');
const key = scheme('api_key');

test('one alternative lists its schemes, each required', () => {
  const section = authSection([[email, key, token]]);
  assert.equal(section.union, undefined);
  assert.deepEqual(
    section.fields.map((f) => [f.name, f.required]),
    [
      ['api_email', true],
      ['api_key', true],
      ['api_token', true],
    ],
  );
  assert.equal(section.optional, false);
});

test('several alternatives are one option each, listed once', () => {
  const section = authSection([[token], [email, key], [email, key]]);
  assert.deepEqual(section.fields, []);
  assert.deepEqual(
    section.union!.variants.map((v) => v.label),
    ['api_token', 'api_email and api_key'],
  );
  assert.ok(section.union!.variants.every((v) => v.fields!.every((f) => f.required)));
});

test('a scheme in two alternatives keeps its scopes in each, with an anchor of its own', () => {
  const section = authSection([[scheme('oauth', ['read'])], [scheme('oauth', ['write']), key]]);
  const fields = section.union!.variants.flatMap((v) => v.fields!);
  assert.deepEqual(
    fields.map((f) => f.anchor),
    ['auth-oauth', 'auth-oauth-2', 'auth-api_key'],
  );
  assert.match(fields[0]!.descriptionHtml!, /read/);
  assert.match(fields[1]!.descriptionHtml!, /write/);
});

test('an empty alternative makes the section optional', () => {
  assert.equal(authSection([[token], []]).optional, true);
  assert.deepEqual(authSection([]).fields, []);
});
