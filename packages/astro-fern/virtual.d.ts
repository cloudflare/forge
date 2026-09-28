declare module 'fern:virtual/runtime-config' {
  const config: import('./runtime-config.ts').FernRuntimeConfig;
  export default config;
}

declare module 'fern:virtual/extensions' {
  export { getOperationExtensionData } from './extensions.ts';
}
