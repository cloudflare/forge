type OpenApiObject = Record<string, unknown>;

type ParameterEntry = {
  resolved: OpenApiObject;
};

export type FernCompatibilityFixes = {
  incompatibleExamples: number;
  undiscriminatedUnionCommonProperties: number;
  mapArrayValueSchemas: number;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function isRecord(value: unknown): value is OpenApiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(parent: OpenApiObject | undefined, key: string): OpenApiObject | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function resolveLocalRef(document: OpenApiObject, value: unknown): OpenApiObject | undefined {
  if (!isRecord(value)) return undefined;

  const ref = value['$ref'];
  if (typeof ref !== 'string') return value;
  if (!ref.startsWith('#/')) return undefined;

  let current: unknown = document;
  for (const encodedSegment of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function parameterEntries(document: OpenApiObject, owner: OpenApiObject): ParameterEntry[] {
  const parameters = owner['parameters'];
  if (!Array.isArray(parameters)) return [];

  return parameters.flatMap((value) => {
    const resolved = resolveLocalRef(document, value);
    return resolved ? [{ resolved }] : [];
  });
}

function forEachOperation(
  document: OpenApiObject,
  visitor: (
    path: string,
    pathItem: OpenApiObject,
    operation: OpenApiObject,
    method: (typeof HTTP_METHODS)[number],
  ) => void,
): void {
  const paths = child(document, 'paths');
  if (!paths) return;

  for (const [path, value] of Object.entries(paths)) {
    if (!isRecord(value)) continue;
    for (const method of HTTP_METHODS) {
      const operation = child(value, method);
      if (operation) visitor(path, value, operation, method);
    }
  }
}

function forEachRequestBodySchema(document: OpenApiObject, visitor: (schema: OpenApiObject) => void): void {
  const visited = new WeakSet<OpenApiObject>();
  const visitRequestBody = (value: unknown): void => {
    const requestBody = resolveLocalRef(document, value);
    const content = child(requestBody, 'content');
    if (!content) return;

    for (const mediaTypeValue of Object.values(content)) {
      const mediaType = isRecord(mediaTypeValue) ? mediaTypeValue : undefined;
      const schema = resolveLocalRef(document, mediaType?.['schema']);
      if (!schema || visited.has(schema)) continue;
      visited.add(schema);
      visitor(schema);
    }
  };

  const requestBodies = child(child(document, 'components'), 'requestBodies');
  if (requestBodies) {
    for (const requestBody of Object.values(requestBodies)) visitRequestBody(requestBody);
  }
  forEachOperation(document, (_path, _pathItem, operation) => visitRequestBody(operation['requestBody']));
}

function repairParameterExample(document: OpenApiObject, parameter: OpenApiObject): number {
  const schema = resolveLocalRef(document, parameter['schema']);
  const anyOf = schema?.['anyOf'];
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return 0;

  for (let refIndex = 0; refIndex < anyOf.length; refIndex++) {
    const refBranch = anyOf[refIndex];
    const literalBranch = anyOf[1 - refIndex];
    if (!isRecord(refBranch) || typeof refBranch['$ref'] !== 'string' || !isRecord(literalBranch)) continue;

    const referenced = resolveLocalRef(document, refBranch);
    const enumValues = literalBranch['enum'];
    if (
      !referenced ||
      !Object.hasOwn(referenced, 'example') ||
      Array.isArray(referenced['enum']) ||
      !Array.isArray(enumValues) ||
      enumValues.length !== 1 ||
      referenced['type'] !== literalBranch['type'] ||
      Object.is(referenced['example'], enumValues[0])
    ) {
      continue;
    }

    // Fern collapses this anyOf to its literal branch, then applies the
    // referenced branch's example to that literal. Removing the
    // documentation-only example leaves the accepted wire values unchanged.
    delete referenced['example'];
    return 1;
  }
  return 0;
}

function repairIncompatibleParameterExamples(document: OpenApiObject): number {
  let repaired = 0;
  const visited = new WeakSet<OpenApiObject>();
  const visitParameters = (owner: OpenApiObject): void => {
    for (const { resolved } of parameterEntries(document, owner)) {
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      repaired += repairParameterExample(document, resolved);
    }
  };

  const parameters = child(child(document, 'components'), 'parameters');
  if (parameters) {
    for (const parameter of Object.values(parameters)) {
      const resolved = resolveLocalRef(document, parameter);
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved);
        repaired += repairParameterExample(document, resolved);
      }
    }
  }
  forEachOperation(document, (_path, pathItem, operation) => {
    visitParameters(pathItem);
    visitParameters(operation);
  });
  return repaired;
}

function isRedundantPropertyConstraint(document: OpenApiObject, baseValue: unknown, branchValue: unknown): boolean {
  if (!isRecord(branchValue) || Object.keys(branchValue).length !== 1) return false;
  const branchType = branchValue['type'];
  if (typeof branchType !== 'string') return false;
  return resolveLocalRef(document, baseValue)?.['type'] === branchType;
}

function containsInlineNamedShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value['$ref'] === 'string') return false;
  if (
    value['type'] === 'object' ||
    Array.isArray(value['enum']) ||
    Array.isArray(value['allOf']) ||
    Array.isArray(value['anyOf']) ||
    Array.isArray(value['oneOf'])
  ) {
    return true;
  }
  return value['type'] === 'array' ? containsInlineNamedShape(value['items']) : false;
}

