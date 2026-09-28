import { Forge } from './forge.js';
import type { OpenAPIV3 } from 'openapi-types';
import { populateOperationMap } from './openapi-resolver.js';
import type { Schema } from './schema/schema.js';
import { toKebabCase } from './shared/naming.js';
import { ensureUniqueSdkMethodNames } from './shared/sdk-method-names.js';
import { resolveCommandArgDescriptions, resolveCommandDescriptions } from './shared/schema-utils.js';

type OpenApiOperation = Record<string, unknown> & { operationId?: unknown };
export type ForgeOpenApiDocument = OpenAPIV3.Document & {
  'x-forge-commands'?: Record<string, unknown>;
  'x-forge-group-info'?: GroupInfoMap;
};
type GroupInfo = { description?: string; 'x-forge-epilogue'?: string };
type GroupInfoMap = Record<string, Record<string, GroupInfo>>;
type MethodStatus = Schema.method['status'];

type OperationMetadata = {
  operationId: string;
  commandName: string;
  groupPath: string[];
  methodName: string;
  status: MethodStatus;
  ignore: boolean;
  hidden: boolean;
  globals?: Schema.arg[];
  epilogue?: string;
  args?: Schema.methodArg[];
  params?: Record<string, Schema.paramOverride>;
  requireConfirmation?: `This operation ${string}.`;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const METHOD_STATUSES = new Set<string>(['alpha', 'beta', 'preview', 'generally-available', 'deprecated']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadCommandDescriptions(openapi: ForgeOpenApiDocument): Map<string, string> {
  const descriptions = new Map<string, string>();
  const commands = openapi['x-forge-commands'];
  if (!isRecord(commands)) return descriptions;

  for (const [commandName, node] of Object.entries(commands)) {
    if (!isRecord(node)) continue;
    const description = node['description'];
    if (typeof description === 'string') descriptions.set(commandName, description);
  }
  return descriptions;
}

function loadCommandGroupInfo(openapi: ForgeOpenApiDocument): GroupInfoMap {
  const groupInfo: GroupInfoMap = {};
  for (const [commandName, command] of Object.entries(openapi['x-forge-commands'] ?? {})) {
    if (isRecord(command) && isRecord(command.groups)) {
      groupInfo[commandName] = command.groups as Record<string, GroupInfo>;
    }
  }
  return groupInfo;
}

function parseStatus(operationId: string, value: unknown): MethodStatus {
  if (value === undefined) return 'alpha';
  if (typeof value !== 'string' || !METHOD_STATUSES.has(value)) {
    throw new Error(`${operationId}: invalid x-fern-availability ${String(value)}`);
  }
  return value as MethodStatus;
}

function loadFernParameterOverrides(source: Record<string, unknown>): Record<string, Schema.paramOverride> {
  const overrides: Record<string, Schema.paramOverride> = {};
  if (!Array.isArray(source.parameters)) return overrides;

  for (const parameter of source.parameters) {
    if (!isRecord(parameter)) continue;
    const wireName = parameter.name;
    const fernName = parameter['x-fern-parameter-name'];
    if (typeof wireName !== 'string' || typeof fernName !== 'string' || fernName.length === 0) continue;

    overrides[wireName] = { flagName: toKebabCase(fernName) };
  }

  return overrides;
}

function mergeParamOverrides(
  inferred: Record<string, Schema.paramOverride>,
  explicit: unknown,
): Record<string, Schema.paramOverride> | undefined {
  const overrides = { ...inferred };
  if (isRecord(explicit)) {
    for (const [name, override] of Object.entries(explicit)) {
      overrides[name] = {
        ...overrides[name],
        ...(override as Schema.paramOverride),
      };
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseMetadata(
  operationId: string,
  source: Record<string, unknown>,
  ignore: boolean,
  inferredParams: Record<string, Schema.paramOverride>,
): OperationMetadata {
  const groupRaw = source['x-fern-sdk-group-name'];
  const fullGroup = Array.isArray(groupRaw)
    ? groupRaw.filter((s): s is string => typeof s === 'string').join('.')
    : typeof groupRaw === 'string'
      ? groupRaw
      : '';
  const [commandName, ...groupPath] = fullGroup.split('.').filter(Boolean);
  if (!commandName) {
    throw new Error(`${operationId}: x-fern-sdk-group-name has no command segment`);
  }

  const methodRaw = source['x-fern-sdk-method-name'];
  const methodName = typeof methodRaw === 'string' && methodRaw ? methodRaw : operationId.split(/[-_]+/).pop() || 'get';

  const metadata: OperationMetadata = {
    operationId,
    commandName,
    groupPath,
    methodName,
    status: parseStatus(operationId, source['x-fern-availability']),
    ignore,
    hidden: source['x-forge-hidden'] === true,
  };

  if (Array.isArray(source['x-forge-globals'])) metadata.globals = source['x-forge-globals'] as Schema.arg[];
  if (typeof source['x-forge-epilogue'] === 'string') metadata.epilogue = source['x-forge-epilogue'];
  if (Array.isArray(source['x-forge-args'])) metadata.args = source['x-forge-args'] as Schema.methodArg[];
  const params = mergeParamOverrides(inferredParams, source['x-forge-params']);
  if (params !== undefined) metadata.params = params;
  if (typeof source['x-forge-require-confirmation'] === 'string') {
    metadata.requireConfirmation = source['x-forge-require-confirmation'] as `This operation ${string}.`;
  }

  return metadata;
}

function collectOperationMetadata(openapi: ForgeOpenApiDocument): OperationMetadata[] {
  const metadata: OperationMetadata[] = [];
  for (const pathItem of Object.values(openapi.paths ?? {})) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const operationRecord = operation as Record<string, unknown>;

      const { operationId } = operation as OpenApiOperation;
      if (typeof operationId !== 'string') continue;

      const inferredParams = loadFernParameterOverrides(operationRecord);
      const aliases = operationRecord['x-forge-aliases'];
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          if (isRecord(alias)) metadata.push(parseMetadata(operationId, alias, false, inferredParams));
        }
        continue;
      }

      const groupName = operationRecord['x-fern-sdk-group-name'];
      if (typeof groupName === 'string' || (Array.isArray(groupName) && groupName.length > 0)) {
        metadata.push(
          parseMetadata(operationId, operationRecord, operationRecord['x-fern-ignore'] === true, inferredParams),
        );
      }
    }
  }
  return metadata;
}

function toSchemaMethod(metadata: OperationMetadata): Schema.method {
  const common = {
    name: metadata.methodName,
    operationId: metadata.operationId,
    ...(metadata.epilogue !== undefined ? { epilogue: metadata.epilogue } : {}),
    ...(metadata.args !== undefined ? { args: metadata.args } : {}),
    ...(metadata.params !== undefined ? { params: metadata.params } : {}),
    ...(metadata.requireConfirmation !== undefined ? { requireConfirmation: metadata.requireConfirmation } : {}),
  };

  if (metadata.status === 'deprecated') return { ...common, status: 'deprecated' };

  return { ...common, status: metadata.status };
}

type GroupNode = {
  methods: Schema.method[];
  children: Map<string, GroupNode>;
  groupPath: string;
};

function groupNode(groupPath: string): GroupNode {
  return { methods: [], children: new Map(), groupPath };
}

function addToGroup(root: Map<string, GroupNode>, path: string[], method: Schema.method) {
  let children = root;
  let currentPath = '';
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    currentPath = currentPath ? `${currentPath}.${segment}` : segment;
    const node = children.get(segment) ?? groupNode(currentPath);
    children.set(segment, node);
    if (i === path.length - 1) {
      node.methods.push(method);
    } else {
      children = node.children;
    }
  }
}

