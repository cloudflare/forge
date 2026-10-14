export { default } from './integration.ts';
export { default as astroFern } from './integration.ts';
export { defineFernManifest } from './manifest.ts';
export { createOperationExtensionDataAccessor, defineFernExtension, getOperationExtensionData } from './extensions.ts';
export type {
  FernExtension,
  FernExtensionDataRegistry,
  FernExtensionDefinition,
  FernExtensionLogger,
  FernExtensionPrepareContext,
  FernOperationExtensionContext,
  FernOperationExtensionContribution,
  FernOperationPresentation,
  FernOperationVariant,
} from './extensions.ts';
export type {
  FernManifest,
  FernProductConfig,
  FernSectionConfig,
  FernTargetConfig,
  FernTargetKind,
} from './manifest.ts';
export { buildFernContent, defineFernProject } from './project.ts';
export type { FernOperationRoutingPreferenceContext } from './content/build.ts';
export type {
  AgentScope,
  AstroFernAgentsOptions,
  AstroFernIntegrationOptions,
  AstroFernRoutingOptions,
  FernRuntimeConfig,
  FernTargetRouting,
} from './runtime-config.ts';
export type {
  FernContentProjectData,
  FernContentOptions,
  FernManifestProvider,
  FernManifestProviderContext,
  FernProject,
  FernProjectBuildContext,
  FernProjectOptions,
  FernProjectSource,
  FernContentSource,
  FernSnapshotSource,
  FernSnapshotSources,
  FernSourceOperation,
  FernSource,
  FernSourceProvider,
} from './project.ts';
export type {
  FernAgentLinksSchema,
  FernAgentRoute,
  FernCatalogMetadata,
  FernCatalogPage,
  FernCatalogProduct,
  FernCatalogSiteSnapshot,
  FernCatalogSnapshot,
  FernExecutionTargetSchema,
  FernHumanRoute,
  FernPageSchema,
  FernProjectData,
  FernProjectView,
  FernRoutePlan,
} from './route-plan.ts';
export { buildSnapshotSwitch } from './route-context.ts';
export type { FernRouteContext, SnapshotSwitchOption } from './route-context.ts';
export { isJsonMediaType, preferredRequestRepresentation } from './content/request-body.ts';
export {
  buildBodyExample,
  createSnippetProvider,
  interpolatePath,
  placeholderValue,
  toEnvVar,
} from './snippets/index.ts';
export type {
  Snippet,
  SnippetInput,
  SnippetOperation,
  SnippetParam,
  SnippetRequestBody,
  SnippetRequestRepresentation,
  SnippetProvider,
  SnippetRenderer,
  SnippetRendererConfig,
} from './snippets/index.ts';
