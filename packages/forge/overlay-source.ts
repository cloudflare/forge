import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAPIV3 } from 'openapi-types';
import { Forge } from './forge.js';
import { populateOperationMap } from './openapi-resolver.js';
import type { Schema } from './schema/schema.js';
import { isObject } from './shared/schema-utils.js';
import { ensureUniqueSdkMethodNames } from './shared/sdk-method-names.js';

import { stringify as toYaml } from 'yaml';
import type {
  ApiOverlay,
  ApiOverlayFile,
  ExtensionMethods,
  ForgeCommand,
  ForgeCommandConfig,
  ForgeCommandConfigMap,
  ForgeCommandMap,
  ForgeGroupInfo,
  ForgeGroupInfoMap,
  OverlayAction,
} from './overlay-types.ts';

type OpenApiDocument = OpenAPIV3.Document;

const METHOD_STATUSES: ReadonlySet<unknown> = new Set([
  'alpha',
  'beta',
  'preview',
  'generally-available',
  'deprecated',
]);

function isMethodStatus(value: unknown): value is Schema.method['status'] {
  return METHOD_STATUSES.has(value);
}

type OverlayResolution = {
  commands: Map<string, Schema.command>;
  overlaidOpenApi: OpenApiDocument;
};

export type ResolveOverlayOptions = {
  writeArtifacts?: boolean;
  allowMissingOperations?: boolean;
  artifactsDir?: string;
};

type OperationForgeMetadata = {
  operationId: string;
  /** Full dotted namespace: command.group.subgroup (first segment is the command name) */
  'x-fern-sdk-group-name': string;
  'x-fern-sdk-method-name': string;
  'x-fern-availability': ExtensionMethods['x-fern-availability'];
  /** Do not generate any code for this operation. */
  'x-fern-ignore': boolean;
  /** Generate code but hide behind CF_HIDE_COMMANDS env var. */
  'x-forge-hidden': boolean;
  /** Explicitly keep this upstream-internal operation in first-party SDKs. */
  'x-forge-internal'?: boolean;
  'x-forge-globals'?: ExtensionMethods['x-forge-globals'];
  'x-forge-epilogue'?: string;
  'x-forge-args'?: ExtensionMethods['x-forge-args'];
  'x-forge-params'?: ExtensionMethods['x-forge-params'];
  'x-forge-require-confirmation'?: ExtensionMethods['x-forge-require-confirmation'];
};

type OperationForgePayload = Omit<OperationForgeMetadata, 'operationId'>;

/** Extract the command name (first dot-separated segment) from x-fern-sdk-group-name. */
function getCommandFromGroup(group: string): string {
  const dot = group.indexOf('.');
  return dot === -1 ? group : group.slice(0, dot);
}

/** Extract the sub-group path (everything after the first dot) from x-fern-sdk-group-name, or undefined if top-level. */
function getSubGroupFromGroup(group: string): string | undefined {
  const dot = group.indexOf('.');
  return dot === -1 ? undefined : group.slice(dot + 1);
}

let rawOpenApiService: Forge | undefined;

