import type { RuleDefinition } from '../utils/types.ts';
import { booleanExtensions } from './boolean-extensions.ts';
import { compatibleAllofIntersection } from './compatible-allof-intersection.ts';
import { contentTypeOnlyForMultipart } from './content-type-only-for-multipart.ts';
import { explodedFormDataIsArray } from './exploded-form-data-is-array.ts';
import { noComplexQueryParams } from './no-complex-query-params.ts';
import { noConflictingParameterNames } from './no-conflicting-parameter-names.ts';
import { noConflictingPropertyNames } from './no-conflicting-property-names.ts';
import { noConflictingSchemaNames } from './no-conflicting-schema-names.ts';
import { noDuplicateAuthHeaderParameters } from './no-duplicate-auth-header-parameters.ts';
import { noDuplicateMethodName } from './no-duplicate-method-name.ts';
import { noGetRequestBody } from './no-get-request-body.ts';
import { noInvalidTagNamesOrFrontmatter } from './no-invalid-tag-names-or-frontmatter.ts';
import { noMultipartAllofComposition } from './no-multipart-allof-composition.ts';
import { noOpenApiV2InDocs } from './no-openapi-v2-in-docs.ts';
import { noRedundantAllofRefWrapper } from './no-redundant-allof-ref-wrapper.ts';
import { validAliases } from './valid-aliases.ts';
import { validAvailability } from './valid-availability.ts';
import { validGroupName } from './valid-group-name.ts';
import { validIdentifiers } from './valid-identifiers.ts';
import { validSchemaDefaults } from './valid-schema-defaults.ts';

export const ruleDefinitions: RuleDefinition[] = [
  booleanExtensions,
  compatibleAllofIntersection,
  contentTypeOnlyForMultipart,
  explodedFormDataIsArray,
  noComplexQueryParams,
  noConflictingParameterNames,
  noConflictingPropertyNames,
  noConflictingSchemaNames,
  noDuplicateAuthHeaderParameters,
  noDuplicateMethodName,
  noGetRequestBody,
  noInvalidTagNamesOrFrontmatter,
  noMultipartAllofComposition,
  noOpenApiV2InDocs,
  noRedundantAllofRefWrapper,
  validAliases,
  validAvailability,
  validGroupName,
  validIdentifiers,
  validSchemaDefaults,
].sort((left, right) => left.name.localeCompare(right.name));
