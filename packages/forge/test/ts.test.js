// The tests of forge's Rust `forge::ts`, in src/plugin/ts/tests.rs, run
// against @cloudflare/forge/ts. They expect the same text, so the two print
// TypeScript the same way.
//
//     npm test

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PREAMBLE, file, frag, ident, join, module } from '../plugin/ts.js';

/**
 * Returns the text of parts that frag or join made, with each identifier's
 * name unchanged, as Rust's Display of a Fragment writes it.
 */
function text(parts) {
  return parts.map(String).join('');
}

/** Returns the content of `f` without the preamble, which it must start with. */
function content(f) {
  const rendered = f.content;
  assert.ok(rendered.startsWith(PREAMBLE), `${f.path} does not start with the preamble:\n${rendered}`);
  return rendered.slice(PREAMBLE.length);
}

function lines(...lines) {
  return `${lines.join('\n')}\n`;
}

test('file', () => {
  const models = module('pets/models.ts');
  const runtime = module('_/index.ts');
  const f = file(module('pets/client.ts'));
  assert.equal(f.path, 'pets/client.ts');

  f.doc('A client of pets.');
  f`export interface ${f.ident('Client')} {`;
  f`  get(): Promise<${models.ident('Pet').ty()}>;`;
  f`  list(): ${frag`Promise<${models.ident('Pet').ty()}[]>`};`;
  f`}`;
  f``;
  f`const codec = ${models.ident('PetCodec')};`;
  f`const transport = new ${runtime.ident('Transport')}();`;
  f`const read = ${module('node:fs/promises').ident('readFile')};`;
  f`type S = ${module('@scope/schema').ident('Schema').ty()};`;
  // A name used as both a value and a type is imported as a value.
  f`type T = ${runtime.ident('Transport').ty()};`;
  f`let now: ${module('temporal').ident('Temporal.Instant').ty()};`;

  assert.equal(
    content(f),
    lines(
      `import type { Schema } from "@scope/schema";`,
      `import { readFile } from "node:fs/promises";`,
      `import type { Temporal } from "temporal";`,
      '',
      // Generated files are imported with .js.
      `import { Transport } from "../_/index.js";`,
      `import { type Pet, PetCodec } from "./models.js";`,
      '',
      '/**',
      ' * A client of pets.',
      ' */',
      'export interface Client {',
      '  get(): Promise<Pet>;',
      '  list(): Promise<Pet[]>;',
      '}',
      '',
      'const codec = PetCodec;',
      'const transport = new Transport();',
      'const read = readFile;',
      'type S = Schema;',
      'type T = Transport;',
      'let now: Temporal.Instant;',
    ),
  );
});

test('a file is a function that prints a line', () => {
  const f = file('pets/client.ts');
  assert.equal(typeof f, 'function');
  // It has a File's module, getters and methods.
  assert.equal(f.module.path, 'pets/client.ts');
  assert.equal(f.path, 'pets/client.ts');
  assert.equal(f.ident('Client').module, f.module);
  // And it is a whole function, with what its type says it has from
  // Function.
  assert.ok(f instanceof Function);
  assert.equal(typeof f.bind, 'function');
  const print = f.bind(null, 'let bound = ');
  print(1, ';');
  f.call(null, 'let called = ', 2, ';');
  // A function's own `name` and `length` don't get in the way of rendering,
  // which resolves names.
  f`let pet: ${module('pets/models.ts').ident('Pet').ty()};`;
  assert.equal(
    content(f),
    lines(`import type { Pet } from "./models.js";`, '', 'let bound = 1;', 'let called = 2;', 'let pet: Pet;'),
  );
  // Files don't share what they print.
  assert.equal(file('a.ts').content, '');
  // A file is frozen: nothing it has can be replaced.
  assert.throws(() => {
    'use strict';
    f.module = module('b.ts');
  }, TypeError);
  assert.ok(Object.isFrozen(f));
});

