#!/usr/bin/env node
// Targets fern-api 5.68.0. Fail closed when its minified anchors change.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: patch-fern-cli-capture.mjs <fern-cli.cjs>');
  process.exit(2);
}

const original = readFileSync(path, 'utf8');
let next = original;

const envFrom = 'process.env.FERN_STACK_TRACK&&(i.FERN_STACK_TRACK=process.env.FERN_STACK_TRACK);';
const envTo =
  'process.env.CLOUDFLARE_FERN_CAPTURE_DIR&&(i.CLOUDFLARE_FERN_CAPTURE_DIR=process.env.CLOUDFLARE_FERN_CAPTURE_DIR),process.env.FERN_STACK_TRACK&&(i.FERN_STACK_TRACK=process.env.FERN_STACK_TRACK);';
if (next.includes(envFrom)) {
  next = next.replace(envFrom, envTo);
  console.log('patched Fern container environment for canonical IR capture');
} else if (!next.includes('i.CLOUDFLARE_FERN_CAPTURE_DIR=process.env.CLOUDFLARE_FERN_CAPTURE_DIR')) {
  console.error('Fern runContainer environment marker not found');
  process.exit(1);
}

const bindFrom = 'let d=[`${n}:${IHt}:ro`,`${r}:${pmi}:ro`,`${i}:${EHt}`];o&&d.push';
const bindTo =
  'let d=[`${n}:${IHt}:ro`,`${r}:${pmi}:ro`,`${i}:${EHt}`];process.env.CLOUDFLARE_FERN_CAPTURE_DIR&&d.push(`${process.env.CLOUDFLARE_FERN_CAPTURE_DIR}:/capture`);o&&d.push';
if (next.includes(bindFrom)) {
  next = next.replace(bindFrom, bindTo);
  console.log('patched Fern canonical IR capture bind mount');
} else if (!next.includes('d.push(`${process.env.CLOUDFLARE_FERN_CAPTURE_DIR}:/capture`)')) {
  console.error('Fern ContainerExecutionEnvironment bind marker not found');
  process.exit(1);
}

if (next !== original) {
  writeFileSync(path, next);
  console.log('wrote', path);
} else {
  console.log('Fern CLI already supports canonical IR capture');
}
