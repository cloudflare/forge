#!/usr/bin/env node
// Patch fern-typescript-sdk cli.cjs for Cloudflare:
// 2) Emit element-access expressions for non-identifier multipart file keys.
// 3) Preserve base properties on undiscriminated union TypeScript aliases.
//    Fern's IR carries stream-condition as a literal base property, but 3.80.1
//    drops undiscriminatedUnion.baseProperties in generated types.
// 4) Align the native-fetch Headers fallback with TypeScript 6 HeadersIterator.
// 5) Support deterministic file ownership for canonical-IR generation shards.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const headersPath = process.argv[3];
if (!path) {
  console.error('usage: patch-fern-typescript-cli.mjs <cli.cjs> [Headers.ts]');
  process.exit(2);
}

const original = readFileSync(path, 'utf8');
let next = original;

// ---- 2) multipart non-identifier keys ----
// Replace:
//   createIdentifier(getParameterNameForFile({...}))
// with a helper that returns PropertyAccess or ElementAccess expressions.
const helperName = 'createInlineFilePropertyAccess';
if (!next.includes(`function ${helperName}(`)) {
  const getParamFnStart = next.indexOf(
    'function getParameterNameForFile({ property: property3, wrapperName, includeSerdeLayer, retainOriginalCasing, inlineFileProperties, caseConverter }) {',
  );
  if (getParamFnStart < 0) {
    console.error('getParameterNameForFile not found');
    process.exit(1);
  }
  const appendMarker = '// ../client-class-generator/lib/endpoints/utils/appendPropertyToFormData.js';
  const appendAt = next.indexOf(appendMarker, getParamFnStart);
  if (appendAt < 0) {
    console.error('appendPropertyToFormData marker not found after getParameterNameForFile');
    process.exit(1);
  }

  // Keep getParameterNameForFile returning only the property name (not request.name).
  // The helper builds the request.<name> / request["name"] expression.
  const replacement = `function getParameterNameForFile({ property: property3, wrapperName, includeSerdeLayer, retainOriginalCasing, inlineFileProperties, caseConverter }) {
  const parameterName = includeSerdeLayer && !retainOriginalCasing ? caseConverter.camelUnsafe(property3.key) : getOriginalName2(property3.key);
  return parameterName;
}
function ${helperName}({ property: property3, wrapperName, includeSerdeLayer, retainOriginalCasing, inlineFileProperties, caseConverter }) {
  const parameterName = getParameterNameForFile({
    property: property3,
    wrapperName,
    includeSerdeLayer,
    retainOriginalCasing,
    inlineFileProperties,
    caseConverter
  });
  if (!inlineFileProperties) {
    return import_ts_morph67.ts.factory.createIdentifier(parameterName);
  }
  const object = import_ts_morph67.ts.factory.createIdentifier(wrapperName);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameterName)) {
    return import_ts_morph67.ts.factory.createPropertyAccessExpression(object, import_ts_morph67.ts.factory.createIdentifier(parameterName));
  }
  return import_ts_morph67.ts.factory.createElementAccessExpression(object, import_ts_morph67.ts.factory.createStringLiteral(parameterName));
}

`;
  next = next.slice(0, getParamFnStart) + replacement + next.slice(appendAt);

  // Original: createIdentifier(getParameterNameForFile({ ... }))
  // Target:   createInlineFilePropertyAccess({ ... })
  // Must remove the outer createIdentifier(...) wrapping paren.
  const callRe = /import_ts_morph67\.ts\.factory\.createIdentifier\(getParameterNameForFile\(([\s\S]*?)\)\)/g;
  let callCount = 0;
  next = next.replace(callRe, (_m, inner) => {
    callCount += 1;
    return `${helperName}(${inner})`;
  });
  if (callCount === 0) {
    console.error('createIdentifier(getParameterNameForFile(...)) call sites not found');
    process.exit(1);
  }
  console.log(`patched ${callCount} multipart file property access call site(s)`);
} else {
  console.log('already has createInlineFilePropertyAccess helper');
}

