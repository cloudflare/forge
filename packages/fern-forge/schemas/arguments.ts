import { z } from 'astro/zod';
import { nonEmptyStringSchema, scalarSchema } from './shared.ts';

const completionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('choices') }).strict(),
  z.object({ type: z.literal('file'), extensions: z.array(z.string()).optional() }).strict(),
  z
    .object({
      type: z.literal('dynamic'),
      listOperation: nonEmptyStringSchema,
      displayField: nonEmptyStringSchema,
    })
    .strict(),
]);

const requiredSchema = z.union([z.literal(true), z.object({ default: scalarSchema }).strict()]);
const argumentBaseShape = {
  name: nonEmptyStringSchema,
  alias: nonEmptyStringSchema.optional(),
  description: nonEmptyStringSchema.optional(),
  completion: completionSchema.optional(),
};
const enumValueSchema = z.union([
  scalarSchema,
  z.object({ literal: z.string(), description: nonEmptyStringSchema }).strict(),
  z.object({ literal: z.number() }).strict(),
  z.object({ literal: z.boolean() }).strict(),
]);

const stringArgumentSchema = z
  .object({ ...argumentBaseShape, type: z.literal('string'), required: requiredSchema })
  .strict();
const numberArgumentSchema = z
  .object({ ...argumentBaseShape, type: z.literal('number'), required: requiredSchema })
  .strict();
const booleanArgumentSchema = z
  .object({ ...argumentBaseShape, type: z.literal('boolean'), required: requiredSchema })
  .strict();
const enumArgumentSchema = z
  .object({
    ...argumentBaseShape,
    type: z.literal('enum'),
    values: z.array(enumValueSchema).min(1),
    required: requiredSchema,
  })
  .strict();

export const argumentSchema = z
  .discriminatedUnion('type', [stringArgumentSchema, numberArgumentSchema, booleanArgumentSchema, enumArgumentSchema])
  .superRefine((argument, context) => {
    if (argument.required === true) return;
    const defaultValue = argument.required.default;
    if (argument.type !== 'enum' && typeof defaultValue !== argument.type) {
      context.addIssue({
        code: 'custom',
        path: ['required', 'default'],
        message: `default must match argument type ${argument.type}`,
      });
    }
  });

const methodArgumentGroupSchema = z
  .object({
    required: z.array(argumentSchema).optional(),
    oneOf: z.array(argumentSchema).optional(),
    options: z.array(argumentSchema).optional(),
  })
  .strict()
  .refine((group) => group.required !== undefined || group.oneOf !== undefined || group.options !== undefined, {
    message: 'argument group must define required, oneOf, or options',
  });

export const methodArgumentSchema = z.union([argumentSchema, methodArgumentGroupSchema]);

export const paramOverrideSchema = z
  .object({
    description: nonEmptyStringSchema.optional(),
    default: scalarSchema.nullable().optional(),
    hidden: z.boolean().optional(),
    required: z.boolean().optional(),
    flagName: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'flagName must be kebab-case')
      .optional(),
    choices: z.array(scalarSchema).optional(),
    array: z.boolean().optional(),
    positional: z.boolean().optional(),
    fromFile: z
      .union([z.literal(false), z.object({ format: z.enum(['binary', 'base64', 'json']) }).strict()])
      .optional(),
  })
  .strict();