const overlaidOutputDir = join(import.meta.dirname, 'overlays', '_generated');

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const operationIdPattern = /^[^"[\]]+$/;

/**
 * Kebab-case identifier: lowercase letters/digits separated by single
 * hyphens. Used to validate `paramOverride.flagName` values declared in
 * overlays so a typo like `flagName: 'mtlsCertificateId'` fails forge
 * generation rather than producing a broken cf flag name at the
 * downstream consumer.
 */
const kebabCasePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateParamOverrides(params: Record<string, Schema.paramOverride>, operationId: string): void {
  const errors: string[] = [];
  for (const [paramPath, override] of Object.entries(params)) {
    if (override.flagName !== undefined && !kebabCasePattern.test(override.flagName)) {
      errors.push(
        `${operationId}: paramOverride.flagName must be kebab-case (lowercase letters/digits, single hyphens) — got ${JSON.stringify(override.flagName)} for "${paramPath}"`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid paramOverride.flagName values:\n- ${errors.join('\n- ')}`);
  }
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (!isObject(value)) return false;
  if (!hasString(value, 'openapi') || !(value.openapi as string).startsWith('3.')) return false;
  if (!isObject(value.info) || !hasString(value.info, 'title') || !hasString(value.info, 'version')) return false;
  if (!isObject(value.paths)) return false;
  return true;
}

function isExtensionMethod(value: unknown): value is ExtensionMethods {
  if (!isObject(value)) return false;
  if (typeof value['x-fern-sdk-method-name'] !== 'string') return false;
  if (typeof value.operationId !== 'string') return false;
  if (typeof value['x-fern-availability'] !== 'string') return false;
  return true;
}

function isExtensionMethodGroup(
  value: unknown,
): value is ForgeCommand['methods'][number] & { methods: ExtensionMethods[] } {
  if (!isObject(value)) return false;
  if (typeof value['x-fern-sdk-group-name'] !== 'string') return false;
  if (typeof value.description !== 'string') return false;
  if (!Array.isArray(value.methods)) return false;
  return value.methods.every(isExtensionMethod);
}

function isForgeCommand(value: unknown): value is ForgeCommand {
  if (!isObject(value)) return false;
  if (typeof value.description !== 'string') return false;
  if (!Array.isArray(value.methods)) return false;
  return value.methods.every(
    (methodOrGroup) => isExtensionMethod(methodOrGroup) || isExtensionMethodGroup(methodOrGroup),
  );
}

function collectMethods(command: Schema.command): Schema.method[] {
  const items: Schema.method[] = [];
  function walk(methods: (Schema.method | Schema.methodGroup)[]) {
    for (const item of methods) {
      if ('methods' in item) {
        walk(item.methods);
      } else {
        items.push(item);
      }
    }
  }
  walk(command.methods);
  return items;
}

function toSchemaMethod(method: ExtensionMethods): Schema.method {
  const status: unknown = method['x-fern-availability'];
  if (!isMethodStatus(status)) {
    throw new Error(`${method.operationId}: invalid x-fern-availability ${String(status)}`);
  }

  if (status === 'deprecated') {
    const deprecated: Schema.method = {
      name: method['x-fern-sdk-method-name'],
      operationId: method.operationId,
      status: 'deprecated',
    };

    if (method['x-forge-epilogue'] !== undefined) deprecated.epilogue = method['x-forge-epilogue'];
    if (method['x-forge-args'] !== undefined) deprecated.args = method['x-forge-args'];
    if (method['x-forge-params'] !== undefined) {
      validateParamOverrides(method['x-forge-params'], method.operationId);
      deprecated.params = method['x-forge-params'];
    }
    if (method['x-forge-require-confirmation'] !== undefined)
      deprecated.requireConfirmation = method['x-forge-require-confirmation'];

    return deprecated;
  }

  const active: Schema.method = {
    name: method['x-fern-sdk-method-name'],
    operationId: method.operationId,
    status,
  };

  if (method['x-forge-epilogue'] !== undefined) active.epilogue = method['x-forge-epilogue'];
  if (method['x-forge-args'] !== undefined) active.args = method['x-forge-args'];
  if (method['x-forge-params'] !== undefined) {
    validateParamOverrides(method['x-forge-params'], method.operationId);
    active.params = method['x-forge-params'];
  }
  if (method['x-forge-require-confirmation'] !== undefined)
    active.requireConfirmation = method['x-forge-require-confirmation'];

  return active;
}

function toSchemaMethodFromMetadata(method: OperationForgeMetadata): Schema.method {
  const extensionMethod: ExtensionMethods = {
    'x-fern-sdk-method-name': method['x-fern-sdk-method-name'],
    operationId: method.operationId,
    'x-fern-availability': method['x-fern-availability'],
  };

  if (method['x-forge-epilogue'] !== undefined) extensionMethod['x-forge-epilogue'] = method['x-forge-epilogue'];
  if (method['x-forge-args'] !== undefined) extensionMethod['x-forge-args'] = method['x-forge-args'];
  if (method['x-forge-params'] !== undefined) extensionMethod['x-forge-params'] = method['x-forge-params'];
  if (method['x-forge-require-confirmation'] !== undefined)
    extensionMethod['x-forge-require-confirmation'] = method['x-forge-require-confirmation'];

  return toSchemaMethod(extensionMethod);
}

type GroupTreeNode = {
  methods: Schema.method[];
  children: Map<string, GroupTreeNode>;
  groupPath: string;
};

function createGroupTreeNode(groupPath: string): GroupTreeNode {
  return {
    methods: [],
    children: new Map(),
    groupPath,
  };
}

function addMethodToGroupTree(root: Map<string, GroupTreeNode>, groupPath: string, method: Schema.method) {
  const segments = groupPath.split('.').filter(Boolean);
  if (segments.length === 0) return;

  let currentChildren = root;
  let currentPath = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    currentPath = currentPath ? `${currentPath}.${segment}` : segment;
    const existing = currentChildren.get(segment) ?? createGroupTreeNode(currentPath);
    currentChildren.set(segment, existing);

    if (i === segments.length - 1) {
      existing.methods.push(method);
    } else {
      currentChildren = existing.children;
    }
  }
}

function groupTreeToMethodGroups(
  children: Map<string, GroupTreeNode>,
  groupInfo: Record<string, ForgeGroupInfo>,
): Schema.methodGroup[] {
  return Array.from(children.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, node]) => {
      const info = groupInfo[node.groupPath] ?? {};
      const childGroups = groupTreeToMethodGroups(node.children, groupInfo);
      return {
        name,
        description: info.description ?? `Operations for ${node.groupPath}`,
        ...(info['x-forge-epilogue'] !== undefined ? { epilogue: info['x-forge-epilogue'] } : {}),
        methods: [...node.methods, ...childGroups],
      } satisfies Schema.methodGroup;
    });
}

function toSchemaCommand(
  commandName: string,
  command: ForgeCommandConfig,
  methodMetadata: OperationForgeMetadata[],
  groupInfo: Record<string, ForgeGroupInfo>,
): Schema.command {
  const visibleMethods = methodMetadata.filter((method) => !method['x-fern-ignore']);
  const topLevelMethods: Schema.method[] = [];
  const groupTree = new Map<string, GroupTreeNode>();

  for (const method of visibleMethods) {
    const schemaMethod = toSchemaMethodFromMetadata(method);
    const subGroup = getSubGroupFromGroup(method['x-fern-sdk-group-name']);
    if (!subGroup) {
      topLevelMethods.push(schemaMethod);
      continue;
    }

    addMethodToGroupTree(groupTree, subGroup, schemaMethod);
  }

  const groups = groupTreeToMethodGroups(groupTree, groupInfo);

  return {
    name: commandName,
    description: command.description,
    methods: [...topLevelMethods, ...groups],
    globalCliArgs: methodMetadata.find((m) => m['x-forge-globals'])?.['x-forge-globals'] ?? [],
    hideCommand: visibleMethods.every((m) => m['x-forge-hidden']),
  };
}

function getOperationIdFromJsonPath(target: string): string | undefined {
  const match = target.match(/^\$\.paths\.\*\[\?@\.operationId==['"](.+)['"]\]$/);
  return match?.[1];
}

function toOperationTarget(operationId: string): string {
  if (!operationIdPattern.test(operationId)) {
    throw new Error(`Unsupported operationId for overlay target: ${JSON.stringify(operationId)}`);
  }

  // Use double quotes around the value so operationIds containing single
  // quotes (e.g. workers-kv-namespace-list-a-namespace'-s-keys) work.
  return `$.paths.*[?@.operationId=="${operationId}"]`;
}

function operationIdsIn(openapi: OpenApiDocument): Set<string> {
  const operationIds = new Set<string>();
  for (const pathItem of Object.values(openapi.paths ?? {})) {
    if (!isObject(pathItem)) continue;
    for (const method of methods) {
      const operation = pathItem[method];
      if (isObject(operation) && typeof operation.operationId === 'string') {
        operationIds.add(operation.operationId.replace(/'/g, ''));
      }
    }
  }
  return operationIds;
}

function filterCommandNode(value: unknown, operationIds: Set<string>): unknown | undefined {
  if (!isObject(value)) return value;
  if (typeof value.operationId === 'string') {
    return operationIds.has(value.operationId.replace(/'/g, '')) ? structuredClone(value) : undefined;
  }
  if (!Array.isArray(value.methods)) return structuredClone(value);

  const filteredMethods = value.methods
    .map((method) => filterCommandNode(method, operationIds))
    .filter((method) => method !== undefined);
  if (filteredMethods.length === 0) return undefined;
  return { ...structuredClone(value), methods: filteredMethods };
}

export function filterApiOverlaysForOpenApi(
  apiOverlays: ApiOverlayFile[],
  sourceOpenApi: OpenApiDocument,
): ApiOverlayFile[] {
  const operationIds = operationIdsIn(sourceOpenApi);
  const filtered: ApiOverlayFile[] = [];

  for (const api of apiOverlays) {
    let hasCommand = false;
    const actions: OverlayAction[] = [];

    for (const action of api.overlay.actions) {
      const operationId = getOperationIdFromJsonPath(action.target);
      if (operationId && !operationIds.has(operationId.replace(/'/g, ''))) continue;

      const update = isObject(action.update) ? action.update : undefined;
      const commands = update?.['x-forge-commands'];
      if (action.target === '$' && isObject(commands)) {
        const filteredCommands = Object.fromEntries(
          Object.entries(commands)
            .map(([name, command]) => [name, filterCommandNode(command, operationIds)] as const)
            .filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined),
        );
        if (Object.keys(filteredCommands).length === 0) continue;
        hasCommand = true;
        actions.push({
          ...structuredClone(action),
          update: { ...structuredClone(update), 'x-forge-commands': filteredCommands },
        });
        continue;
      }

      actions.push(structuredClone(action));
    }

    if (hasCommand) {
      filtered.push({
        ...api,
        overlay: { ...api.overlay, actions },
      });
    }
  }

  return filtered;
}

function buildOperationForgeMetadata(commands: Record<string, ForgeCommand>): Map<string, OperationForgeMetadata[]> {
  const byOperationId = new Map<string, OperationForgeMetadata[]>();

  for (const [commandName, command] of Object.entries(commands)) {
    for (const methodOrGroup of command.methods) {
      const groupName = 'methods' in methodOrGroup ? methodOrGroup['x-fern-sdk-group-name'] : undefined;
      const methods = 'methods' in methodOrGroup ? methodOrGroup.methods : [methodOrGroup];

      for (const method of methods) {
        const subGroup = method['x-fern-sdk-group-name'] ?? groupName;
        const fullGroup = subGroup ? `${commandName}.${subGroup}` : commandName;

        const metadata: OperationForgeMetadata = {
          operationId: method.operationId,
          'x-fern-sdk-group-name': fullGroup,
          'x-fern-sdk-method-name': method['x-fern-sdk-method-name'],
          'x-fern-availability': method['x-fern-availability'],
          'x-fern-ignore': method['x-fern-ignore'] ?? false,
          'x-forge-hidden': method['x-forge-hidden'] ?? false,
        };
        if (method['x-forge-globals'] !== undefined) metadata['x-forge-globals'] = method['x-forge-globals'];
        if (method['x-forge-internal'] !== undefined) metadata['x-forge-internal'] = method['x-forge-internal'];
        if (method['x-forge-epilogue'] !== undefined) metadata['x-forge-epilogue'] = method['x-forge-epilogue'];
        if (method['x-forge-args'] !== undefined) metadata['x-forge-args'] = method['x-forge-args'];
        if (method['x-forge-params'] !== undefined) metadata['x-forge-params'] = method['x-forge-params'];
        if (method['x-forge-require-confirmation'] !== undefined)
          metadata['x-forge-require-confirmation'] = method['x-forge-require-confirmation'];

        const existing = byOperationId.get(method.operationId) ?? [];
        existing.push(metadata);
        byOperationId.set(method.operationId, existing);
      }
    }
  }

  return byOperationId;
}

function toOperationForgePayload(metadata: OperationForgeMetadata): OperationForgePayload {
  const { operationId: _operationId, ...payload } = metadata;
  return payload;
}

function buildCommandConfigs(commands: Record<string, ForgeCommand>): ForgeCommandConfigMap {
  const configs: ForgeCommandConfigMap = {};

  for (const [commandName, command] of Object.entries(commands)) {
    configs[commandName] = {
      description: command.description,
    };
  }

  return configs;
}

function buildOverlayGroupInfoByOperationId(commands: Record<string, ForgeCommand>): Map<string, ForgeGroupInfo> {
  const byOperationId = new Map<string, ForgeGroupInfo>();

  for (const command of Object.values(commands)) {
    for (const methodOrGroup of command.methods) {
      if (!('methods' in methodOrGroup)) continue;

      const info: ForgeGroupInfo = {
        description: methodOrGroup.description,
        ...(methodOrGroup['x-forge-epilogue'] !== undefined
          ? { 'x-forge-epilogue': methodOrGroup['x-forge-epilogue'] }
          : {}),
      };

      for (const method of methodOrGroup.methods) {
        byOperationId.set(method.operationId, info);
      }
    }
  }

  return byOperationId;
}

function buildGroupInfo(
  operationForgeMetadata: Map<string, OperationForgeMetadata[]>,
  overlayGroupInfoByOperationId: Map<string, ForgeGroupInfo>,
): ForgeGroupInfoMap {
  const groupInfo: ForgeGroupInfoMap = {};

  for (const variants of operationForgeMetadata.values()) {
    for (const metadata of variants) {
      const subGroup = getSubGroupFromGroup(metadata['x-fern-sdk-group-name']);
      if (!subGroup) continue;

      const commandName = getCommandFromGroup(metadata['x-fern-sdk-group-name']);
      const commandGroups = groupInfo[commandName] ?? {};
      const groupPath = subGroup;
      const existing = commandGroups[groupPath] ?? {};
      const overlayInfo = overlayGroupInfoByOperationId.get(metadata.operationId);

      commandGroups[groupPath] = {
        ...existing,
        ...(existing.description === undefined && overlayInfo?.description !== undefined
          ? { description: overlayInfo.description }
          : {}),
        ...(existing['x-forge-epilogue'] === undefined && overlayInfo?.['x-forge-epilogue'] !== undefined
          ? { 'x-forge-epilogue': overlayInfo['x-forge-epilogue'] }
          : {}),
      };

      groupInfo[commandName] = commandGroups;
    }
  }

  return groupInfo;
}

function buildOperationDescriptionsFromCommands(commands: Record<string, ForgeCommand>): Map<string, string> {
  const byOperationId = new Map<string, string>();

  for (const command of Object.values(commands)) {
    for (const methodOrGroup of command.methods) {
      const methods = 'methods' in methodOrGroup ? methodOrGroup.methods : [methodOrGroup];

      for (const method of methods) {
        if (!method.description) continue;
        if (rawOpenApiService?.getOperationDescription(method.operationId)) continue;

        const existing = byOperationId.get(method.operationId);
        if (existing && existing !== method.description) {
          throw new Error(
            `Overlay descriptions conflict for operationId "${method.operationId}": ${JSON.stringify(existing)} vs ${JSON.stringify(method.description)}`,
          );
        }
        byOperationId.set(method.operationId, method.description);
      }
    }
  }

  return byOperationId;
}

async function combineApiOverlays(apiOverlays: ApiOverlay[]): Promise<{
  combined: ApiOverlay;
  operationForgeMetadata: Map<string, OperationForgeMetadata[]>;
  commandConfigs: ForgeCommandConfigMap;
  groupInfo: ForgeGroupInfoMap;
  overlayDescriptions: Map<string, string>;
  overlayDescriptionOperationIds: Set<string>;
}> {
  const commands: ForgeCommandMap = {};
  const descriptionByOperationId = new Map<string, string>();
  // Root-level `$` patches other than `x-forge-commands` — e.g. for patching
  // `components.schemas.*` directly on the OpenAPI document.
  const passthroughRootPatches: Record<string, unknown>[] = [];

  for (const overlay of apiOverlays) {
    for (const action of overlay.actions) {
      const update = isObject(action.update) ? action.update : undefined;
      const rootCommands = update?.['x-forge-commands'];
      if (action.target === '$' && rootCommands && isObject(rootCommands)) {
        for (const [commandName, command] of Object.entries(rootCommands)) {
          if (commands[commandName]) {
            throw new Error(`Duplicate command overlay for "${commandName}"`);
          }
          if (!isForgeCommand(command)) {
            throw new Error(`Invalid forge command payload for "${commandName}"`);
          }
          commands[commandName] = command;
        }
        const { 'x-forge-commands': _commands, ...rootPatch } = update;
        if (Object.keys(rootPatch).length > 0) passthroughRootPatches.push(rootPatch);
      } else if (action.target === '$' && update) {
        passthroughRootPatches.push(update);
      }

      const operationId = getOperationIdFromJsonPath(action.target);
      const description = typeof update?.description === 'string' ? update.description : undefined;

      if (!operationId || !description) continue;
      const existing = descriptionByOperationId.get(operationId);
      if (existing && existing !== description) {
        throw new Error(
          `Overlay descriptions conflict for operationId "${operationId}": ${JSON.stringify(existing)} vs ${JSON.stringify(description)}`,
        );
      }
      descriptionByOperationId.set(operationId, description);
    }
  }

  const operationForgeMetadata = buildOperationForgeMetadata(commands);
  ensureUniqueSdkMethodNames(operationForgeMetadata);
  for (const methods of operationForgeMetadata.values()) {
    for (const method of methods) toSchemaMethodFromMetadata(method);
  }
  const commandConfigs = buildCommandConfigs(commands);
  const overlayGroupInfoByOperationId = buildOverlayGroupInfoByOperationId(commands);
  const groupInfo = buildGroupInfo(operationForgeMetadata, overlayGroupInfoByOperationId);
  const commandDescriptions = buildOperationDescriptionsFromCommands(commands);

  for (const [operationId, description] of commandDescriptions) {
    const existing = descriptionByOperationId.get(operationId);
    if (existing && existing !== description) {
      throw new Error(
        `Overlay descriptions conflict for operationId "${operationId}": ${JSON.stringify(existing)} vs ${JSON.stringify(description)}`,
      );
    }
    descriptionByOperationId.set(operationId, description);
  }

  const combined: ApiOverlay = {
    overlay: '1.0.0',
    info: {
      title: 'Cloudflare CLI combined overlay',
      version: '1.0.0',
    },
    actions: [
      ...(Object.keys(groupInfo).length > 0 ? [{ target: '$', update: { 'x-forge-group-info': groupInfo } }] : []),
      ...passthroughRootPatches.map((update) => ({ target: '$', update })),
      ...Array.from(operationForgeMetadata.entries())
        .map(([operationId, variants]) => {
          const [firstVariant] = variants;
          if (!firstVariant) {
            throw new Error(`No operation metadata variants found for operationId "${operationId}"`);
          }

          return {
            target: toOperationTarget(operationId),
            update:
              variants.length === 1
                ? toOperationForgePayload(firstVariant)
                : {
                    'x-forge-aliases': variants.map((variant) => toOperationForgePayload(variant)),
                  },
          };
        })
        .sort((a, b) => a.target.localeCompare(b.target)),
      ...Array.from(descriptionByOperationId.entries())
        .map(([operationId, description]) => ({
          target: toOperationTarget(operationId),
          update: { description },
        }))
        .sort((a, b) => a.target.localeCompare(b.target)),
    ],
  };

  return {
    combined,
    operationForgeMetadata,
    commandConfigs,
    groupInfo,
    overlayDescriptions: descriptionByOperationId,
    overlayDescriptionOperationIds: new Set(descriptionByOperationId.keys()),
  };
}

function applyOperationOverlayToOpenApi(
  overlaidOpenApi: OpenApiDocument,
  operationForgeMetadata: Map<string, OperationForgeMetadata[]>,
  overlayDescriptions: Map<string, string>,
) {
  for (const [, pathItem] of Object.entries(overlaidOpenApi.paths ?? {})) {
    if (!isObject(pathItem)) continue;

    for (const method of methods) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;

      const operationId = operation.operationId;
      if (typeof operationId !== 'string') continue;

      const opForgeMetadata = operationForgeMetadata.get(operationId);
      if (opForgeMetadata && opForgeMetadata.length > 0) {
        const [firstMetadata] = opForgeMetadata;
        if (!firstMetadata) {
          throw new Error(`No operation metadata found for operationId "${operationId}"`);
        }

        if (opForgeMetadata.length === 1) {
          Object.assign(operation, toOperationForgePayload(firstMetadata));
        } else {
          Object.assign(operation, {
            'x-forge-aliases': opForgeMetadata.map((metadata) => toOperationForgePayload(metadata)),
          });
        }
      }

      const overlayDescription = overlayDescriptions.get(operationId);
      if (overlayDescription) {
        operation.description = overlayDescription;
      }
    }
  }
}

function ensureUniqueOpenApiSdkMethodNames(overlaidOpenApi: OpenApiDocument): void {
  type OpenApiSdkMethodMetadata = Pick<OperationForgeMetadata, 'x-fern-sdk-group-name' | 'x-fern-sdk-method-name'> &
    Partial<Pick<OperationForgeMetadata, 'operationId' | 'x-fern-ignore'>>;
  const metadataByOperationId = new Map<string, OpenApiSdkMethodMetadata[]>();

  for (const pathItem of Object.values(overlaidOpenApi.paths ?? {})) {
    if (!isObject(pathItem)) continue;

    for (const method of methods) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      const operationRecord = operation as unknown as Record<string, unknown>;
      const operationId = operationRecord.operationId;
      if (typeof operationId !== 'string') continue;
      const aliases = operationRecord['x-forge-aliases'];
      if (Array.isArray(aliases)) {
        const variants = aliases.filter(
          (alias): alias is OpenApiSdkMethodMetadata =>
            isObject(alias) &&
            typeof alias['x-fern-sdk-group-name'] === 'string' &&
            typeof alias['x-fern-sdk-method-name'] === 'string',
        );
        if (variants.length > 0) metadataByOperationId.set(operationId, variants);
        continue;
      }
      if (
        typeof operationRecord['x-fern-sdk-group-name'] === 'string' &&
        typeof operationRecord['x-fern-sdk-method-name'] === 'string'
      ) {
        metadataByOperationId.set(operationId, [operation as unknown as OpenApiSdkMethodMetadata]);
      }
    }
  }

  ensureUniqueSdkMethodNames(metadataByOperationId);
}

/** Collect all operationIds declared inside an x-forge-commands tree. */
function collectCommandOperationIds(commands: unknown): string[] {
  const ids: string[] = [];
  function walk(value: unknown) {
    if (!isObject(value)) return;
    if (typeof value.operationId === 'string') ids.push(value.operationId);
    if (Array.isArray(value.methods)) value.methods.forEach(walk);
  }
  if (isObject(commands)) Object.values(commands).forEach(walk);
  return ids;
}

function validateOverlayTargets(apiOverlays: ApiOverlayFile[]) {
  const errors: string[] = [];

  for (const api of apiOverlays) {
    const actions = api.overlay.actions;
    if (actions.length === 0) {
      errors.push(`${api.name}: overlay has no actions`);
      continue;
    }

    for (const action of actions) {
      if (action.target === '$') {
        // Validate operationIds nested inside x-forge-commands root patches.
        // These are converted to per-operation overlay targets during
        // combineApiOverlays — catching drift here gives an actionable error
        // with file attribution instead of an opaque failure from the overlay
        // processor after attribution has been lost.
        const update = isObject(action.update) ? action.update : undefined;
        const rootCommands = update?.['x-forge-commands'];
        if (rootCommands) {
          for (const operationId of collectCommandOperationIds(rootCommands)) {
            if (!rawOpenApiService?.getVerbPath(operationId.replace(/'/g, ''))) {
              errors.push(
                `${api.name}: operationId "${operationId}" (in x-forge-commands) does not exist in upstream OpenAPI`,
              );
            }
          }
        }
        continue;
      }

      const operationId = getOperationIdFromJsonPath(action.target);
      if (!operationId) {
        errors.push(`${api.name}: unsupported overlay target "${action.target}"`);
        continue;
      }

      if (!operationIdPattern.test(operationId)) {
        errors.push(`${api.name}: unsupported operationId characters in target "${operationId}"`);
        continue;
      }

      // Strip apostrophes for the lookup so overlays referencing operationIds
      // with apostrophes (e.g. workers-kv-namespace-list-a-namespace'-s-keys)
      // resolve. Mirrors validateOverlayMethodCoverage at line ~692 — keep both
      // sites consistent rather than relying on getVerbPath's internal
      // normalisation.
      if (!rawOpenApiService?.getVerbPath(operationId.replace(/'/g, ''))) {
        errors.push(`${api.name}: target operationId "${operationId}" does not exist in upstream OpenAPI`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Overlay target validation failed:\n- ${errors.join('\n- ')}`);
  }
}

async function writeOverlaidOpenApiArtifacts(overlaidOpenApi: OpenApiDocument, artifactsDir?: string) {
  const dir = artifactsDir ?? overlaidOutputDir;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'openapi.overlaid.json'), `${JSON.stringify(overlaidOpenApi, null, 2)}\n`);
  await writeFile(join(dir, 'openapi.overlaid.yaml'), `${toYaml(overlaidOpenApi, { indent: 2, indentSeq: false })}`);
}