// ---- 3) undiscriminated-union base properties ----
// The direct importer correctly emits `baseProperties: [{ stream: literal<true> }]`
// for conditional streaming unions. TS 3.80.1 ignores that IR field, so both the
// public type and serialized request lose `stream: true`. Intersect every member
// with a generated base-property type literal. This applies generically to any
// undiscriminated union base properties and is a no-op for ordinary unions.
const undiscriminatedClass = 'var GeneratedUndiscriminatedUnionTypeImpl = class extends AbstractGeneratedType {';
const undiscriminatedFrom = `  generateForInlineUnion(context2) {
    const typeReferenceNodes = this.shape.members.map((member) => this.getTypeReferenceNode(context2, member));
    return {
      typeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => ref.typeNode)),
      requestTypeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => ref.requestTypeNode ?? ref.typeNode)),
      responseTypeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => ref.responseTypeNode ?? ref.typeNode))
    };
  }`;
const undiscriminatedTo = `  getBasePropertiesTypeNode(context2, whatFor = "normal") {
    const properties = this.shape.baseProperties ?? [];
    if (properties.length === 0) {
      return void 0;
    }
    return import_ts_morph101.ts.factory.createTypeLiteralNode(properties.map((property3) => {
      const type = context2.type.getReferenceToType(property3.valueType);
      const typeNode = whatFor === "request"
        ? type.requestTypeNode ?? type.typeNode
        : whatFor === "response"
          ? type.responseTypeNode ?? type.typeNode
          : type.typeNode;
      return import_ts_morph101.ts.factory.createPropertySignature(
        void 0,
        getPropertyKey(getWireValue2(property3.name)),
        void 0,
        typeNode
      );
    }));
  }
  withBaseProperties(context2, node2, whatFor = "normal") {
    const base = this.getBasePropertiesTypeNode(context2, whatFor);
    return base == null ? node2 : import_ts_morph101.ts.factory.createIntersectionTypeNode([base, node2]);
  }
  generateForInlineUnion(context2) {
    const typeReferenceNodes = this.shape.members.map((member) => this.getTypeReferenceNode(context2, member));
    return {
      typeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => this.withBaseProperties(context2, ref.typeNode))),
      requestTypeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => this.withBaseProperties(context2, ref.requestTypeNode ?? ref.typeNode, "request"))),
      responseTypeNode: import_ts_morph101.ts.factory.createUnionTypeNode(typeReferenceNodes.map((ref) => this.withBaseProperties(context2, ref.responseTypeNode ?? ref.typeNode, "response")))
    };
  }`;
const aliasFrom = `          node: this.getTypeNodeForMember(context2, value)`;
const aliasTo = `          node: this.withBaseProperties(context2, this.getTypeNodeForMember(context2, value))`;
const requestAliasFrom = `            node: this.applyIndexSignatureSubstitution(context2, value.member, requestNode)`;
const requestAliasTo = `            node: this.withBaseProperties(context2, this.applyIndexSignatureSubstitution(context2, value.member, requestNode), "request")`;
const responseAliasFrom = `            node: this.applyIndexSignatureSubstitution(context2, value.member, responseNode)`;
const responseAliasTo = `            node: this.withBaseProperties(context2, this.applyIndexSignatureSubstitution(context2, value.member, responseNode), "response")`;
if (next.includes(undiscriminatedFrom)) {
  const classStart = next.indexOf(undiscriminatedClass);
  const classEnd = next.indexOf('// ../../model/type-generator/lib/union/GeneratedUnionTypeImpl.js', classStart);
  if (classStart < 0 || classEnd < 0) {
    console.error('GeneratedUndiscriminatedUnionTypeImpl boundaries not found');
    process.exit(1);
  }
  const before = next.slice(0, classStart);
  let body = next.slice(classStart, classEnd);
  const after = next.slice(classEnd);
  for (const [from, to, label] of [
    [undiscriminatedFrom, undiscriminatedTo, 'inline union'],
    [aliasFrom, aliasTo, 'normal alias'],
    [requestAliasFrom, requestAliasTo, 'request alias'],
    [responseAliasFrom, responseAliasTo, 'response alias'],
  ]) {
    if (!body.includes(from)) {
      console.error(`undiscriminated-union ${label} target not found`);
      process.exit(1);
    }
    body = body.replace(from, to);
  }
  next = before + body + after;
  console.log('patched undiscriminated-union base properties into TS aliases');
} else if (
  next.includes('getBasePropertiesTypeNode(context2, whatFor = "normal")') &&
  next.includes('GeneratedUndiscriminatedUnionTypeImpl')
) {
  console.log('already preserves undiscriminated-union base properties');
} else {
  console.error('expected GeneratedUndiscriminatedUnionTypeImpl body not found');
  process.exit(1);
}