test('only modules and identifiers made here are ones', () => {
  // Something shaped like a module or an identifier, but not made by
  // module or ident, has no brand, so it is neither.
  const fake = { name: 'Pet', module: module('m.ts'), typeOnly: false, alias: undefined };
  assert.throws(() => file('a.ts')`let x: ${fake};`, /cannot print object/);
  assert.throws(() => file({ path: 'a.ts' }), /needs a path or a module made with module\(\)/);
  assert.throws(() => ident('Pet', { path: 'm.ts' }), /needs a module, made with module\(\)/);
  // Ones made here are immutable.
  const pet = module('m.ts').ident('Pet');
  assert.ok(Object.isFrozen(pet) && Object.isFrozen(pet.module));
  assert.equal(module.ROOT.path, '');
  assert.ok(Object.isFrozen(module) && Object.isFrozen(ident));
});

test('aliases', () => {
  const f = file('a/b.ts');
  // The file's own `Pet` keeps the name, and each later `Pet` gets another `$`.
  f`interface ${f.ident('Pet')} {}`;
  f`let x: ${module('c.ts').ident('Pet').ty()};`;
  f`let y: ${module('d.ts').ident('Pet').ty()};`;
  f`let z: ${module('d.ts').ident('Owner').ty()};`;
  assert.equal(
    content(f),
    lines(
      `import type { Pet as Pet$ } from "../c.js";`,
      `import type { Owner, Pet as Pet$$ } from "../d.js";`,
      '',
      'interface Pet {}',
      'let x: Pet$;',
      'let y: Pet$$;',
      'let z: Owner;',
    ),
  );
});

test('ident helpers', () => {
  const pet = module('pets/models.ts').ident('Pet');
  const fields = (id) => ({ name: id.name, module: id.module.path, typeOnly: id.typeOnly, alias: id.alias });
  const plain = { name: 'Pet', module: 'pets/models.ts', typeOnly: false, alias: undefined };
  assert.deepEqual(fields(pet.as('PetModel')), { ...plain, alias: 'PetModel' });
  assert.deepEqual(fields(pet.ty()), { ...plain, typeOnly: true });
  assert.deepEqual(fields(pet.ty().as('PetModel')), { ...plain, typeOnly: true, alias: 'PetModel' });
  // They return new identifiers, and leave this one alone.
  assert.deepEqual(fields(pet), plain);

  const f = file('pets/client.ts');
  f`let a: ${pet.ty()};`;
  assert.equal(content(f), lines(`import type { Pet } from "./models.js";`, '', 'let a: Pet;'));
});

test('custom aliases', () => {
  const f = file('pets/client.ts');
  const models = module('pets/models.ts');
  f`interface ${f.ident('Client').as('Ignored')} {}`;
  f`let a: ${models.ident('Pet').ty().as('PetModel')};`;
  // The same name can be imported under several aliases.
  f`let b: ${models.ident('Pet').ty().as('Animal')};`;
  f`let c: ${models.ident('Pet').ty()};`;
  // An alias that is taken still gets "$" added.
  f`let d: ${module('zod').ident('z').as('Client')}.string();`;
  f`let e: ${module('temporal').ident('Temporal.Instant').ty().as('T')};`;
  assert.equal(
    content(f),
    lines(
      `import type { Temporal as T } from "temporal";`,
      `import { z as Client$ } from "zod";`,
      '',
      `import type { Pet, Pet as Animal, Pet as PetModel } from "./models.js";`,
      '',
      'interface Client {}',
      'let a: PetModel;',
      'let b: Animal;',
      'let c: Pet;',
      'let d: Client$.string();',
      'let e: T.Instant;',
    ),
  );
});

