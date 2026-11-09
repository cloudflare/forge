import type { Plugin } from '@redocly/openapi-core';

import { OperationIdMissing, type OperationIdMissingOptions } from './rules/operation-id-missing.ts';

const id = 'generators';

export const plugin = (): Plugin => ({
  id,
  rules: {
    oas3: {
      'operation-id-missing': OperationIdMissing,
    },
  },
  configs: {
    all: {
      rules: {
        [`${id}/operation-id-missing`]: 'error',
      },
    },
    recommended: {
      rules: {
        [`${id}/operation-id-missing`]: 'warn',
      },
    },
  },
});

export default plugin;

export type { OperationIdMissingOptions };
