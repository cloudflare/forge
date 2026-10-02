import { z } from 'astro/zod';
import { openApiDocumentSchema, parseOpenApiDocument } from 'astro-fern/content';
import { operationProjectionFieldsSchema, rejectUnknownForgeKeys } from './operation.ts';
import { nonEmptyStringSchema } from './shared.ts';

const commandLeafSchema = operationProjectionFieldsSchema
  // Command leaves may inherit their SDK group from the enclosing command group.
  .partial({ 'x-fern-sdk-group-name': true })
  // Every command leaf must declare its lifecycle even though regular operations may omit it.
  .required({ 'x-fern-availability': true })
  .extend({
    operationId: nonEmptyStringSchema,
    description: z.string().optional(),
  })
  .strict();

const commandGroupSchema = operationProjectionFieldsSchema
  // Command groups only consume Fern's SDK group header; method and lifecycle headers belong to leaves.
  .pick({ 'x-fern-sdk-group-name': true, 'x-forge-epilogue': true })
  .extend({
    description: nonEmptyStringSchema,
    methods: z.array(commandLeafSchema),
  })
  .strict();

const commandMethodsSchema = z
  .object({
    description: nonEmptyStringSchema,
    methods: z.array(z.union([commandLeafSchema, commandGroupSchema])),
  })
  .strict();

const commandMetadataSchema = z.strictObject({
  description: nonEmptyStringSchema,
  'x-forge-epilogue': z.string().optional(),
  get groups() {
    return z.record(z.string(), commandMetadataSchema).optional();
  },
});

export type CommandMetadataSchema = z.infer<typeof commandMetadataSchema>;

const commandsSchema = z.record(z.string(), z.union([commandMethodsSchema, commandMetadataSchema]));

export type ForgeCommandsSchema = z.infer<typeof commandsSchema>;

const groupInfoSchema = z
  .object({
    description: z.string().optional(),
    'x-forge-epilogue': z.string().optional(),
  })
  .strict();

const groupInfoMapSchema = z.record(z.string(), z.record(z.string(), groupInfoSchema));

export type ForgeGroupInfoMapSchema = z.infer<typeof groupInfoMapSchema>;

const knownRootForgeKeys = new Set(['x-forge-commands', 'x-forge-group-info']);

export const forgeDocumentSchema = openApiDocumentSchema
  .extend({
    'x-forge-commands': commandsSchema.optional(),
    'x-forge-group-info': groupInfoMapSchema.optional(),
  })
  .superRefine((value, context) => rejectUnknownForgeKeys(value, knownRootForgeKeys, context));

export type ForgeDocumentSchema = z.infer<typeof forgeDocumentSchema>;

export const documentExtensionsSchema = forgeDocumentSchema;

/** Hoists command-catalogue entries that an upstream overlay left on path items. */
export function hoistForgeCommands(document: unknown): ForgeDocumentSchema {
  const source = forgeDocumentSchema.parse(parseOpenApiDocument(document));
  let commands = source['x-forge-commands'] ?? {};
  let paths: NonNullable<ForgeDocumentSchema['paths']> | undefined;

  for (const [path, pathItem] of Object.entries(source.paths ?? {})) {
    if (!pathItem) continue;
    const value = pathItem['x-forge-commands'];
    if (value === undefined) continue;
    const nested = commandsSchema.parse(value);
    for (const command of Object.keys(nested)) {
      if (commands[command] !== undefined) {
        throw new Error(`fern-forge: duplicate x-forge-commands entry "${command}" at path item "${path}"`);
      }
    }

    commands = { ...commands, ...nested };
    paths ??= { ...source.paths };
    const { 'x-forge-commands': _commands, ...cleanPathItem } = pathItem;
    paths[path] = cleanPathItem;
  }

  return paths ? { ...source, paths, 'x-forge-commands': commands } : source;
}