test('doc', () => {
  const f = file('a.ts');
  f.doc('Returns a pet.\n\nIt is looked up by its ID, and */ is escaped.\n  - an indented item\n');
  f`function get(): void {}`;
  f`interface Client {`;
  f.indent(() => {
    f.doc('  Only one line.  ');
    f`list(): void;`;
    f.doc('Is the second.');
    f`get(): void;`;
  });
  f`}`;
  // A comment with nothing in it is not printed.
  f.indent((f) => f.indent((f) => f.doc(' \n ')));
  assert.equal(
    content(f),
    lines(
      '/**',
      ' * Returns a pet.',
      ' *',
      String.raw` * It is looked up by its ID, and *\/ is escaped.`,
      ' *   - an indented item',
      ' */',
      'function get(): void {}',
      'interface Client {',
      '  /**',
      '   * Only one line.',
      '   */',
      '  list(): void;',
      '  /**',
      '   * Is the second.',
      '   */',
      '  get(): void;',
      '}',
    ),
  );
});

test('doc wraps', () => {
  const f = file('a.ts');
  f.indent(() =>
    f.indent(() =>
      f.doc(
        'The URL the paths of the API are relative to, which defaults to the first server of the description.\n' +
          '  - an item of a list whose words are wrapped under it when they do not fit on the line\n' +
          'See https://developers.cloudflare.com/fundamentals/api/reference/a-very-long-path-that-does-not-fit/ for more.',
      ),
    ),
  );
  const got = content(f);
  assert.equal(
    got,
    lines(
      '    /**',
      '     * The URL the paths of the API are relative to, which defaults to the first',
      '     * server of the description.',
      '     *   - an item of a list whose words are wrapped under it when they do not',
      '     *   fit on the line',
      '     * See',
      '     * https://developers.cloudflare.com/fundamentals/api/reference/a-very-long-path-that-does-not-fit/',
      '     * for more.',
      '     */',
    ),
  );
  for (const line of got.split('\n').filter((line) => !line.includes('https://'))) {
    assert.ok(line.length <= 80, `${JSON.stringify(line)} is longer than 80 columns`);
  }
});

test('indent', () => {
  const f = file('a.ts');
  f`a {`;
  f.indent(() => {
    f`b {`;
    f.indent(() => {
      f`c;`;
      // A blank line has no indentation.
      f``;
      f();
      f('', '');
    });
    f`}`;
  });
  f`}`;
  assert.equal(content(f), lines('a {', '  b {', '    c;', '', '', '', '  }', '}'));
});

test('imports break', () => {
  const f = file('a.ts');
  const m = module('some/long/module/path.ts');
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf']) {
    f`let ${name.toLowerCase()} = ${m.ident(name)};`;
  }
  assert.ok(
    content(f).startsWith(
      lines(
        'import {',
        '  Alpha,',
        '  Bravo,',
        '  Charlie,',
        '  Delta,',
        '  Echo,',
        '  Foxtrot,',
        '  Golf,',
        `} from "./some/long/module/path.js";`,
      ),
    ),
  );

  // A file with nothing printed renders as nothing, so forge doesn't write it.
  assert.equal(file('empty.ts').content, '');
});

test('parts', () => {
  const models = module('models.ts');
  const pet = models.ident('Pet').ty();
  const f = file('a.ts');
  f`let a: ${pet};`;
  // Numbers, booleans, bigints and joins print as String writes them.
  f`let b = [${join(', ', [1, 2, 3])}];`;
  f`let c = ${1.5}, d = ${true}, e = ${10n};`;
  // A value of a plugin's own prints as its string.
  const version = { toString: () => 'v2' };
  f`const version = "${String(version)}";`;
  // A fragment made before the file carries its imports.
  const owner = frag`${models.ident('Owner')} | null`;
  f`let g: ${owner};`;
  // A join of identifiers imports each.
  f`type H = ${join(' | ', [models.ident('A'), models.ident('B').ty()])};`;
  // p also takes parts made at run time, and an array prints its parts in
  // turn, even first, where it isn't taken for a template's strings.
  f('let i: ', [pet, '[]'], ';');
  f(['let k = ', 1], ';');
  f`let j: ${['Array<', [models.ident('Owner').ty()], '>']};`;
  assert.equal(
    content(f),
    lines(
      `import { A, type B, Owner, type Pet } from "./models.js";`,
      '',
      'let a: Pet;',
      'let b = [1, 2, 3];',
      'let c = 1.5, d = true, e = 10;',
      `const version = "v2";`,
      'let g: Owner | null;',
      'type H = A | B;',
      'let i: Pet[];',
      'let k = 1;',
      'let j: Array<Owner>;',
    ),
  );
});

