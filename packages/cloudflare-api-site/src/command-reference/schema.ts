import { z } from 'astro/zod';

const nonEmptyStringSchema = z.string().min(1);
const pathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be an ASCII command path segment');

export const commandScalarTypeSchema = z.enum(['string', 'number', 'boolean']);

export const commandCompletionSchema = z
  .object({
    type: z.literal('dynamic'),
    operation: nonEmptyStringSchema,
    displayField: nonEmptyStringSchema,
  })
  .strict();

export const commandArgumentSchema = z
  .object({
    name: nonEmptyStringSchema,
    position: z.number().int().nonnegative(),
    type: commandScalarTypeSchema,
    required: z.boolean(),
    description: nonEmptyStringSchema,
    enum: z.array(z.string()).min(1).optional(),
    completion: commandCompletionSchema.optional(),
  })
  .strict();

export const commandOptionSchema = z
  .object({
    name: nonEmptyStringSchema,
    type: commandScalarTypeSchema,
    required: z.boolean(),
    default: z.json().optional(),
    description: nonEmptyStringSchema,
    enum: z.array(z.string()).min(1).optional(),
  })
  .strict();

export const commandMetadataSchema = z
  .object({
    command: nonEmptyStringSchema,
    name: pathSegmentSchema,
    fullPath: z.array(pathSegmentSchema).min(1).max(16),
    description: nonEmptyStringSchema,
    usage: nonEmptyStringSchema,
    arguments: z.array(commandArgumentSchema),
    options: z.array(commandOptionSchema),
    category: z.enum(['read', 'create', 'update', 'delete', 'action']).optional(),
    hasRequestBody: z.boolean().optional(),
    hideCommand: z.boolean().optional(),
    operationId: nonEmptyStringSchema.optional(),
    httpMethod: nonEmptyStringSchema.optional(),
    apiPath: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.name !== command.fullPath.at(-1)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'name must equal the final fullPath segment',
      });
    }

    const renderedPath = command.fullPath.join(' ');
    if (command.command !== renderedPath && !command.command.endsWith(` ${renderedPath}`)) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'command must end with the rendered fullPath',
      });
    }

    if (command.usage !== command.command && !command.usage.startsWith(`${command.command} `)) {
      context.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'usage must begin with command',
      });
    }

    command.arguments.forEach((argument, index) => {
      if (argument.position !== index) {
        context.addIssue({
          code: 'custom',
          path: ['arguments', index, 'position'],
          message: 'position must match the argument array index',
        });
      }
    });
  });

export const commandCatalogSchema = z
  .object({
    version: z.literal('1.0'),
    generatedAt: nonEmptyStringSchema,
    commands: z.array(commandMetadataSchema),
    descriptions: z.record(nonEmptyStringSchema, nonEmptyStringSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const commands = new Set<string>();
    const paths = new Set<string>();

    catalog.commands.forEach((command, index) => {
      const path = command.fullPath.join('\0');
      if (commands.has(command.command)) {
        context.addIssue({
          code: 'custom',
          path: ['commands', index, 'command'],
          message: 'command must be unique',
        });
      }
      if (paths.has(path)) {
        context.addIssue({
          code: 'custom',
          path: ['commands', index, 'fullPath'],
          message: 'fullPath must be unique',
        });
      }
      commands.add(command.command);
      paths.add(path);
    });
  });

export type CommandScalarType = z.infer<typeof commandScalarTypeSchema>;
export type CommandCompletion = z.infer<typeof commandCompletionSchema>;
export type CommandArgument = z.infer<typeof commandArgumentSchema>;
export type CommandOption = z.infer<typeof commandOptionSchema>;
export type CommandMetadata = z.infer<typeof commandMetadataSchema>;
export type CommandCatalog = z.infer<typeof commandCatalogSchema>;
