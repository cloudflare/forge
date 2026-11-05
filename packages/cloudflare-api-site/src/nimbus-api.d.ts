import type { TerraformOperationData } from './terraform.ts';

declare module '@cloudflare/nimbus-docs/types' {
  interface ApiExtensions {
    'x-fern-availability': string | { status: string; message?: string };
    'x-forge-require-confirmation': string;
    'x-cloudflare-terraform': TerraformOperationData;
  }
}
