import { registerHooks } from 'node:module';

// The sources import each other as `./name.js`, the way TypeScript emits
// them. Node runs the `.ts` files as they are, so a relative `.js` import
// that does not exist resolves to the `.ts` file next to it, or else to the
// file of that name in the runtime of the TypeScript clients, which the
// generated files have next to this one.
const own = new URL('../src/', import.meta.url).href;
const shared = new URL('../../../ts/lib/src/', import.meta.url).href;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!relative || !specifier.endsWith('.js') || !missing(error) || context.parentURL === undefined) {
        throw error;
      }
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href;
      try {
        return nextResolve(source, context);
      } catch (inner) {
        if (missing(inner) && source.startsWith(own)) {
          return nextResolve(shared + source.slice(own.length), context);
        }
        throw inner;
      }
    }
  },
});
