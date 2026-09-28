// Overrides the generated Headers polyfill.
//
// Fern emits `let Headers: typeof globalThis.Headers` and then assigns a hand-
// written fallback class to it. Under TypeScript 6's lib.dom, `Headers`
// iterator methods return `HeadersIterator<T>`, which extends
// `IteratorObject` and therefore requires `[Symbol.dispose]`. The fallback
// returns plain `IterableIterator<T>`, so the assignment fails:
//
//   error TS2322: Type 'typeof Headers' is not assignable to type
//   '{ new (init?: HeadersInit): Headers; prototype: Headers; }'.
//     Property '[Symbol.dispose]' is missing in type
//     'IterableIterator<[string, string]>' but required in type
//     'HeadersIterator<[string, string]>'.
//
// The polyfill only runs when globalThis.Headers is absent, and no caller
// depends on disposable iterators, so the structural gap is not observable.
// Cast at the assignment instead of widening the exported type, which keeps
// `Headers` typed as the real DOM constructor for every consumer.

let Headers: typeof globalThis.Headers;

if (typeof globalThis.Headers !== 'undefined') {
  Headers = globalThis.Headers;
} else {
  Headers = class Headers {
    private headers: Map<string, string[]>;

    constructor(init?: HeadersInit) {
      this.headers = new Map();

      if (init) {
        if (init instanceof Headers) {
          init.forEach((value, key) => this.append(key, value));
        } else if (Array.isArray(init)) {
          for (const [key, value] of init) {
            if (typeof key === 'string' && typeof value === 'string') {
              this.append(key, value);
            } else {
              throw new TypeError('Each header entry must be a [string, string] tuple');
            }
          }
        } else {
          for (const [key, value] of Object.entries(init)) {
            if (typeof value === 'string') {
              this.append(key, value);
            } else {
              throw new TypeError('Header values must be strings');
            }
          }
        }
      }
    }

    append(name: string, value: string): void {
      const key = name.toLowerCase();
      const existing = this.headers.get(key) || [];
      this.headers.set(key, [...existing, value]);
    }

    delete(name: string): void {
      const key = name.toLowerCase();
      this.headers.delete(key);
    }

    get(name: string): string | null {
      const key = name.toLowerCase();
      const values = this.headers.get(key);
      return values ? values.join(', ') : null;
    }

    has(name: string): boolean {
      const key = name.toLowerCase();
      return this.headers.has(key);
    }

    set(name: string, value: string): void {
      const key = name.toLowerCase();
      this.headers.set(key, [value]);
    }

    forEach(callbackfn: (value: string, key: string, parent: globalThis.Headers) => void, thisArg?: unknown): void {
      const boundCallback = thisArg ? callbackfn.bind(thisArg) : callbackfn;
      this.headers.forEach((values, key) =>
        boundCallback(values.join(', '), key, this as unknown as globalThis.Headers),
      );
    }

    getSetCookie(): string[] {
      return this.headers.get('set-cookie') || [];
    }

    *entries(): IterableIterator<[string, string]> {
      for (const [key, values] of this.headers.entries()) {
        yield [key, values.join(', ')];
      }
    }

    *keys(): IterableIterator<string> {
      yield* this.headers.keys();
    }

    *values(): IterableIterator<string> {
      for (const values of this.headers.values()) {
        yield values.join(', ');
      }
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
      return this.entries();
    }
  } as unknown as typeof globalThis.Headers;
}

export { Headers };
