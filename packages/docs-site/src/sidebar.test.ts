import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FernRoutePlan } from 'astro-fern';
import { ApiRouter } from './api-routing.ts';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { CommandRouter } from './command-reference/routing.ts';
import { forgeRouteSidebar, forgeSidebar } from './sidebar.ts';

const plan: Pick<FernRoutePlan, 'catalog' | 'routing' | 'agents'> = {
  catalog: {
    snapshots: [
      {
        id: 'current',
        slug: 'current',
        label: 'Current',
        default: true,
        targets: [{ id: 'python', kind: 'sdk', label: 'Python', language: 'python' }],
      },
    ],
    products: [
      {
        id: 'reference',
        slug: 'reference',
        title: 'Reference',
        description: '',
        snapshots: [
          {
            id: 'current',
            slug: 'current',
            label: 'Current',
            default: true,
            targets: [{ id: 'python', kind: 'sdk', label: 'Python', language: 'python' }],
            pages: [
              {
                id: 'page:list-records',
                entryId: 'operation:list-records',
                operationId: 'list-records',
                slug: 'sections/records/operations/list-records',
                pathname: '/api/reference/sections/records/operations/list-records/',
                section: { id: 'records', tag: 'Human DNS Section', title: 'DNS Records' },
                title: 'List records',
                description: '',
                httpMethod: 'get',
              },
            ],
          },
        ],
      },
    ],
  },
  routing: { base: '/api', target: 'hash' },
  agents: { injectRoutes: false, markdown: false, llms: false, directive: false },
};
const router = new ApiRouter(plan, '/api');
const commandRouter = new CommandRouter(cfCommandCatalog, { base: '/api' });

test('sidebar groups composed catalog pages by their OpenAPI-tag section', () => {
  assert.deepEqual(forgeSidebar(router, 'current'), [
    {
      label: 'Reference',
      collapsed: true,
      items: [
        {
          label: 'Overview',
          link: '/api/reference/',
        },
        {
          label: 'DNS Records',
          collapsed: true,
          items: [
            {
              label: 'Overview',
              link: '/api/reference/sections/records/',
            },
            {
              label: 'List records',
              link: '/api/reference/sections/records/operations/list-records/',
            },
          ],
        },
      ],
    },
  ]);
});

