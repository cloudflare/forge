import type { RuleDefinition } from '../utils/types.ts';
import { booleanExtensions } from './boolean-extensions.ts';
import { contentTypeOnlyForMultipart } from './content-type-only-for-multipart.ts';
import { explodedFormDataIsArray } from './exploded-form-data-is-array.ts';
import { noComplexQueryParams } from './no-complex-query-params.ts';
import { noConflictingEndpointPaths } from './no-conflicting-endpoint-paths.ts';
import { noConflictingParameterNames } from './no-conflicting-parameter-names.ts';
import { noDuplicateAuthHeaderParameters } from './no-duplicate-auth-header-parameters.ts';
import { noDuplicateOverrides } from './no-duplicate-overrides.ts';
import { noDuplicatePathPlaceholders } from './no-duplicate-path-placeholders.ts';
import { noGetRequestBody } from './no-get-request-body.ts';
import { noInvalidTagNamesOrFrontmatter } from './no-invalid-tag-names-or-frontmatter.ts';
import { noMultipartAllofComposition } from './no-multipart-allof-composition.ts';
import { noOpenApiV2InDocs } from './no-openapi-v2-in-docs.ts';
import { onlyObjectExtensions } from './only-object-extensions.ts';
import { validAliases } from './valid-aliases.ts';
import { validAvailability } from './valid-availability.ts';
import { validGroupName } from './valid-group-name.ts';
import { validIdentifiers } from './valid-identifiers.ts';
import { validSchemaDefaults } from './valid-schema-defaults.ts';

export const ruleDefinitions: RuleDefinition[] = [
  booleanExtensions,
  contentTypeOnlyForMultipart,
  explodedFormDataIsArray,
  noComplexQueryParams,
  noConflictingEndpointPaths,
  noConflictingParameterNames,
  noDuplicateAuthHeaderParameters,
  noDuplicateOverrides,
  noDuplicatePathPlaceholders,
  noGetRequestBody,
  noInvalidTagNamesOrFrontmatter,
  noMultipartAllofComposition,
  noOpenApiV2InDocs,
  onlyObjectExtensions,
  validAliases,
  validAvailability,
  validGroupName,
  validIdentifiers,
  validSchemaDefaults,
].sort((left, right) => left.name.localeCompare(right.name));