test('only parts print', () => {
  const f = file('a.ts');
  // These would print as "undefined", "null" or "[object Object]", even
  // inside an array.
  for (const [part, message] of [
    [undefined, /cannot print undefined/],
    [null, /cannot print null/],
    [{ name: 'x' }, /cannot print object/],
    [['a', undefined], /cannot print undefined/],
  ]) {
    assert.throws(() => f`let x = ${part};`, message);
  }
  assert.equal(f.content, '');
});

test('joins leave out empty parts', () => {
  assert.equal(text(join(', ', ['a', '', 'b', ''])), 'a, b');
  assert.equal(text(join(', ', ['', ''])), '');
  const pet = module('models.ts').ident('Pet');
  // A part that prints nothing is left out, an empty array among them.
  assert.equal(text(frag`[${join(', ', [1, '', pet, frag``, [['']]])}]`), '[1, Pet]');
  assert.deepEqual(join(', ', []), []);
});

test('display', () => {
  // toString writes names unchanged, ignoring aliases.
  const pet = module('models.ts').ident('Temporal.Instant').as('T');
  assert.equal(pet.toString(), 'Temporal.Instant');
  assert.equal(text(frag`Promise<${pet}[]>`), 'Promise<Temporal.Instant[]>');
});

test('models', () => {
  // Stand-ins for the forge's groups and models: what module.group and
  // ident.model read of them.
  const name = (...words) => ({
    words,
    camel: () => words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join(''),
    pascal: () => words.map((w) => w[0].toUpperCase() + w.slice(1)).join(''),
  });
  const root = { path: [] };
  const petStore = { path: [name('pet', 'store')] };
  const listAll = { path: [name('pet', 'store'), name('list', 'all')] };
  const owner = { schemaName: 'pet_owner', name: name('pet', 'owner'), group: listAll, toString: () => 'pet_owner' };
  const twoFa = { schemaName: '2fa', name: name('2fa'), group: root, toString: () => '2fa' };

  assert.equal(module.ROOT.sub('models.ts').path, 'models.ts');
  assert.equal(module.group(root).path, module.ROOT.path);
  assert.equal(module.group(petStore).path, 'petStore');
  assert.equal(module.group(listAll).sub('client.ts').path, 'petStore/listAll/client.ts');
  assert.equal(ident.model(owner).module.path, 'petStore/listAll/models.ts');
  assert.equal(ident.model(owner).name, 'PetOwner');
  assert.equal(ident.model(twoFa).module.path, 'models.ts');
  assert.equal(ident.model(twoFa).name, '_2fa');

  const f = file('petStore/client.ts');
  // A model prints as its identifier.
  f`let owner: ${owner};`;
  f`let factor: ${ident.model(twoFa).ty()};`;
  // A plugin that names a model differently prints its own identifier.
  const errOwner = ident.model(owner).ty();
  f`let failure: ${ident(`Err${errOwner.name}`, errOwner.module, { typeOnly: true })};`;
  assert.equal(
    content(f),
    lines(
      `import type { _2fa } from "../models.js";`,
      `import { type ErrPetOwner, PetOwner } from "./listAll/models.js";`,
      '',
      'let owner: PetOwner;',
      'let factor: _2fa;',
      'let failure: ErrPetOwner;',
    ),
  );
});
