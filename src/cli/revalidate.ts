#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { CameraRegistryStore } from '../registry/cameraRegistryStore';
import { CameraValidator } from '../validator/cameraValidator';
import { BUNDLED_FFPROBE_PATH } from '../validator/probeRunner';

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');

interface CliOptions {
  registry: string;
  schema: string;
  timeout: number;
  ffprobePath: string;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('cameras-revalidate')
    .description(
      'Re-validate every camera in the Belgrade camera registry using ffprobe (bundled via @ffprobe-installer/ffprobe, no system install required)',
    )
    .option('-r, --registry <path>', 'path to the registry JSON file', DEFAULT_REGISTRY_PATH)
    .option('-s, --schema <path>', 'path to the registry JSON schema', DEFAULT_SCHEMA_PATH)
    .option('-t, --timeout <ms>', 'per-camera probe timeout in milliseconds', (v) => parseInt(v, 10), 15_000)
    .option(
      '--ffprobe-path <path>',
      'path to the ffprobe executable (defaults to the bundled @ffprobe-installer/ffprobe binary)',
      BUNDLED_FFPROBE_PATH,
    )
    .parse(process.argv);

  const opts = program.opts<CliOptions>();
  const store = new CameraRegistryStore(opts.registry, opts.schema);
  const validator = new CameraValidator({ timeoutMs: opts.timeout, ffprobePath: opts.ffprobePath });

  const entries = await store.load();
  console.log(`Loaded ${entries.length} camera(s) from ${opts.registry}\n`);

  let activeCount = 0;
  for (const entry of entries) {
    process.stdout.write(`Checking "${entry.name}" (${entry.id})... `);
    const result = await validator.validate(entry);

    entry.status = result.status;
    entry.lastVerifiedAt = result.checkedAt;
    entry.lastError = result.error ?? null;
    if (result.resolution) {
      entry.resolution = result.resolution;
    }

    if (result.status === 'active') {
      activeCount += 1;
      console.log(`ACTIVE (${result.resolution ?? 'unknown resolution'}, ${result.latencyMs ?? '?'}ms)`);
    } else {
      console.log(`INACTIVE (${result.error ?? 'unknown error'})`);
    }
  }

  await store.save(entries);
  console.log(`\nDone. ${activeCount}/${entries.length} camera(s) active. Registry updated at ${opts.registry}`);
}

main().catch((err) => {
  console.error('Revalidation failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
