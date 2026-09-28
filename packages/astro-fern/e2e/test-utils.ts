import { expect, test as baseTest, type Page } from '@playwright/test';
import { dev } from 'astro';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export { expect };

process.env.ASTRO_TELEMETRY_DISABLED = 'true';
process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';

type DevServer = Awaited<ReturnType<typeof dev>>;

export function testFactory(fixturePath: string) {
  const root = fileURLToPath(new URL(fixturePath, import.meta.url));
  let server: DevServer | undefined;

  const test = baseTest.extend<{
    getDevServer: () => Promise<AstroPage>;
  }>({
    getDevServer: ({ page }, use) =>
      use(async () => {
        server ??= await dev({
          logLevel: 'error',
          root,
          server: { port: 0 },
          vite: { optimizeDeps: { noDiscovery: true } },
        });
        return new AstroPage(server, page);
      }),
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  return test;
}

export class AstroPage {
  constructor(
    private readonly server: DevServer,
    private readonly page: Page,
  ) {}

  goto(pathname: string) {
    return this.page.goto(this.resolveUrl(pathname));
  }

  resolveUrl(pathname: string) {
    const address = this.server.address;
    if (!isAddressInfo(address)) throw new Error('astro-fern e2e: failed to resolve the fixture server address');
    return `http://localhost:${address.port}${pathname.replace(/^\/?/, '/')}`;
  }
}

function isAddressInfo(address: DevServer['address']): address is AddressInfo {
  return Boolean(address) && typeof address !== 'string';
}
