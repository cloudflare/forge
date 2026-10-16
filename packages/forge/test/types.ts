// Checks the types of @cloudflare/forge/ts against how it behaves. npm test
// compiles it, and fails on any error. Each expected error marks something
// the types must reject, and fails the test if they accept it.

import { type File, type Ident, type Module, type Part, file, frag, ident, join, module } from '../plugin/ts.js';
import type { Type } from '../plugin/index.js';

function metadata(type: Type): number | string | undefined {
  if (type.kind === 'array') {
    const min: number | undefined = type.minItems;
    const max: number | undefined = type.maxItems;
    // @ts-expect-error Metadata is read-only.
    type.minItems = 0;
    return min ?? max;
  }
  if (type.kind === 'scalar') {
    const format: string | undefined = type.format;
    // @ts-expect-error Metadata is read-only.
    type.format = 'uuid';
    return format;
  }
  return undefined;
}

const f: File = file('a.ts');
const m: Module = module('m.ts');
const pet: Ident = m.ident('Pet');

// A file prints a line when called, as a tagged template or with parts.
f`let a: ${pet};`;
f('let b: ', pet, ';');
f();
f([pet, '[]'], frag`${1}`, join(', ', [true, 2n]));

// @ts-expect-error A call prints, and returns nothing.
const printed: string = f``;

// Parts are strings, numbers, booleans, bigints, identifiers, models and
// arrays of them, and nothing else, at any depth.
const parts: Part[] = ['a', 1, true, 2n, pet, [pet, ['b']]];
// @ts-expect-error
f`${undefined}`;
// @ts-expect-error
f('x', null);
// @ts-expect-error
f`${{ name: 'x' }}`;
// @ts-expect-error
f([1, undefined]);
// @ts-expect-error
f`${() => 'x'}`;

// Modules and identifiers come only from module and ident: one shaped like
// them, without the key only they have, is neither.
const fakeModule = { path: 'm.ts', generated: true, ident: m.ident, sub: m.sub, equals: m.equals };
// @ts-expect-error
const notModule: Module = fakeModule;
// @ts-expect-error
file(fakeModule);
// @ts-expect-error
ident('Pet', fakeModule);
const fakeIdent = { name: 'Pet', module: m, typeOnly: false, alias: undefined, ty: pet.ty, as: pet.as };
// @ts-expect-error
const notIdent: Ident = fakeIdent;
// @ts-expect-error
f`let x: ${fakeIdent};`;

// The ways to make them are typed.
const typeOnly: Ident = ident('Pet', m, { typeOnly: true, alias: 'P' });
const dir: Module = module.ROOT.sub('models.ts');
// @ts-expect-error The root can't be replaced.
module.ROOT = m;
// @ts-expect-error Nor can an identifier's name.
pet.name = 'Owner';

// A file is a function, with Function's members, and a File's own.
const fn: (...parts: Part[]) => void = f;
const bound: Function = f.bind(null);
const path: string = f.path;
const content: string = f.content;
f.indent((g) => g`nested;`);
f.doc('A comment.');
// @ts-expect-error A file's module can't be replaced.
f.module = m;
// @ts-expect-error Nor can what it printed be reached.
f.body;

export { metadata, printed, parts, notModule, notIdent, typeOnly, dir, fn, bound, path, content };
