function defineFixture<const Name extends string>(name: Name) {
  return {
    name,
    base: `/__astro-fern-e2e/${name}`,
  } as const;
}

export const E2E_FIXTURES = {
  snapshots: defineFixture('snapshots'),
} as const;

export type E2EFixtureName = keyof typeof E2E_FIXTURES;

export function fixturePath(name: E2EFixtureName, pathname: string) {
  return `${E2E_FIXTURES[name].base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
