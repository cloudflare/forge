// Declares the parts of WebAssembly and base64 that src/index.ts uses.
// Every runtime it runs in has them, but the compiler's `es2022` library
// leaves them out.

declare namespace WebAssembly {
  class Module {
    constructor(bytes: Uint8Array);
  }
  class Instance {
    constructor(module: Module, imports?: Record<string, unknown>);
    readonly exports: Record<string, unknown>;
  }
}

declare function atob(data: string): string;