// ---- 5) canonical-IR generation shards ----
// Assign ownership after Fern resolves canonical paths and names.
const shardHelperName = 'cloudflareShardOwnsFile';
if (!next.includes(`function ${shardHelperName}(`)) {
  const sdkGeneratorMarker = 'var SdkGenerator = class {';
  const sdkGeneratorAt = next.indexOf(sdkGeneratorMarker);
  if (sdkGeneratorAt < 0) {
    console.error('SdkGenerator marker not found');
    process.exit(1);
  }
  const shardHelpers = `function cloudflareShardHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function ${shardHelperName}(filepath) {
  const count = Math.max(1, Number.parseInt(process.env.CLOUDFLARE_FERN_SHARD_COUNT ?? "1", 10));
  const index = Math.max(0, Number.parseInt(process.env.CLOUDFLARE_FERN_SHARD_INDEX ?? "0", 10));
  if (count <= 1) {
    return true;
  }
  if (filepath === "/src/Client.ts" || filepath === "/src/api/resources/index.ts" || !filepath.startsWith("/src/api/")) {
    return index === 0;
  }
  const segments = filepath.split("/").filter(Boolean);
  const resourceIndex = segments.indexOf("resources");
  return resourceIndex >= 0 && segments[resourceIndex + 1]
    ? cloudflareShardHash(segments[resourceIndex + 1]) % count === index
    : index === 0;
}
`;
  next = next.slice(0, sdkGeneratorAt) + shardHelpers + next.slice(sdkGeneratorAt);

  const sourceFileFrom = `  withSourceFile({ run, filepath, addExportTypeModifier, dynamicExportTypeModifier, packagePath = this.relativePackagePath }) {
    filepath.rootDir = packagePath;
    const filepathStr = this.exportsManager.convertExportedFilePathToFilePath(filepath);
    this.context.logger.debug(\`Generating \${filepathStr}\`);`;
  const sourceFileTo = `  withSourceFile({ run, filepath, addExportTypeModifier, dynamicExportTypeModifier, packagePath = this.relativePackagePath }) {
    filepath.rootDir = packagePath;
    const filepathStr = this.exportsManager.convertExportedFilePathToFilePath(filepath);
    if (!${shardHelperName}(filepathStr)) {
      return;
    }
    this.context.logger.debug(\`Generating \${filepathStr}\`);`;
  if (!next.includes(sourceFileFrom)) {
    console.error('withSourceFile shard hook not found');
    process.exit(1);
  }
  next = next.replace(sourceFileFrom, sourceFileTo);

  // The reducer resolves ESM imports against the merged tree.
  const esmFrom = `    if (customConfig.useLegacyExports === false) {
      await fixImportsForEsm(persistedTypescriptProject.getRootDirectory());
    }`;
  const esmTo = `    if (customConfig.useLegacyExports === false && Number.parseInt(process.env.CLOUDFLARE_FERN_SHARD_COUNT ?? "1", 10) <= 1) {
      await fixImportsForEsm(persistedTypescriptProject.getRootDirectory());
    }`;
  if (!next.includes(esmFrom)) {
    console.error('ESM postprocess shard hook not found');
    process.exit(1);
  }
  next = next.replace(esmFrom, esmTo);
  console.log('patched deterministic canonical-IR shard ownership');
} else {
  console.log('already supports canonical-IR shard ownership');
}

if (next !== original) {
  writeFileSync(path, next);
  console.log('wrote', path);
} else {
  console.log('no cli.cjs changes');
}

// ---- 4) TypeScript 6 DOM HeadersIterator compatibility ----
// TS 3.80.1's fallback Headers class declares IterableIterator, while current
// lib.dom.d.ts requires HeadersIterator (which includes the new disposable
// iterator fields). Runtime behavior is identical; align the declared types.
if (headersPath) {
  const originalHeaders = readFileSync(headersPath, 'utf8');
  const headersNext = originalHeaders
    .replaceAll('IterableIterator<[string, string]>', 'HeadersIterator<[string, string]>')
    .replaceAll('IterableIterator<string>', 'HeadersIterator<string>');
  if (headersNext !== originalHeaders) {
    writeFileSync(headersPath, headersNext);
    console.log('patched Headers.ts iterator return types for TypeScript 6');
  } else if (originalHeaders.includes('HeadersIterator<')) {
    console.log('Headers.ts already uses HeadersIterator');
  } else {
    console.error('expected Headers.ts IterableIterator declarations not found');
    process.exit(1);
  }
}