/**
 * Fern models properties beside an undiscriminated `oneOf` as union base
 * properties. The patched TypeScript generator preserves those properties in
 * the alias, but Fern 3.80 does not emit inline declarations reachable only
 * through the base-property list. Move the common object shape into each
 * branch when branch-local duplicates add no constraints of their own.
 */
function distributeUndiscriminatedUnionProperties(document: OpenApiObject, schema: OpenApiObject): number {
  const properties = child(schema, 'properties');
  const oneOf = schema['oneOf'];
  const required = schema['required'];
  if (
    schema['type'] !== 'object' ||
    !properties ||
    Object.keys(properties).length === 0 ||
    !Object.values(properties).some(containsInlineNamedShape) ||
    !Array.isArray(oneOf) ||
    oneOf.length === 0 ||
    (required !== undefined && (!Array.isArray(required) || required.some((name) => typeof name !== 'string')))
  ) {
    return 0;
  }

  const branches: Array<{
    branch: OpenApiObject;
    properties: OpenApiObject;
    required: string[];
  }> = [];
  for (const value of oneOf) {
    if (
      !isRecord(value) ||
      value['$ref'] !== undefined ||
      value['type'] !== 'object' ||
      value['additionalProperties'] !== undefined
    ) {
      return 0;
    }
    const branchProperties = child(value, 'properties') ?? {};
    const branchRequired = value['required'];
    if (
      branchRequired !== undefined &&
      (!Array.isArray(branchRequired) || branchRequired.some((name) => typeof name !== 'string'))
    ) {
      return 0;
    }
    for (const [name, branchProperty] of Object.entries(branchProperties)) {
      if (
        Object.hasOwn(properties, name) &&
        !isRedundantPropertyConstraint(document, properties[name], branchProperty)
      ) {
        return 0;
      }
    }
    branches.push({
      branch: value,
      properties: branchProperties,
      required: (branchRequired ?? []) as string[],
    });
  }

  const commonRequired = (required ?? []) as string[];
  for (const branch of branches) {
    const uniqueBranchProperties = Object.fromEntries(
      Object.entries(branch.properties).filter(([name]) => !Object.hasOwn(properties, name)),
    );
    branch.branch['properties'] = {
      ...properties,
      ...uniqueBranchProperties,
    };
    const combinedRequired = [...new Set([...commonRequired, ...branch.required])];
    if (combinedRequired.length > 0) {
      branch.branch['required'] = combinedRequired;
    } else {
      delete branch.branch['required'];
    }
    if (schema['additionalProperties'] !== undefined) {
      branch.branch['additionalProperties'] = schema['additionalProperties'];
    }
  }

  delete schema['properties'];
  delete schema['required'];
  delete schema['additionalProperties'];
  return 1;
}

function repairUndiscriminatedUnionCommonProperties(document: OpenApiObject): number {
  let repaired = 0;
  forEachRequestBodySchema(document, (schema) => {
    repaired += distributeUndiscriminatedUnionProperties(document, schema);
  });
  return repaired;
}

function syntheticComponentName(parts: readonly string[]): string {
  const suffix = parts
    .flatMap((part) => part.split(/[^a-zA-Z0-9]+/))
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return `FernCompatibility${suffix || 'Anonymous'}`;
}

