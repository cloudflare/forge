/**
 * TypeSpec OpenAPI Loader
 *
 * Reads OpenAPI specs written in TypeSpec. Each spec is compiled the way
 * `tsp compile <file>` compiles it, under the project's tspconfig.yaml, and
 * the project's `@typespec/openapi3` emitter runs once for real, writing to
 * memory. Every service, and every version of a versioned service, becomes
 * the OpenAPI 3.0 document `tsp compile` writes for it, byte for byte.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ForgeOpenApiDocument, OpenApiLoader } from '@cloudflare/forge';
import type { CompilerHost, CompilerOptions, Diagnostic } from '@typespec/compiler';
import { resolveModule } from '@typespec/compiler/module-resolver';

/** An OpenAPI spec written in TypeSpec. */
export type TypeSpecOpenApiSource = {
  format: 'typespec';
  /** Entry `.tsp` file or TypeSpec project directory, as a path or `file:` URL object. */
  entry: string | URL;
  /** Service namespace to read, such as `Billing`; every service when omitted. */
  service?: string;
  /** Version of a versioned service to read, as the version enum member's value; every version when omitted. */
  version?: string;
};

/** Options for the TypeSpec loader. */
export type TypeSpecLoaderOptions = {
  /**
   * Receives compiler warnings as `tsp compile --pretty=false` prints them, with paths relative to the
   * working directory. Defaults to `console.warn` with a `[forge-typespec]` prefix.
   */
  onWarning?: (message: string) => void;
};

type TypeSpecCompiler = typeof import('@typespec/compiler');

const OPENAPI3 = '@typespec/openapi3';

// The emitter fills in each document's service name and version, which no TypeSpec name or version
// contains NUL (and from @typespec/openapi3 1.16 cannot, as it is sanitized out), so each in-memory
// file path splits on NUL back into exactly one service and version.
const OUTPUT_FILE = '\0{service-name}\0{version}\0openapi.json';

/**
 * Imports the TypeSpec compiler that resolves from the spec's project, as `compile()` resolves it
 * to check that the compiler running it is the project's own (`compiler-version-mismatch`). Where
 * none resolves, which `compile()` accepts, the compiler this package depends on is used.
 */
async function importCompiler(projectDir: string): Promise<TypeSpecCompiler> {
  const host = { realpath, stat, readFile: (path: string) => readFile(path, 'utf8') };
  try {
    const resolved = await resolveModule(host, '@typespec/compiler', { baseDir: projectDir, conditions: ['import'] });
    if (resolved.type === 'module') return (await import(pathToFileURL(resolved.mainFile).href)) as TypeSpecCompiler;
  } catch (error) {
    // The same codes `compile()` treats as "no compiler in the project".
    const code = (error as { code?: unknown }).code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'INVALID_MAIN') throw error;
  }
  return import('@typespec/compiler');
}

async function getProjectDir(entry: string, location: string): Promise<string> {
  try {
    return (await stat(entry)).isDirectory() ? entry : dirname(entry);
  } catch (cause) {
    throw new Error(`Could not read the OpenAPI spec (${location})`, { cause });
  }
}

type CompiledDocument = { service: string; version?: string; document: ForgeOpenApiDocument };

function getDocumentName(compiled: CompiledDocument): string {
  return compiled.version === undefined ? compiled.service : `${compiled.service}@${compiled.version}`;
}

function selectDocuments(compiled: CompiledDocument[], source: TypeSpecOpenApiSource): CompiledDocument[] {
  const selected = compiled.filter(
    (document) =>
      (source.service === undefined || document.service === source.service) &&
      (source.version === undefined || document.version === source.version),
  );
  if (selected.length > 0) return selected;

  const wanted = [source.service ?? '*', source.version].filter((part) => part !== undefined).join('@');
  throw new Error(
    `The TypeSpec spec defines no document "${wanted}" (${String(source.entry)}). Documents:\n- ` +
      compiled.map(getDocumentName).join('\n- '),
  );
}

