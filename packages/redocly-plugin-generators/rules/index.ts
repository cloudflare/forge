import type { RuleDefinition } from '../utils/types.ts';
import { contentTypeOnlyForMultipart } from './content-type-only-for-multipart.ts';
import { explodedFormDataIsArray } from './exploded-form-data-is-array.ts';
import { noComplexQueryParams } from './no-complex-query-params.ts';
import { noConflictingEndpointPaths } from './no-conflicting-endpoint-paths.ts';
import { noConflictingParameterNames } from './no-conflicting-parameter-names.ts';
import { noDuplicateAuthHeaderParameters } from './no-duplicate-auth-header-parameters.ts';
import { noDuplicatePathPlaceholders } from './no-duplicate-path-placeholders.ts';
import { noGetRequestBody } from './no-get-request-body.ts';
import { noInvalidTagNamesOrFrontmatter } from './no-invalid-tag-names-or-frontmatter.ts';
import { noOpenApiV2InDocs } from './no-openapi-v2-in-docs.ts';
import { onlyObjectExtensions } from './only-object-extensions.ts';
import { validSchemaDefaults } from './valid-schema-defaults.ts';

export const ruleDefinitions: RuleDefinition[] = [
  contentTypeOnlyForMultipart,
  explodedFormDataIsArray,
  noComplexQueryParams,
  noConflictingEndpointPaths,
  noConflictingParameterNames,
  noDuplicateAuthHeaderParameters,
  noDuplicatePathPlaceholders,
  noGetRequestBody,
  noInvalidTagNamesOrFrontmatter,
  noOpenApiV2InDocs,
  onlyObjectExtensions,
  validSchemaDefaults,
].sort((left, right) => left.name.localeCompare(right.name));