/**
 * Merges source overlay into target. Mutates target in-place when target is a Record.
 */
function mergeRootOverlay(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    const isParameter = (item: unknown): item is Record<string, unknown> & { name: unknown; in: unknown } =>
      isObject(item) && Boolean(item.name) && Boolean(item.in);
    const isParameterArray = [...target, ...source].every(isParameter);
    if (!isParameterArray) return [...source];

    const merged = [...target];
    for (const item of source.filter(isParameter)) {
      const index = merged.findIndex(
        (candidate) => isObject(candidate) && candidate.name === item.name && candidate.in === item.in,
      );
      if (index !== -1) merged[index] = mergeRootOverlay(merged[index], item);
      else merged.push(item);
    }
    return merged;
  }
  if (Array.isArray(source)) return [...source];
  if (!isObject(source)) return source;

  const merged = isObject(target) ? target : {};
  for (const [key, value] of Object.entries(source)) {
    merged[key] = mergeRootOverlay(merged[key], value);
  }
  return merged;
}

async function applyCombinedOverlay(sourceOpenApi: OpenApiDocument, overlay: ApiOverlay): Promise<OpenApiDocument> {
  let overlaid = structuredClone(sourceOpenApi);
  for (const action of overlay.actions) {
    if (action.target === '$' && isObject(action.update) && action.remove === undefined) {
      overlaid = mergeRootOverlay(overlaid, structuredClone(action.update)) as OpenApiDocument;
    } else if (!getOperationIdFromJsonPath(action.target) || !isObject(action.update) || action.remove !== undefined) {
      throw new Error(`Unsupported combined overlay action: ${action.target}`);
    }
  }
  if (!isOpenApiDocument(overlaid)) {
    throw new Error('Combined overlay output is not a valid OpenAPI document shape');
  }
  return overlaid;
}