function addSyntheticComponent(document: OpenApiObject, parts: readonly string[], schema: OpenApiObject): string {
  let components = child(document, 'components');
  if (!components) {
    components = {};
    document['components'] = components;
  }
  let schemas = child(components, 'schemas');
  if (!schemas) {
    schemas = {};
    components['schemas'] = schemas;
  }

  const baseName = syntheticComponentName(parts);
  let name = baseName;
  let suffix = 2;
  while (Object.hasOwn(schemas, name)) {
    name = `${baseName}${suffix}`;
    suffix++;
  }
  schemas[name] = schema;
  return name;
}

function repairMapArrayValueSchemasIn(
  document: OpenApiObject,
  value: unknown,
  parts: readonly string[],
  visited: WeakSet<OpenApiObject>,
): number {
  const schema = resolveLocalRef(document, value);
  if (!schema || visited.has(schema)) return 0;
  visited.add(schema);

  let repaired = 0;
  const additionalProperties = schema['additionalProperties'];
  if (
    isRecord(additionalProperties) &&
    additionalProperties['$ref'] === undefined &&
    additionalProperties['type'] === 'array'
  ) {
    const items = additionalProperties['items'];
    if (
      isRecord(items) &&
      items['$ref'] === undefined &&
      (items['type'] === 'object' || child(items, 'properties') !== undefined)
    ) {
      const name = addSyntheticComponent(document, [...parts, 'map-value'], additionalProperties);
      schema['additionalProperties'] = {
        $ref: `#/components/schemas/${name}`,
      };
      repaired++;
      repaired += repairMapArrayValueSchemasIn(document, additionalProperties, [...parts, 'map-value'], visited);
    }
  }

  const properties = child(schema, 'properties');
  if (properties) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      repaired += repairMapArrayValueSchemasIn(document, propertySchema, [...parts, name], visited);
    }
  }
  if (isRecord(additionalProperties) && schema['additionalProperties'] === additionalProperties) {
    repaired += repairMapArrayValueSchemasIn(document, additionalProperties, [...parts, 'map-value'], visited);
  }
  repaired += repairMapArrayValueSchemasIn(document, schema['items'], [...parts, 'item'], visited);
  for (const composition of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[composition];
    if (!Array.isArray(branches)) continue;
    for (let index = 0; index < branches.length; index++) {
      repaired += repairMapArrayValueSchemasIn(
        document,
        branches[index],
        [...parts, composition, String(index)],
        visited,
      );
    }
  }
  return repaired;
}

/**
 * Fern 3.80 names an inline `map<string, array<object>>` declaration `Value`
 * but references it as `Item`. Lifting the complete array schema into a named
 * component keeps every array/item constraint and gives both sides one stable
 * type identity.
 */
function repairMapArrayValueSchemas(document: OpenApiObject): number {
  let repaired = 0;
  const visited = new WeakSet<OpenApiObject>();
  forEachOperation(document, (path, _pathItem, operation, method) => {
    const operationName = typeof operation['operationId'] === 'string' ? operation['operationId'] : `${method}-${path}`;
    const responses = child(operation, 'responses');
    if (!responses) return;

    for (const [status, responseValue] of Object.entries(responses)) {
      const response = resolveLocalRef(document, responseValue);
      const content = child(response, 'content');
      if (!content) continue;

      for (const [mediaType, mediaTypeValue] of Object.entries(content)) {
        const media = isRecord(mediaTypeValue) ? mediaTypeValue : undefined;
        repaired += repairMapArrayValueSchemasIn(
          document,
          media?.['schema'],
          [operationName, 'response', status, mediaType],
          visited,
        );
      }
    }
  });
  return repaired;
}

/** Repair narrowly shaped OpenAPI constructs that Fern 5.68 cannot convert. */
export function applyFernCompatibilityFixes(openapi: object): FernCompatibilityFixes {
  const document = openapi as unknown as OpenApiObject;
  return {
    incompatibleExamples: repairIncompatibleParameterExamples(document),
    undiscriminatedUnionCommonProperties: repairUndiscriminatedUnionCommonProperties(document),
    mapArrayValueSchemas: repairMapArrayValueSchemas(document),
  };
}
