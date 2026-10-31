import { registerHooks } from 'node:module';

// The sources import each other as `./name.js`, the way TypeScript emits
// them. Node runs the `.ts` files as they are, so a relative `.js` import
// that does not exist resolves to the `.ts` file next to it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        specifier.endsWith('.js') &&
        (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