function assertDescriptionSources(
  commands: Record<string, Schema.command>,
  overlayDescriptionOperationIds: Set<string>,
) {
  const errors: string[] = [];

  function walkMethods(items: (Schema.method | Schema.methodGroup)[], commandName: string, parentGroupPath?: string) {
    for (const item of items) {
      if ('methods' in item) {
        const groupPath = parentGroupPath ? `${parentGroupPath}.${item.name}` : item.name;
        walkMethods(item.methods, commandName, groupPath);
      } else {
        const path = parentGroupPath ? `${commandName}.${parentGroupPath}.${item.name}` : `${commandName}.${item.name}`;
        const operationId = item.operationId;
        const upstreamDescription = rawOpenApiService?.getOperationDescription(operationId);
        const hasOverlayDescription = overlayDescriptionOperationIds.has(operationId);

        if (upstreamDescription && hasOverlayDescription) {
          errors.push(`${path}: operationId "${operationId}" has both upstream and overlay descriptions.`);
        }
        if (!upstreamDescription && !hasOverlayDescription) {
          errors.push(`${path}: operationId "${operationId}" has no description in upstream OpenAPI or overlay.`);
        }
      }
    }
  }

  for (const [commandName, command] of Object.entries(commands)) {
    walkMethods(command.methods, commandName);
  }

  if (errors.length > 0) {
    throw new Error(`Overlay description validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function validateOverlayMethodCoverage(commands: Record<string, Schema.command>, overlaidOpenApi: OpenApiDocument) {
  const operationIdsInOverlaidDoc = new Set<string>();

  for (const [, pathItem] of Object.entries(overlaidOpenApi.paths ?? {})) {
    if (!isObject(pathItem)) continue;
    for (const method of methods) {
      const operation = pathItem[method];
      if (isObject(operation) && typeof operation.operationId === 'string') {
        operationIdsInOverlaidDoc.add(operation.operationId.replace(/'/g, ''));
      }
    }
  }

  const missing: string[] = [];
  for (const [commandName, command] of Object.entries(commands)) {
    for (const method of collectMethods(command)) {
      // Spec ids have apostrophes stripped above; do the same on the
      // lookup so overlays referencing operationIds with apostrophes
      // (e.g. workers-kv-namespace-list-a-namespace'-s-keys) still match.
      if (!operationIdsInOverlaidDoc.has(method.operationId.replace(/'/g, ''))) {
        missing.push(`${commandName}.${method.name} -> ${method.operationId}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Overlay method operationIds missing in overlaid OpenAPI:\n- ${missing.join('\n- ')}`);
  }
}

function validateGroupInfoCoverage(
  groupInfo: ForgeGroupInfoMap,
  operationForgeMetadata: Map<string, OperationForgeMetadata[]>,
) {
  const operationGroupsByCommand = new Map<string, Set<string>>();

  for (const variants of operationForgeMetadata.values()) {
    for (const metadata of variants) {
      const subGroup = getSubGroupFromGroup(metadata['x-fern-sdk-group-name']);
      if (!subGroup) continue;

      const commandName = getCommandFromGroup(metadata['x-fern-sdk-group-name']);
      const commandGroups = operationGroupsByCommand.get(commandName) ?? new Set<string>();
      commandGroups.add(subGroup);
      operationGroupsByCommand.set(commandName, commandGroups);
    }
  }

  const errors: string[] = [];
  for (const [commandName, commandGroupInfo] of Object.entries(groupInfo)) {
    const operationGroups = operationGroupsByCommand.get(commandName) ?? new Set<string>();

    for (const groupName of Object.keys(commandGroupInfo)) {
      if (!operationGroups.has(groupName)) {
        errors.push(
          `${commandName}.${groupName}: x-forge-group-info exists but no operation uses x-fern-sdk-group-name "${groupName}"`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`x-forge-group-info validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function groupOperationMetadataByCommand(
  operationForgeMetadata: Map<string, OperationForgeMetadata[]>,
): Record<string, OperationForgeMetadata[]> {
  const byCommand: Record<string, OperationForgeMetadata[]> = {};

  for (const variants of operationForgeMetadata.values()) {
    for (const metadata of variants) {
      const commandName = getCommandFromGroup(metadata['x-fern-sdk-group-name']);
      const items = byCommand[commandName] ?? [];
      items.push(metadata);
      byCommand[commandName] = items;
    }
  }

  return byCommand;
}

export async function resolveApiOverlays(
  apiOverlays: ApiOverlayFile[],
  sourceOpenApi: OpenApiDocument,
  options: ResolveOverlayOptions = {},
): Promise<OverlayResolution> {
  const resolvedApiOverlays = options.allowMissingOperations
    ? filterApiOverlaysForOpenApi(apiOverlays, sourceOpenApi)
    : apiOverlays;
  if (resolvedApiOverlays.length === 0) {
    throw new Error('No API overlays found.');
  }

  rawOpenApiService = new Forge(sourceOpenApi);

  validateOverlayTargets(resolvedApiOverlays);

  const {
    combined,
    operationForgeMetadata,
    commandConfigs,
    groupInfo,
    overlayDescriptions,
    overlayDescriptionOperationIds,
  } = await combineApiOverlays(resolvedApiOverlays.map((api) => api.overlay));
  const overlaidOpenApi = await applyCombinedOverlay(sourceOpenApi, combined);
  applyOperationOverlayToOpenApi(overlaidOpenApi, operationForgeMetadata, overlayDescriptions);
  ensureUniqueOpenApiSdkMethodNames(overlaidOpenApi);
  // Rebuild the resolver's operation map from the overlaid spec so that
  // schema-level overlay patches flow into `resolveOperation()`.
  populateOperationMap(overlaidOpenApi);
  if (options.writeArtifacts !== false) await writeOverlaidOpenApiArtifacts(overlaidOpenApi, options.artifactsDir);
  const methodsByCommand = groupOperationMetadataByCommand(operationForgeMetadata);

  const commands = Object.fromEntries(
    Object.entries(commandConfigs).map(([commandName, commandConfig]) => {
      const methodMetadata = methodsByCommand[commandName] ?? [];
      const commandGroupInfo = groupInfo[commandName] ?? {};
      return [commandName, toSchemaCommand(commandName, commandConfig, methodMetadata, commandGroupInfo)];
    }),
  );

  validateGroupInfoCoverage(groupInfo, operationForgeMetadata);
  if (!options.allowMissingOperations) {
    assertDescriptionSources(commands, overlayDescriptionOperationIds);
  }
  validateOverlayMethodCoverage(commands, overlaidOpenApi);

  const commandMap = new Map<string, Schema.command>();
  for (const api of resolvedApiOverlays) {
    const command = commands[api.name];
    if (!command) {
      throw new Error(`Overlay command "${api.name}" not found in combined overlays.`);
    }
    commandMap.set(api.name, command);
  }

  return {
    commands: commandMap,
    overlaidOpenApi,
  };
}
