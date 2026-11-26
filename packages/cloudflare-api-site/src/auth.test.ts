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
    ['API Token', 'API Email + API Key'],
  );
  assert.ok(section.union!.variants.every((v) => v.fields!.every((f) => f.required)));
});

test("each field is the header it sends, with production's description of Cloudflare's schemes", () => {
  const bearer = { scheme: 'api_token', type: 'http', httpScheme: 'bearer', headerName: 'Authorization', scopes: [] };
  const emailHeader = { scheme: 'api_email', type: 'apiKey', in: 'header', headerName: 'X-Auth-Email', scopes: [] };
  const section = authSection([[bearer as ApiAuthView], [emailHeader as ApiAuthView]]);
  const [tokenField, emailField] = section.union!.variants.flatMap((v) => v.fields!);

  assert.equal(tokenField!.name, 'Authorization');
  assert.equal(tokenField!.anchor, 'auth-api_token');
  assert.match(tokenField!.descriptionHtml!, /Authorization: Bearer &#60;token&#62;/);
  assert.match(tokenField!.descriptionHtml!, /The preferred authorization scheme/);
  assert.equal(emailField!.name, 'X-Auth-Email');
  assert.match(emailField!.descriptionHtml!, /X-Auth-Email: &#60;email&#62;/);
});

test('a scheme without a description shows its key', () => {
  const section = authSection([[scheme('oauth')], [key]]);
  assert.deepEqual(
    section.union!.variants.map((v) => v.label),
    ['oauth', 'API Key'],
  );
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
