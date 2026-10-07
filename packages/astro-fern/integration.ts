import type { AstroIntegration } from 'astro';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFernMarkdownSanitizer } from './markdown.ts';
import { type AstroFernIntegrationOptions, mountPattern, resolveRuntimeConfig } from './runtime-config.ts';
import { vitePluginFernExtensions, vitePluginFernRuntimeConfig } from './vite-plugin.ts';

const contentReloadFiles = new Set(
  [
    './collections.ts',
    './artifacts.ts',
    './content-collections.ts',
    './content-contract.ts',
    './manifest.ts',
    './operation-live-loader.ts',
    './project.ts',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url))),
);
const contentReloadDirectories = ['./content/', './snippets/'].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

function isWithin(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function reloadsFernContent(path: string): boolean {
  return contentReloadFiles.has(path) || contentReloadDirectories.some((directory) => isWithin(path, directory));
}

/**
 * Installs runtime context and package-owned agent routes. Human HTML routes
 * remain consumer-owned, while OpenAPI ingestion and content policy belong to
 * `fernCollection()` and never enter this integration's module graph.
 */
export default function astroFern(options: AstroFernIntegrationOptions): AstroIntegration {
  const runtime = resolveRuntimeConfig(options);
  return {
    name: 'astro-fern',
    hooks: {
      'astro:config:setup': ({ addMiddleware, config, injectRoute, logger, updateConfig }) => {
        if (!installFernMarkdownSanitizer(config.markdown.processor)) {
          logger.warn('Markdown sanitization is not installed because the active processor is not Satteri.');
        }
        updateConfig({ vite: { plugins: [vitePluginFernRuntimeConfig(runtime), vitePluginFernExtensions()] } });
        // Expose per-page routing/snapshot context as `Astro.locals.fern`.
        addMiddleware({ order: 'pre', entrypoint: new URL('./middleware.ts', import.meta.url) });

        const { agents, routing } = runtime;
        if (!agents.injectRoutes) return;
        const scopes = agents.llms === false ? [] : agents.llms.scopes;
        // Site-wide index lives at the root; scoped indexes (product/snapshot/target)
        // share one catch-all under the base — `[...scope]` captures the full tail.
        if (scopes.includes('site')) {
          injectRoute({
            pattern: '/llms.txt',
            entrypoint: new URL('./agents/routes/root-llms.ts', import.meta.url),
          });
        }
        if (scopes.some((scope) => scope !== 'site')) {
          injectRoute({
            pattern: mountPattern(routing.base, '/[...scope]/llms.txt'),
            entrypoint: new URL('./agents/routes/scoped-llms.ts', import.meta.url),
          });
        }
        if (agents.markdown) {
          injectRoute({
            pattern: mountPattern(routing.base, '/[...document].md'),
            entrypoint: new URL('./agents/routes/markdown.ts', import.meta.url),
          });
        }
      },
      'astro:config:done': ({ injectTypes }) => {
        injectTypes({
          filename: 'runtime-config.d.ts',
          content:
            "declare module 'fern:virtual/runtime-config' {\n" +
            "  const config: import('astro-fern').FernRuntimeConfig;\n" +
            '  export default config;\n' +
            '}\n',
        });
        injectTypes({
          filename: 'extensions.d.ts',
          content:
            "declare module 'fern:virtual/extensions' {\n" +
            "  export { getOperationExtensionData } from 'astro-fern';\n" +
            '}\n',
        });
      },
      'astro:server:setup': ({ logger, server }) => {
        const markedServer = server as typeof server & { __astroFernContentReloadWatcher?: true };
        if (markedServer.__astroFernContentReloadWatcher) return;
        markedServer.__astroFernContentReloadWatcher = true;
        server.watcher.add([...contentReloadFiles, ...contentReloadDirectories]);

        let restartTimer: ReturnType<typeof setTimeout> | undefined;
        server.watcher.on('change', (changedPath) => {
          if (!reloadsFernContent(changedPath)) return;
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            logger.info('Content pipeline changed; reloading generated API content.');
            void server.restart();
          }, 50);
        });
      },
    },
  };
}
