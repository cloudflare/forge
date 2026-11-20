import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { forbiddenHosts } from './generate-stainless-snippets.ts';
import { jobName, readArtifacts } from './gitlab.ts';
import { buildSnippetsFile, extractSnippets, type Language, type SdkJson } from './snippets.ts';
import { readZipEntry } from './zip.ts';

const SPEC: SdkJson = {
  resources: {
    zones: {
      methods: {
        list: { stainlessPath: '(resource) zones > (method) list', configRef: '#/resources/zones/methods/list' },
        get: { stainlessPath: '(resource) zones > (method) get', configRef: '#/resources/zones/methods/get' },
      },
      subresources: {
        holds: {
          methods: {
            create: {
              stainlessPath: '(resource) zones.holds > (method) create',
              configRef: '#/resources/zones/subresources/holds/methods/create',
            },
          },
        },
      },
    },
  },
  snippets: {
    'typescript.default': {
      '(resource) zones > (method) list': { default: { content: 'client.zones.list();' } },
      '(resource) zones.holds > (method) create': { default: { content: 'client.zones.holds.create();' } },
    },
    'http.curl': { '(resource) zones > (method) get': { default: { content: 'curl' } } },
  },
};

test('snippets are keyed by the old page, which is the configRef without the #; methods without one are left out', () => {
  assert.deepEqual(
    [...extractSnippets(SPEC, 'typescript')],
    [
      ['/resources/zones/methods/list/', 'client.zones.list();'],
      ['/resources/zones/subresources/holds/methods/create/', 'client.zones.holds.create();'],
    ],
  );
});

test('a spec without the language, or with a method whose configRef is not a method page, is refused', () => {
  assert.throws(
    () => extractSnippets(SPEC, 'python'),
    /no "python\.default" snippets \(it has typescript\.default, http\.curl\)\..*update extractSnippets/,
  );
  const odd = structuredClone(SPEC);
  odd.resources['zones']!.methods!['list']!.configRef = '#/resources/zones';
  assert.throws(() => extractSnippets(odd, 'typescript'), /configRef is "#\/resources\/zones", not .*update oldPage/);
});

function snippets(entries: Partial<Record<Language, [string, string][]>>): Record<Language, Map<string, string>> {
  return {
    typescript: new Map(entries.typescript),
    python: new Map(entries.python),
    go: new Map(entries.go),
  };
}

const SOURCE = { apiSchemasSha: 'a'.repeat(40), generatedAt: '2026-11-20T00:00:00.000Z' };

test('the file keeps the snapshot pages, sorted, with their languages in tab order, and reports the rest', () => {
  const result = buildSnippetsFile({
    snippets: snippets({
      go: [['/resources/b/methods/list/', 'go b']],
      typescript: [
        ['/resources/b/methods/list/', 'ts b'],
        ['/resources/a/methods/get/', 'ts a'],
        ['/resources/new/methods/list/', 'ts new'],
      ],
    }),
    methods: ['/resources/b/methods/list/', '/resources/a/methods/get/'],
    forbidden: forbiddenHosts('https://git.internal.example.com'),
    source: SOURCE,
  });
  assert.equal(
    JSON.stringify(result.file),
    JSON.stringify({
      format: 1,
      source: SOURCE,
      snippets: {
        '/resources/a/methods/get/': { typescript: 'ts a' },
        '/resources/b/methods/list/': { typescript: 'ts b', go: 'go b' },
      },
    }),
  );
  assert.deepEqual(result.unknown, { typescript: ['/resources/new/methods/list/'], python: [], go: [] });
  assert.deepEqual(result.missing, {
    typescript: [],
    python: ['/resources/a/methods/get/', '/resources/b/methods/list/'],
    go: ['/resources/a/methods/get/'],
  });
});

test('a snippet containing a forbidden string fails the run, whatever its case', () => {
  assert.throws(
    () =>
      buildSnippetsFile({
        snippets: snippets({ python: [['/resources/a/methods/get/', "base_url='https://Docs.Internal.EXAMPLE.com'"]] }),
        methods: ['/resources/a/methods/get/'],
        forbidden: forbiddenHosts('https://git.internal.example.com'),
        source: SOURCE,
      }),
    /python \/resources\/a\/methods\/get\/: contains "example.com"/,
  );
});

/** A zip archive of `files`, deflated, built the way the spec lays it out. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('zip entries are read by name, and a missing one is undefined', () => {
  const archive = zip({ 'a.txt': 'alpha', 'dir/b.json': '{"b":1}' });
  assert.equal(readZipEntry(archive, 'dir/b.json')?.toString(), '{"b":1}');
  assert.equal(readZipEntry(archive, 'c.txt'), undefined);
  assert.throws(() => readZipEntry(Buffer.from('not a zip, long enough to scan for a record'), 'a'), /not a zip/);
});

test("an artifact archive yields the language's SDK JSON and the api-schemas commit", () => {
  const sha = 'b'.repeat(40);
  const archive = zip({
    '.schemas/BUILD_INFO.json': JSON.stringify({ ref: 'main', sha }),
    '.sdk-json-cache/cloudflare/go.json': '{"resources":{}}',
  });
  assert.deepEqual(readArtifacts(archive, 'go'), { sdkJson: '{"resources":{}}', apiSchemasSha: sha });
  assert.throws(
    () => readArtifacts(archive, 'python'),
    /no \.sdk-json-cache\/cloudflare\/python\.json\. .*update readArtifacts/,
  );
  assert.equal(jobName('go'), 'generate-sdk-jsons:production: [go]');
});

test('the forbidden strings are the GitLab host and its domain', () => {
  assert.deepEqual(forbiddenHosts('https://git.internal.example.com/'), ['git.internal.example.com', 'example.com']);
  assert.deepEqual(forbiddenHosts('https://example.com:8443'), ['example.com']);
});

test('two methods with one page and different snippets fail, naming both and where to choose', () => {
  const twice = structuredClone(SPEC);
  twice.resources['zones']!.methods!['get']!.configRef = '#/resources/zones/methods/list';
  twice.snippets['typescript.default']!['(resource) zones > (method) get'] = {
    default: { content: 'client.zones.get();' },
  };
  assert.throws(
    () => extractSnippets(twice, 'typescript'),
    /"\(resource\) zones > \(method\) list" and "\(resource\) zones > \(method\) get" both have the configRef of \/resources\/zones\/methods\/list\/.*extractSnippets in scripts\/snippets\.ts/s,
  );
});
