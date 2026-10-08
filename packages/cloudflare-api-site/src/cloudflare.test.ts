import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { SnippetInput, SnippetOperation } from 'astro-fern';
import { buildDocsModel, type OpenApiDocumentSchema } from 'astro-fern/content';
import { forgeExtension } from 'fern-forge';
import {
  CLOUDFLARE_TARGETS,
  cloudflareFormatIdentifier,
  cloudflareOperationRoutingPreference,
  cloudflareSnippets,
  cloudflareSnippetsByTarget,
} from './cloudflare.ts';

function op(partial: Partial<SnippetOperation> = {}): SnippetOperation {
  return {
    path: '/zones/{zone_id}/dns_records',
    method: 'get',
    pathParams: [{ name: 'zone_id', required: true, type: 'string' }],
    queryParams: [],
    ...partial,
  };
}

const listInput: SnippetInput = { op: op(), accessorPath: ['dns', 'records'], methodName: 'list' };
const queryInput: SnippetInput = {
  ...listInput,
  op: op({
    queryParams: [
      { name: 'type', required: true, type: 'string', enumValues: ['A', 'AAAA'] },
      { name: 'page', required: false, type: 'integer' },
    ],
  }),
};
const createInput: SnippetInput = {
  op: op({
    method: 'post',
    requestBody: {
      required: true,
      representations: [
        {
          mediaType: 'application/json',
          schema: {
            name: '',
            required: true,
            type: 'object',
            children: [
              { name: 'name', required: true, type: 'string', apiFieldPath: ['name'] },
              {
                name: 'type',
                required: true,
                type: 'string',
                apiFieldPath: ['type'],
                enumValues: ['A', 'AAAA'],
              },
              { name: 'comment', required: false, type: 'string', apiFieldPath: ['comment'] },
            ],
          },
        },
      ],
    },
  }),
  accessorPath: ['dns', 'records'],
  methodName: 'create',
};

const nestedCreateInput: SnippetInput = {
  ...createInput,
  op: op({
    method: 'post',
    requestBody: {
      required: true,
      representations: [
        {
          mediaType: 'application/json',
          schema: {
            name: '',
            required: true,
            type: 'object',
            children: [
              {
                name: 'settings',
                required: true,
                type: 'object',
                children: [{ name: 'enabled', required: true, type: 'boolean' }],
              },
              {
                name: 'rules',
                required: true,
                type: 'array',
                items: {
                  name: '',
                  required: false,
                  type: 'object',
                  children: [{ name: 'action', required: true, type: 'string', enumValues: ['block'] }],
                },
              },
            ],
          },
        },
      ],
    },
  }),
};

test('Cloudflare routing temporarily prefers approved account operations over zone operations', () => {
  const source = (accountHidden: boolean): OpenApiDocumentSchema => ({
    paths: {
      '/accounts/{account_id}/media/usage': {
        get: {
          operationId: 'usage-analytics-get-account-media-usage',
          tags: ['Usage Analytics'],
          'x-fern-sdk-group-name': 'media.usage',
          'x-fern-sdk-method-name': 'get',
          'x-forge-hidden': accountHidden,
        },
      },
      '/zones/{zone_id}/media/usage': {
        get: {
          operationId: 'usage-analytics-get-zone-media-usage',
          tags: ['Usage Analytics'],
          'x-fern-sdk-group-name': 'media.usage',
          'x-fern-sdk-method-name': 'get',
        },
      },
    },
  });
  const build = (accountHidden: boolean) =>
    buildDocsModel({
      source: source(accountHidden),
      products: [{ id: 'media', sdkGroup: 'media', sections: [{ id: 'usage', tag: 'Usage Analytics' }] }],
      extensions: [forgeExtension()],
      operationRoutingPreference: cloudflareOperationRoutingPreference,
      onWarning: () => {},
    });

  assert.equal(
    build(false).products[0]?.sections[0]?.operations[0]?.operationId,
    'usage-analytics-get-account-media-usage',
  );
  assert.equal(
    build(true).products[0]?.sections[0]?.operations[0]?.operationId,
    'usage-analytics-get-zone-media-usage',
  );
});

