import type { RuleDefinition } from '../utils/types.ts';
import { contentTypeOnlyForMultipart } from './content-type-only-for-multipart.ts';
import { explodedFormDataIsArray } from './exploded-form-data-is-array.ts';
import { matchingEnvironmentUrls } from './matching-environment-urls.ts';
import { noComplexQueryParams } from './no-complex-query-params.ts';
import { noComponentSchemaCollisions } from './no-component-schema-collisions.ts';
import { noConflictingEndpointParameters } from './no-conflicting-endpoint-parameters.ts';
import { noConflictingEndpointPaths } from './no-conflicting-endpoint-paths.ts';
import { noConflictingParameterNames } from './no-conflicting-parameter-names.ts';
import { noConflictingRequestWrapperProperties } from './no-conflicting-request-wrapper-properties.ts';
import { noDuplicateAuthHeaderParameters } from './no-duplicate-auth-header-parameters.ts';
import { noDuplicateDeclarations } from './no-duplicate-declarations.ts';
import { noDuplicateExampleNames } from './no-duplicate-example-names.ts';
import { noDuplicateFieldNames } from './no-duplicate-field-names.ts';
import { noDuplicateOverrides } from './no-duplicate-overrides.ts';
import { noExtensionsWithFileUpload } from './no-extensions-with-file-upload.ts';
import { noGetRequestBody } from './no-get-request-body.ts';
import { noInvalidTagNamesOrFrontmatter } from './no-invalid-tag-names-or-frontmatter.ts';
import { noMissingAuth } from './no-missing-auth.ts';
import { noNonComponentRefs } from './no-non-component-refs.ts';
import { noOpenApiV2InDocs } from './no-openapi-v2-in-docs.ts';
import { noResponseProperty } from './no-response-property.ts';
import { noSchemaTitleCollisions } from './no-schema-title-collisions.ts';
import { noUndefinedExampleReference } from './no-undefined-example-reference.ts';
import { noUndefinedPathParameters } from './no-undefined-path-parameters.ts';
import { noUndefinedTypeReference } from './no-undefined-type-reference.ts';
import { noUndefinedVariableReference } from './no-undefined-variable-reference.ts';
import { onlyObjectExtensions } from './only-object-extensions.ts';
import { validBasePath } from './valid-base-path.ts';
import { validBaseUrlEnv } from './valid-base-url-env.ts';
import { validExampleEndpointCall } from './valid-example-endpoint-call.ts';
import { validFieldNames } from './valid-field-names.ts';
import { validGlobalParameters } from './valid-global-parameters.ts';
import { validOauth } from './valid-oauth.ts';
import { validPagination } from './valid-pagination.ts';
import { validServiceUrls } from './valid-service-urls.ts';
import { validStreamCondition } from './valid-stream-condition.ts';
import { validTypeName } from './valid-type-name.ts';
import { validTypeReferenceWithDefaultAndValidation } from './valid-type-reference-with-default-and-validation.ts';
import { validVersion } from './valid-version.ts';
import { validWebhookSignature } from './valid-webhook-signature.ts';

export const ruleDefinitions: RuleDefinition[] = [
  contentTypeOnlyForMultipart,
  explodedFormDataIsArray,
  matchingEnvironmentUrls,
  noComplexQueryParams,
  noComponentSchemaCollisions,
  noConflictingEndpointParameters,
  noConflictingEndpointPaths,
  noConflictingParameterNames,
  noConflictingRequestWrapperProperties,
  noDuplicateAuthHeaderParameters,
  noDuplicateDeclarations,
  noDuplicateExampleNames,
  noDuplicateFieldNames,
  noDuplicateOverrides,
  noExtensionsWithFileUpload,
  noGetRequestBody,
  noInvalidTagNamesOrFrontmatter,
  noMissingAuth,
  noNonComponentRefs,
  noOpenApiV2InDocs,
  noResponseProperty,
  noSchemaTitleCollisions,
  noUndefinedExampleReference,
  noUndefinedPathParameters,
  noUndefinedTypeReference,
  noUndefinedVariableReference,
  onlyObjectExtensions,
  validBasePath,
  validBaseUrlEnv,
  validExampleEndpointCall,
  validFieldNames,
  validGlobalParameters,
  validOauth,
  validPagination,
  validServiceUrls,
  validStreamCondition,
  validTypeName,
  validTypeReferenceWithDefaultAndValidation,
  validVersion,
  validWebhookSignature,
].sort((left, right) => left.name.localeCompare(right.name));