/** Reads OpenAPI specs written in TypeSpec, compiled to OpenAPI 3.0 as `tsp compile` would. */
export function typeSpecLoader(options: TypeSpecLoaderOptions = {}): OpenApiLoader<TypeSpecOpenApiSource> {
  const warn = options.onWarning ?? ((message: string) => console.warn(`[forge-typespec] ${message}`));

  return {
    format: 'typespec',
    load: async (source) => {
      const location = String(source.entry);
      const entry = resolve(source.entry instanceof URL ? fileURLToPath(source.entry) : source.entry);
      const projectDir = await getProjectDir(entry, location);
      const compiler = await importCompiler(projectDir);
      const format = (diagnostic: Diagnostic) =>
        compiler.formatDiagnostic(diagnostic, { pathRelativeTo: process.cwd() });
      const fail = (errors: readonly Diagnostic[]): never => {
        throw new Error(`The TypeSpec spec does not compile (${location}):\n- ${errors.map(format).join('\n- ')}`);
      };

      // The emitter writes through the host, which keeps the files in memory.
      const files = new Map<string, string>();
      const host: CompilerHost = {
        ...compiler.NodeHost,
        mkdirp: async (path) => path,
        writeFile: async (path, content) => void files.set(path, content),
      };

      // The project's tspconfig.yaml applies as it does for `tsp compile`.
      const [projectOptions, configDiagnostics] = await compiler.resolveCompilerOptions(host, {
        entrypoint: entry,
        cwd: process.cwd(),
        env: process.env,
      });
      // As in `tsp compile`, any problem with the config fails the compile.
      if (configDiagnostics.length > 0) fail(configDiagnostics);

      // Only the OpenAPI emitter runs, only for OpenAPI 3.0 (the version Forge's resolver reads), and as one
      // JSON file per document named by service and version. These are set on the resolved options because
      // the config's parameters are interpolated into the options it resolves, and would rewrite the template.
      const compilerOptions: CompilerOptions = {
        ...projectOptions,
        emit: [OPENAPI3],
        options: {
          ...projectOptions.options,
          [OPENAPI3]: {
            ...projectOptions.options?.[OPENAPI3],
            'openapi-versions': ['3.0.0'],
            'file-type': 'json',
            'output-file': OUTPUT_FILE,
          },
        },
      };

      // Loading the emitter validates its options, and its diagnostics pass through `#suppress` and
      // `warn-as-error` like any other.
      const program = await compiler.compile(host, entry, compilerOptions);
      for (const diagnostic of program.diagnostics) {
        if (diagnostic.severity === 'warning') warn(format(diagnostic));
      }
      if (program.hasError()) fail(program.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'));

      // The emitter writes a service's name into its file name as is before @typespec/openapi3 1.16, and
      // sanitized from 1.16, when the compiler gained `sanitizePathSegment`; either form identifies it.
      const sanitize: ((value: string) => string) | undefined = compiler.sanitizePathSegment;
      const serviceNames = new Map<string, string>();
      for (const service of compiler.listServices(program)) {
        const name = compiler.getNamespaceFullName(service.type);
        serviceNames.set(name, name);
        if (sanitize) serviceNames.set(sanitize(name), name);
      }
      const compiled = [...files].map(([path, content]): CompiledDocument => {
        const [, serviceSegment = '', versionSegment = ''] = path.split('\0');
        const document = JSON.parse(content) as ForgeOpenApiDocument;
        // A spec without `@service` compiles its global namespace, whose name is empty; its title stands in.
        const service = serviceSegment === '' ? document.info.title : serviceNames.get(serviceSegment);
        if (service === undefined) {
          throw new Error(
            `The OpenAPI emitter wrote a document for an unknown service "${serviceSegment}" (${location})`,
          );
        }
        return {
          service,
          // A versioned document's `info.version` is its version enum member's value, as declared.
          ...(versionSegment ? { version: document.info.version } : {}),
          document,
        };
      });

      return selectDocuments(compiled, source).map((selected) => ({
        name: getDocumentName(selected),
        document: selected.document,
      }));
    },
  };
}
