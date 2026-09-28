import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { findRequestParameter } from './sdk-map-ast.ts';

test('findRequestParameter finds request after positional arguments', () => {
  const source = ts.createSourceFile(
    'Client.ts',
    'class Client { upload(file: Blob, request: UploadRequest, options?: RequestOptions): void {} }',
    ts.ScriptTarget.Latest,
    true,
  );
  const classDeclaration = source.statements.find(ts.isClassDeclaration);
  const method = classDeclaration?.members.find(ts.isMethodDeclaration);
  assert.ok(method);

  const request = findRequestParameter(method);
  assert.ok(request && ts.isIdentifier(request.name));
  assert.equal(request.name.text, 'request');
});