function toMethodGroups(nodes: Map<string, GroupNode>, groupInfo: Record<string, GroupInfo>): Schema.methodGroup[] {
  return Array.from(nodes.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, node]) => {
      const info = groupInfo[node.groupPath] ?? {};
      const childGroups = toMethodGroups(node.children, groupInfo);
      return {
        name,
        description: info.description ?? `Operations for ${node.groupPath}`,
        ...(info['x-forge-epilogue'] !== undefined ? { epilogue: info['x-forge-epilogue'] } : {}),
        methods: [...node.methods, ...childGroups],
      };
    });
}

function toSchemaCommand(
  commandName: string,
  items: OperationMetadata[],
  description: string,
  groupInfo: Record<string, GroupInfo>,
): Schema.command {
  const visible = items.filter((item) => !item.ignore);
  const topLevelMethods: Schema.method[] = [];
  const groups = new Map<string, GroupNode>();

  for (const item of visible) {
    const method = toSchemaMethod(item);
    if (item.groupPath.length === 0) {
      topLevelMethods.push(method);
    } else {
      addToGroup(groups, item.groupPath, method);
    }
  }

  return {
    name: commandName,
    description,
    methods: [...topLevelMethods, ...toMethodGroups(groups, groupInfo)],
    globalCliArgs: items.find((item) => item.globals)?.globals ?? [],
    hideCommand: visible.every((item) => item.hidden),
  };
}

