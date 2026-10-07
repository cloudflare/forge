import { narrowSdkErrorImports } from './sdk-error-imports.ts';

const generatedSdkDir = process.argv[2];
if (!generatedSdkDir) throw new Error('usage: narrow-sdk-error-imports <generated-sdk-dir>');
const updated = narrowSdkErrorImports(generatedSdkDir);
console.log(`==> Narrowed runtime error imports in ${updated} SDK client(s)`);
