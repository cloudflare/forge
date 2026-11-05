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
  assert.ok(curl);
  assert.match(curl, /Content-Type: application\/json/);
  assert.match(curl, /-d /);
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
  for (const target of ['curl', 'cf']) {
    assert.equal(typeof snippets.get(target), 'string');
    assert.doesNotMatch(snippets.get(target) ?? '', /api-version/);
  }
});

test('nested body values remain structured in curl samples', () => {
  const curl = cloudflareSnippetsByTarget(nestedCreateInput).get('curl');
  assert.ok(curl);
  const payload = curl.match(/-d '(.+)'/)?.[1];
  assert.ok(payload);
  assert.deepEqual(JSON.parse(payload), { settings: { enabled: true }, rules: [{ action: 'block' }] });
});

test('SDK property aliases do not change HTTP wire fields', () => {
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
  const curlPayload = cloudflareSnippetsByTarget(input)
    .get('curl')
    ?.match(/-d '(.+)'/)?.[1];
  assert.ok(curlPayload);
  assert.deepEqual(JSON.parse(curlPayload), { account_id: 0, settings: { account_id: 0 } });
});

test('root array and union bodies render structurally in curl', () => {
  const arraySnippets = cloudflareSnippetsByTarget(rootArrayCreateInput);
  const unionSnippets = cloudflareSnippetsByTarget(rootUnionCreateInput);
  const arrayPayload = arraySnippets.get('curl')?.match(/-d '(.+)'/)?.[1];
  const unionPayload = unionSnippets.get('curl')?.match(/-d '(.+)'/)?.[1];
  assert.ok(arrayPayload && unionPayload);
  assert.deepEqual(JSON.parse(arrayPayload), [{ id: '<id>' }]);
  assert.deepEqual(JSON.parse(unionPayload), { source: '<source>' });
});

// The cf samples come from the metadata of the cf package the site depends on.

test('cf: renders the command with the positionals and options it requires', () => {
  const recall: SnippetInput = {
    op: op({
      path: '/accounts/{account_id}/agent-memory/namespaces/{namespace_name}/profiles/{profile_name}/recall',
      method: 'post',
    }),
    accessorPath: ['agent-memory'],
    methodName: 'recall',
  };
  assert.equal(
    cloudflareSnippetsByTarget(recall).get('cf'),
    ['cf agent-memory recall <profile-name>', '--namespace-name <namespace-name>', '--query <query>'].join(' \\\n    '),
  );
  // The zone is passed with the global --zone option, which samples leave out.
  assert.equal(cloudflareSnippetsByTarget(listInput).get('cf'), 'cf dns records list');
});

test('cf: renders required boolean options without a value', () => {
  const edit: SnippetInput = {
    op: op({ path: '/zones/{zone_id}/acm/total_tls', method: 'post' }),
    accessorPath: ['acm', 'total-tls'],
    methodName: 'edit',
  };
  assert.equal(cloudflareSnippetsByTarget(edit).get('cf'), 'cf acm total-tls edit \\\n    --enabled');
});

test('cf: renders nothing for operations without a generated cf command', () => {
  const unknown: SnippetInput = { ...listInput, op: op({ path: '/zones/{zone_id}/unknown' }) };
  assert.equal(cloudflareSnippetsByTarget(unknown).get('cf'), null);
  // `cf ai run` is hand-written: the site documents hand-written commands separately.
  const aiRun: SnippetInput = {
    op: op({ path: '/accounts/{account_id}/ai/run', method: 'post' }),
    accessorPath: ['ai'],
    methodName: 'run',
  };
  assert.equal(cloudflareSnippetsByTarget(aiRun).get('cf'), null);
});

test('cf: renders the command named like the operation when several send it', () => {
  const status = (methodName: string): SnippetInput => ({
    op: op({
      path: '/accounts/{account_id}/workflows/{workflow_name}/instances/{instance_id}/status',
      method: 'patch',
    }),
    accessorPath: ['workflows', 'instances'],
    methodName,
  });
  assert.match(cloudflareSnippetsByTarget(status('terminate')).get('cf') ?? '', /^cf workflows instances terminate /);
  assert.match(cloudflareSnippetsByTarget(status('pause')).get('cf') ?? '', /^cf workflows instances pause /);
});

test('provider renders every target in tab order with cf CLI first; terraform is coming-soon', () => {
  const snippets = cloudflareSnippets(listInput);
  assert.deepEqual(
    snippets.map((snippet) => snippet.targetId),
    CLOUDFLARE_TARGETS.map((target) => target.id),
  );
  assert.deepEqual(
    CLOUDFLARE_TARGETS.map((target) => target.id),
    ['cf', 'curl', 'terraform'],
  );
  for (const target of ['cf', 'curl']) {
    assert.equal(typeof snippets.find((snippet) => snippet.targetId === target)?.code, 'string');
  }
  assert.equal(snippets.find((snippet) => snippet.targetId === 'terraform')?.code, null);
});

test('formatIdentifier is acronym-aware and title-cases the rest', () => {
  assert.equal(cloudflareFormatIdentifier('dns'), 'DNS');
  assert.equal(cloudflareFormatIdentifier('dns_records'), 'DNS Records');
  assert.equal(cloudflareFormatIdentifier('zone-transfers'), 'Zone Transfers');
  assert.equal(cloudflareFormatIdentifier('acls'), 'ACLs');
  assert.equal(cloudflareFormatIdentifier('widgets'), 'Widgets');
});
