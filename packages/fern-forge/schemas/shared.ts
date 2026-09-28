import { z } from 'astro/zod';

export const nonEmptyStringSchema = z.string().trim().min(1);
export const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
