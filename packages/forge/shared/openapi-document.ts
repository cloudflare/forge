import type { OpenAPIV3 } from 'openapi-types';
import { isObject } from './schema-utils.js';

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

export function isOpenApiDocument(value: unknown): value is OpenAPIV3.Document {
  if (!isObject(value)) return false;
  if (!hasString(value, 'openapi') || !(value.openapi as string).startsWith('3.')) return false;
  if (!isObject(value.info) || !hasString(value.info, 'title') || !hasString(value.info, 'version')) return false;
  if (!isObject(value.paths)) return false;
  return true;
}