const rootArrayCreateInput: SnippetInput = {
  ...createInput,
  op: op({
    method: 'post',
    requestBody: {
      required: true,
      representations: [
        {
          mediaType: 'application/json',
          schema: {
            name: '',
            required: true,
            type: 'object[]',
            items: {
              name: '',
              required: false,
              type: 'object',
              children: [{ name: 'id', required: true, type: 'string' }],
            },
          },
        },
      ],
    },
  }),
};

const rootUnionCreateInput: SnippetInput = {
  ...createInput,
  op: op({
    method: 'post',
    requestBody: {
      required: true,
      representations: [
        {
          mediaType: 'application/merge-patch+json',
          schema: {
            name: '',
            required: true,
            type: 'object | string',
            variants: [
              {
                name: '',
                required: false,
                type: 'object',
                children: [{ name: 'source', required: true, type: 'string' }],
              },
              { name: '', required: false, type: 'string' },
            ],
          },
        },
      ],
    },
  }),
};

test('curl: GET interpolates path params as $ENV and adds the bearer header', () => {
  const curl = cloudflareSnippetsByTarget(listInput).get('curl');
  assert.ok(curl);
  assert.match(curl, /^curl https:\/\/api\.cloudflare\.com\/client\/v4\/zones\/\$ZONE_ID\/dns_records \\/);
  assert.match(curl, /-H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN"/);
  assert.doesNotMatch(curl, /-X GET/);
  assert.doesNotMatch(curl, /Content-Type/);
});

test('curl: POST adds verb, content-type and a body built from required leaves', () => {
  const curl = cloudflareSnippetsByTarget(createInput).get('curl');
  assert.ok(curl);
  assert.match(curl, /curl -X POST/);
  assert.match(curl, /-H 'Content-Type: application\/json'/);
  const match = curl.match(/-d '(.+)'/);
  const payload = match?.[1];
  assert.ok(payload, 'expected a non-empty -d body');
  assert.deepEqual(JSON.parse(payload), { name: '<name>', type: 'A' });
});

test('optional request bodies remain present in examples when the endpoint declares one', () => {
  const optionalInput: SnippetInput = {
    ...createInput,
    op: {
      ...createInput.op,
      requestBody: createInput.op.requestBody ? { ...createInput.op.requestBody, required: false } : undefined,
    },
  };
  const snippets = cloudflareSnippetsByTarget(optionalInput);
  const curl = snippets.get('curl');
  const cf = snippets.get('cf');
  const ts = snippets.get('typescript');
  assert.ok(curl && ts);
  assert.equal(cf, null);
  assert.match(curl, /Content-Type: application\/json/);
  assert.match(curl, /-d /);
  assert.match(ts, /name: "<name>"/);
  assert.match(ts, /type: "A"/);
});

test('curl shell-quotes apostrophes in request media types and JSON bodies', () => {
  const mediaType = "application/json; profile=owner's";
  const input: SnippetInput = {
    ...createInput,
    op: op({
      method: 'post',
      requestBody: {
        required: true,
        representations: [
          {
            mediaType,
            schema: {
              name: '',
              required: true,
              type: 'object',
              children: [{ name: 'name', required: true, type: 'string', enumValues: ["owner's widget"] }],
            },
          },
        ],
      },
    }),
  };

  const curl = cloudflareSnippetsByTarget(input).get('curl');
  assert.ok(curl);
  assert.ok(curl.includes(`-H 'Content-Type: application/json; profile=owner'"'"'s'`));
  assert.ok(curl.includes(`"name":"owner'"'"'s widget"`));
  const syntax = spawnSync('sh', ['-n'], { input: curl, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('curl uses file input for raw bodies and does not fabricate required multipart bodies', () => {
  const raw: SnippetInput = {
    ...createInput,
    op: op({
      method: 'post',
      requestBody: {
        required: true,
        representations: [{ mediaType: 'application/octet-stream' }],
      },
    }),
  };
  const multipart: SnippetInput = {
    ...raw,
    op: op({
      method: 'post',
      requestBody: {
        required: true,
        representations: [{ mediaType: 'multipart/form-data', schema: { name: '', required: true, type: 'object' } }],
      },
    }),
  };

  const rawSnippets = cloudflareSnippetsByTarget(raw);
  assert.match(rawSnippets.get('curl') ?? '', /Content-Type: application\/octet-stream/);
  assert.match(rawSnippets.get('curl') ?? '', /--data-binary @request-body/);
  for (const target of ['cf', 'typescript', 'python', 'ruby']) assert.equal(rawSnippets.get(target), null);
  assert.equal(cloudflareSnippetsByTarget(multipart).get('curl'), null);
});

test('curl: includes required query params and omits optional query params', () => {
  const curl = cloudflareSnippetsByTarget(queryInput).get('curl');
  assert.ok(curl);
  assert.match(curl, /--url-query "type=\$TYPE"/);
  assert.doesNotMatch(curl, /page=/);
});

test('dated versions intentionally retain version-neutral snippets while upstream does not enforce versions', () => {
  const snippets = cloudflareSnippetsByTarget({ ...listInput, snapshotId: '2027-01-01.air' });
  for (const target of ['curl', 'cf', 'typescript', 'python', 'ruby']) {
    assert.equal(typeof snippets.get(target), 'string');
    assert.doesNotMatch(snippets.get(target) ?? '', /api-version/);
  }
});

test('nested body values remain structured in curl and SDK samples', () => {
  const snippets = cloudflareSnippetsByTarget(nestedCreateInput);
  const curl = snippets.get('curl');
  const ts = snippets.get('typescript');
  const py = snippets.get('python');
  const rb = snippets.get('ruby');
  assert.ok(curl && ts && py && rb);
  const payload = curl.match(/-d '(.+)'/)?.[1];
  assert.ok(payload);
  assert.deepEqual(JSON.parse(payload), { settings: { enabled: true }, rules: [{ action: 'block' }] });
  assert.match(ts, /settings: {"enabled":true}/);
  assert.match(ts, /rules: \[{"action":"block"}\]/);
  assert.match(py, /settings={"enabled": True}/);
  assert.match(py, /rules=\[{"action": "block"}\]/);
  assert.match(rb, /settings: {"enabled" => true}/);
  assert.match(rb, /rules: \[{"action" => "block"}\]/);
});

test('SDK property aliases resolve argument collisions without changing HTTP wire fields', () => {
  const input: SnippetInput = {
    accessorPath: ['accounts'],
    methodName: 'create',
    op: {
      path: '/accounts/{account_id}',
      method: 'post',
      pathParams: [{ name: 'account_id', required: true, type: 'string' }],
      queryParams: [],
      requestBody: {
        required: true,
        representations: [
          {
            mediaType: 'application/json',
            schema: {
              name: '',
              required: true,
              type: 'object',
              children: [
                {
                  name: 'account_id',
                  sdkName: 'account_id_body',
                  required: true,
                  type: 'number',
                  apiFieldPath: ['account_id'],
                },
                {
                  name: 'settings',
                  required: true,
                  type: 'object',
                  apiFieldPath: ['settings'],
                  children: [
                    {
                      name: 'account_id',
                      sdkName: 'nested_account_id',
                      required: true,
                      type: 'number',
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  };
  const snippets = cloudflareSnippetsByTarget(input);
  const curlPayload = snippets.get('curl')?.match(/-d '(.+)'/)?.[1];
  const ts = snippets.get('typescript');
  assert.ok(curlPayload && ts);
  assert.deepEqual(JSON.parse(curlPayload), { account_id: 0, settings: { account_id: 0 } });
  assert.match(ts, /account_id: "<account_id>"/);
  assert.match(ts, /account_id_body: 0/);
  assert.match(ts, /settings: {"nested_account_id":0}/);
});

test('root array and union bodies render structurally in curl and suppress unsupported SDK samples', () => {
  const arraySnippets = cloudflareSnippetsByTarget(rootArrayCreateInput);
  const unionSnippets = cloudflareSnippetsByTarget(rootUnionCreateInput);
  const arrayPayload = arraySnippets.get('curl')?.match(/-d '(.+)'/)?.[1];
  const unionPayload = unionSnippets.get('curl')?.match(/-d '(.+)'/)?.[1];
  assert.ok(arrayPayload && unionPayload);
  assert.deepEqual(JSON.parse(arrayPayload), [{ id: '<id>' }]);
  assert.deepEqual(JSON.parse(unionPayload), { source: '<source>' });
  for (const target of ['typescript', 'python', 'ruby']) {
    assert.equal(arraySnippets.get(target), null);
    assert.equal(unionSnippets.get(target), null);
  }
});

test('typescript: builds the accessor chain and required-arg object', () => {
  const ts = cloudflareSnippetsByTarget(listInput).get('typescript');
  assert.ok(ts);
  const target = CLOUDFLARE_TARGETS.find((candidate) => candidate.id === 'typescript');
  assert.ok(target?.packageName);
  assert.ok(ts.includes(`from "${target.packageName}"`));
  assert.match(ts, /new CloudflareApiClient\(\)/);
  assert.match(ts, /await client\.dns\.records\.list\(/);
  assert.match(ts, /zone_id: "<zone_id>"/);
});

test('SDKs include required query params and omit optional query params', () => {
  const snippets = cloudflareSnippetsByTarget(queryInput);
  const ts = snippets.get('typescript');
  const py = snippets.get('python');
  const rb = snippets.get('ruby');
  assert.ok(ts && py && rb);
  assert.match(ts, /type: "A"/);
  assert.match(py, /type="A"/);
  assert.match(rb, /type: "A"/);
  for (const snippet of [ts, py, rb]) assert.doesNotMatch(snippet, /page[=:]/);
});

test('typescript: normalizes hyphenated Fern group and method names to lower camel case', () => {
  const ts = cloudflareSnippetsByTarget({
    ...listInput,
    accessorPath: ['dns', 'zone-transfers', 'primary-zones'],
    methodName: 'force-notify',
  }).get('typescript');
  assert.match(ts ?? '', /client\.dns\.zoneTransfers\.primaryZones\.forceNotify\(/);
});

test('cf: positionals are the path params', () => {
  assert.equal(cloudflareSnippetsByTarget(listInput).get('cf'), 'cf dns records list <zone_id>');
});

test('cf: omits commands that require unsupported flags or request bodies', () => {
  assert.equal(cloudflareSnippetsByTarget(queryInput).get('cf'), null);
  assert.equal(cloudflareSnippetsByTarget(createInput).get('cf'), null);
});

test('python: snake_cased accessor with keyword args', () => {
  const py = cloudflareSnippetsByTarget(listInput).get('python');
  assert.ok(py);
  assert.match(py, /from cloudflare import Cloudflare/);
  assert.match(py, /result = client\.dns\.records\.list\(/);
  assert.match(py, /zone_id="<zone_id>"/);
});

test('ruby: snake_cased accessor with hash args', () => {
  const rb = cloudflareSnippetsByTarget(listInput).get('ruby');
  assert.ok(rb);
  assert.match(rb, /Cloudflare::Client\.new/);
  assert.match(rb, /result = client\.dns\.records\.list\(/);
  assert.match(rb, /zone_id: "<zone_id>"/);
});

test('provider renders every target in tab order; go/terraform are coming-soon', () => {
  const snippets = cloudflareSnippets(listInput);
  assert.deepEqual(
    snippets.map((snippet) => snippet.targetId),
    CLOUDFLARE_TARGETS.map((target) => target.id),
  );
  for (const target of ['curl', 'cf', 'typescript', 'python', 'ruby']) {
    assert.equal(typeof snippets.find((snippet) => snippet.targetId === target)?.code, 'string');
  }
  for (const target of ['go', 'terraform']) {
    assert.equal(snippets.find((snippet) => snippet.targetId === target)?.code, null);
  }
});

test('formatIdentifier is acronym-aware and title-cases the rest', () => {
  assert.equal(cloudflareFormatIdentifier('dns'), 'DNS');
  assert.equal(cloudflareFormatIdentifier('dns_records'), 'DNS Records');
  assert.equal(cloudflareFormatIdentifier('zone-transfers'), 'Zone Transfers');
  assert.equal(cloudflareFormatIdentifier('acls'), 'ACLs');
  assert.equal(cloudflareFormatIdentifier('widgets'), 'Widgets');
});