test('sidebar renders SDK resources recursively and omits ownership tags', () => {
  const sdkPlan: Pick<FernRoutePlan, 'catalog' | 'routing' | 'agents'> = {
    catalog: {
      snapshots: [{ id: 'current', slug: 'current', label: 'Current', default: true, targets: [] }],
      products: [
        {
          id: 'zero-trust',
          slug: 'zero-trust',
          title: 'Zero Trust',
          description: '',
          snapshots: [
            {
              id: 'current',
              slug: 'current',
              label: 'Current',
              default: true,
              targets: [],
              pages: [
                {
                  id: 'page:list-profiles',
                  entryId: 'operation:list-profiles:primary',
                  operationId: 'profiles_list',
                  slug: 'devices/ip-profiles/methods/list',
                  pathname: '/api/zero-trust/devices/ip-profiles/methods/list/',
                  placement: {
                    projectionId: 'primary',
                    resourcePath: [
                      { id: 'devices', slug: 'devices', title: 'Devices' },
                      { id: 'ip_profiles', slug: 'ip-profiles', title: 'IP Profiles' },
                    ],
                    method: { id: 'list', slug: 'list' },
                  },
                  section: { id: 'internal', tag: 'Internal ownership', title: 'Internal ownership' },
                  title: 'List IP profiles',
                  description: '',
                  httpMethod: 'get',
                },
              ],
            },
          ],
        },
      ],
    },
    routing: { base: '/api', target: 'hash' },
    agents: { injectRoutes: false, markdown: false, llms: false, directive: false },
  };
  const sdkRouter = new ApiRouter(sdkPlan, '/api');

  assert.deepEqual(forgeSidebar(sdkRouter, 'current'), [
    {
      label: 'Zero Trust',
      collapsed: true,
      items: [
        { label: 'Overview', link: '/api/zero-trust/' },
        {
          label: 'Devices',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/api/zero-trust/devices/' },
            {
              label: 'IP Profiles',
              collapsed: true,
              items: [
                {
                  label: 'Overview',
                  link: '/api/zero-trust/devices/ip-profiles/',
                },
                {
                  label: 'List IP profiles',
                  link: '/api/zero-trust/devices/ip-profiles/methods/list/',
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test('sidebar omits products unavailable in the selected snapshot', () => {
  const sparsePlan = structuredClone(plan);
  const currentSnapshot = sparsePlan.catalog.products[0]?.snapshots[0];
  assert.ok(currentSnapshot);
  sparsePlan.catalog.snapshots.unshift({
    id: 'legacy',
    slug: 'legacy',
    label: 'Legacy',
    default: false,
    targets: [],
  });
  sparsePlan.catalog.products.push({
    id: 'retired',
    slug: 'retired',
    title: 'Retired',
    description: '',
    snapshots: [{ ...currentSnapshot, id: 'legacy', slug: 'legacy', label: 'Legacy', default: false }],
  });
  const sparseRouter = new ApiRouter(sparsePlan);

  assert.deepEqual(
    forgeSidebar(sparseRouter, 'current').map(({ label }) => label),
    ['Reference'],
  );
  assert.deepEqual(
    forgeSidebar(sparseRouter, 'legacy').map(({ label }) => label),
    ['Retired'],
  );
});

test('sidebar preserves the selected execution target when its route exists', () => {
  const sidebar = forgeSidebar(router, 'current', 'python');
  const product = sidebar[0];
  assert.ok(product && 'items' in product);
  assert.deepEqual(product.items[0], { label: 'Overview', link: '/api/reference/?lang=python' });
  const section = product.items[1];
  assert.ok(section && 'items' in section);
  assert.deepEqual(section.items, [
    {
      label: 'Overview',
      link: '/api/reference/sections/records/?lang=python',
    },
    {
      label: 'List records',
      link: '/api/reference/sections/records/operations/list-records/?lang=python',
    },
  ]);
});

test('sidebar overview preserves the selected execution target', () => {
  const sidebar = forgeRouteSidebar(router, commandRouter, 'current', 'python', '/api/reference/');
  assert.equal(sidebar[0]?.type, 'link');
  assert.equal(sidebar[0]?.type === 'link' ? sidebar[0].href : undefined, '/api/?lang=python');
});

test('route sidebar exposes the complete navigation on non-operation pages', () => {
  const sidebar = forgeRouteSidebar(router, commandRouter, 'current', undefined, '/api/');

  assert.equal(sidebar[0]?.type, 'link');
  assert.equal(sidebar[0]?.isCurrent, true);
  assert.equal(sidebar[1]?.type, 'group');
  assert.deepEqual(sidebar[1]?.type === 'group' ? sidebar[1].entries.map((entry) => entry.label) : [], [
    'Overview',
    'Agent Context',
    'Ai',
    'Auth',
    'Build',
    'Complete',
    'D1',
    'Deploy',
    'Dev',
    'Schema',
    'Workers',
  ]);
  assert.equal(sidebar[2]?.type, 'group');
  assert.equal(sidebar[2]?.label, 'Reference');
});

test('route sidebar moves matching command namespaces under product developer tooling', () => {
  const overlapPlan = structuredClone(plan);
  const snapshot = overlapPlan.catalog.products[0]?.snapshots[0];
  assert.ok(snapshot);
  overlapPlan.catalog.products.push(
    ...[
      { id: 'ai', title: 'AI' },
      { id: 'd1', title: 'D1' },
      { id: 'workers', title: 'Workers' },
    ].map(({ id, title }) => ({
      id,
      slug: id,
      title,
      description: '',
      snapshots: [{ ...snapshot, pages: [] }],
    })),
  );
  const overlapRouter = new ApiRouter(overlapPlan, '/api');
  const sidebar = forgeRouteSidebar(
    overlapRouter,
    commandRouter,
    'current',
    undefined,
    '/api/workers/tooling/triggers/deploy/',
  );
  const globalTooling = sidebar.find((entry) => entry.label === 'Developer Tooling');
  assert.deepEqual(globalTooling?.type === 'group' ? globalTooling.entries.map((entry) => entry.label) : [], [
    'Overview',
    'Agent Context',
    'Auth',
    'Build',
    'Complete',
    'Deploy',
    'Dev',
    'Schema',
  ]);

  const ai = sidebar.find((entry) => entry.label === 'AI');
  assert.deepEqual(ai?.type === 'group' ? ai.entries.map((entry) => entry.label) : [], [
    'Overview',
    'Developer Tooling',
  ]);
  const aiTooling = ai?.type === 'group' ? ai.entries[1] : undefined;
  assert.deepEqual(aiTooling?.type === 'group' ? aiTooling.entries.map((entry) => entry.label) : [], ['Run']);

  const d1 = sidebar.find((entry) => entry.label === 'D1');
  assert.deepEqual(d1?.type === 'group' ? d1.entries.map((entry) => entry.label) : [], [
    'Overview',
    'Developer Tooling',
  ]);
  const d1Tooling = d1?.type === 'group' ? d1.entries[1] : undefined;
  const migrations = d1Tooling?.type === 'group' ? d1Tooling.entries[0] : undefined;
  assert.equal(migrations?.label, 'Migrations');
  assert.deepEqual(migrations?.type === 'group' ? migrations.entries.map((entry) => entry.label) : [], [
    'Apply',
    'Create',
    'List',
  ]);

  const workers = sidebar.find((entry) => entry.label === 'Workers');
  const workersTooling = workers?.type === 'group' ? workers.entries[1] : undefined;
  const triggers = workersTooling?.type === 'group' ? workersTooling.entries[0] : undefined;
  const deploy = triggers?.type === 'group' ? triggers.entries[0] : undefined;
  assert.equal(deploy?.type, 'link');
  assert.equal(deploy?.type === 'link' ? deploy.href : undefined, '/api/workers/tooling/triggers/deploy/');
  assert.equal(deploy?.type === 'link' ? deploy.isCurrent : false, true);
});

test('route sidebar keeps commands global when their product is unavailable in the selected snapshot', () => {
  const sparsePlan = structuredClone(plan);
  const snapshot = sparsePlan.catalog.products[0]?.snapshots[0];
  assert.ok(snapshot);
  sparsePlan.catalog.snapshots.push({
    id: 'legacy',
    slug: 'legacy',
    label: 'Legacy',
    default: false,
    targets: [],
  });
  sparsePlan.catalog.products.push({
    id: 'd1',
    slug: 'd1',
    title: 'D1',
    description: '',
    snapshots: [{ ...snapshot, id: 'legacy', slug: 'legacy', label: 'Legacy', default: false, pages: [] }],
  });
  const sparseRouter = new ApiRouter(sparsePlan, '/api');

  const currentSidebar = forgeRouteSidebar(sparseRouter, commandRouter, 'current', undefined, '/api/');
  const currentTooling = currentSidebar.find((entry) => entry.label === 'Developer Tooling');
  assert.equal(currentTooling?.type === 'group' && currentTooling.entries.some((entry) => entry.label === 'D1'), true);

  const legacySidebar = forgeRouteSidebar(sparseRouter, commandRouter, 'legacy', undefined, '/api/');
  const legacyTooling = legacySidebar.find((entry) => entry.label === 'Developer Tooling');
  assert.equal(legacyTooling?.type === 'group' && legacyTooling.entries.some((entry) => entry.label === 'D1'), false);
  const d1 = legacySidebar.find((entry) => entry.label === 'D1');
  assert.deepEqual(d1?.type === 'group' ? d1.entries.map((entry) => entry.label) : [], [
    'Overview',
    'Developer Tooling',
  ]);
});

test('route sidebar retains default navigation when site query selection is invalid', () => {
  const sidebar = forgeRouteSidebar(router, commandRouter, '', undefined, '/api/tooling/');

  assert.equal(sidebar[0]?.type === 'link' ? sidebar[0].href : undefined, '/api/');
  assert.equal(sidebar[2]?.type, 'group');
  assert.equal(sidebar[2]?.label, 'Reference');
});

test('route sidebar marks a CLI command child as current', () => {
  const sidebar = forgeRouteSidebar(router, commandRouter, 'current', undefined, '/api/tooling/deploy/');
  const commands = sidebar[1];
  const deploy = commands?.type === 'group' ? commands.entries.find((entry) => entry.label === 'Deploy') : undefined;

  assert.equal(deploy?.type, 'link');
  assert.equal(deploy?.isCurrent, true);
});

test('route sidebar preserves every level of nested command paths', () => {
  const nestedRouter = new CommandRouter(
    {
      ...cfCommandCatalog,
      commands: [
        {
          ...cfCommandCatalog.commands[0],
          command: 'cf context agents list',
          name: 'list',
          fullPath: ['context', 'agents', 'list'],
          usage: 'cf context agents list',
        },
        {
          ...cfCommandCatalog.commands[1],
          command: 'cf context get',
          name: 'get',
          fullPath: ['context', 'get'],
          usage: 'cf context get',
        },
      ],
    },
    { base: '/api' },
  );
  const sidebar = forgeRouteSidebar(router, nestedRouter, 'current', undefined, '/api/tooling/context/agents/list/');
  const commands = sidebar[1];
  const context = commands?.type === 'group' ? commands.entries[1] : undefined;
  const agents = context?.type === 'group' ? context.entries[0] : undefined;
  const list = agents?.type === 'group' ? agents.entries[0] : undefined;

  assert.equal(context?.label, 'Context');
  assert.equal(agents?.label, 'Agents');
  assert.equal(list?.type, 'link');
  assert.equal(list?.type === 'link' ? list.href : undefined, '/api/tooling/context/agents/list/');
  assert.equal(list?.type === 'link' ? list.isCurrent : false, true);
});

test('route sidebar marks the selected target operation as current', () => {
  const sidebar = forgeRouteSidebar(
    router,
    commandRouter,
    'current',
    'python',
    '/api/reference/sections/records/operations/list-records/',
  );
  const product = sidebar[2];
  assert.equal(product?.type, 'group');
  const section = product?.type === 'group' ? product.entries[1] : undefined;
  assert.equal(section?.type, 'group');
  const operation = section?.type === 'group' ? section.entries[1] : undefined;

  assert.equal(operation?.type, 'link');
  assert.equal(operation?.isCurrent, true);
});

test('route sidebar links and marks product and section overview pages', () => {
  const productSidebar = forgeRouteSidebar(router, commandRouter, 'current', undefined, '/api/reference/');
  const product = productSidebar[2];
  assert.equal(product?.type, 'group');
  const productOverview = product?.type === 'group' ? product.entries[0] : undefined;
  assert.equal(productOverview?.type, 'link');
  assert.equal(productOverview?.isCurrent, true);

  const sectionSidebar = forgeRouteSidebar(
    router,
    commandRouter,
    'current',
    undefined,
    '/api/reference/sections/records/',
  );
  const sectionProduct = sectionSidebar[2];
  const section = sectionProduct?.type === 'group' ? sectionProduct.entries[1] : undefined;
  const sectionOverview = section?.type === 'group' ? section.entries[0] : undefined;
  assert.equal(sectionOverview?.type, 'link');
  assert.equal(sectionOverview?.isCurrent, true);
});