function groupByCommand(items: OperationMetadata[]): Map<string, OperationMetadata[]> {
  const byCommand = new Map<string, OperationMetadata[]>();
  for (const item of items) {
    const commandItems = byCommand.get(item.commandName) ?? [];
    commandItems.push(item);
    byCommand.set(item.commandName, commandItems);
  }
  return byCommand;
}

function validateCommandMetadata(forge: Forge): void {
  const errors: string[] = [];
  for (const [, command] of forge.commands) {
    errors.push(
      ...resolveCommandDescriptions(
        command,
        (opId) => forge.getOperationDescription(opId),
        (opId) => forge.getOperationSummary(opId),
      ),
    );
    errors.push(...resolveCommandArgDescriptions(command, (opId) => forge.getParameterDescriptions(opId)));
  }
  if (errors.length > 0) {
    throw new Error(`OpenAPI command metadata validation errors:\n${errors.map((error) => `  ${error}`).join('\n')}`);
  }
}

/**
 * Build Forge commands from Forge's overlaid OpenAPI artifact, before the Fern
 * SDK transform rewrites `x-fern-sdk-group-name` from dotted strings to arrays.
 */
export function initFromOpenApi(openapi: ForgeOpenApiDocument): Forge {
  const commandDescriptions = loadCommandDescriptions(openapi);
  const commandGroupInfo = loadCommandGroupInfo(openapi);
  populateOperationMap(openapi);

  const forge = new Forge(openapi);
  const metadata = collectOperationMetadata(openapi);
  const metadataByOperationId = new Map<
    string,
    {
      operationId: string;
      'x-fern-sdk-group-name': string;
      'x-fern-sdk-method-name': string;
      'x-fern-ignore'?: boolean;
      _ref: OperationMetadata;
    }[]
  >();
  for (const item of metadata) {
    const fullGroup = [item.commandName, ...item.groupPath].join('.');
    const entry = {
      operationId: item.operationId,
      'x-fern-sdk-group-name': fullGroup,
      'x-fern-sdk-method-name': item.methodName,
      'x-fern-ignore': item.ignore,
      _ref: item,
    };
    const list = metadataByOperationId.get(item.operationId) ?? [];
    list.push(entry);
    metadataByOperationId.set(item.operationId, list);
  }
  ensureUniqueSdkMethodNames(metadataByOperationId);
  for (const entries of metadataByOperationId.values()) {
    for (const entry of entries) {
      entry._ref.methodName = entry['x-fern-sdk-method-name'];
    }
  }

  const byCommand = groupByCommand(metadata);
  const groupInfo = openapi['x-forge-group-info'] ?? {};
  for (const [commandName, items] of Array.from(byCommand.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    forge.commands.set(
      commandName,
      toSchemaCommand(commandName, items, commandDescriptions.get(commandName) ?? commandName, {
        ...commandGroupInfo[commandName],
        ...groupInfo[commandName],
      }),
    );
  }

  validateCommandMetadata(forge);
  return forge;
}
