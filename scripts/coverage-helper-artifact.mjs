import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { describeNativeBinary } = createRequire(import.meta.url)(
  '../apps/desktop/scripts/lib/native-binary.cjs'
);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const targets = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-musl',
  'x86_64-pc-windows-msvc',
]);

export function validateCoverageArtifactReceipt(receipt, observed) {
  if (receipt?.schema !== 'dnaforge.coverage-helper-artifact/v1') {
    throw new Error('Unknown coverage helper receipt schema');
  }
  if (!targets.has(receipt.target) || receipt.target !== observed.target) {
    throw new Error('Coverage helper target mismatch');
  }
  if (!/^[0-9a-f]{40}$/.test(receipt.sourceCommit ?? '')) {
    throw new Error('Coverage helper source commit is invalid');
  }
  for (const value of [receipt.version, observed.version]) {
    if (!/^dna-coverage \S+ schema 2$/.test(value ?? '')) {
      throw new Error('Coverage helper must report schema 2');
    }
  }
  for (const key of ['version', 'binarySha256', 'binaryBytes', 'sourceIdentity']) {
    if (receipt[key] !== observed[key]) throw new Error(`Coverage helper ${key} mismatch`);
  }
}

export function coverageSourceIdentity(root = process.cwd()) {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'Cargo.toml',
      'Cargo.lock',
      'tools/dna-coverage/',
      'scripts/coverage-helper-artifact.mjs',
      '.github/workflows/dna-indexer-ci.yml',
      'apps/desktop/scripts/lib/native-binary.cjs',
      'apps/desktop/scripts/build-helpers.cjs',
    ],
    { encoding: 'utf8', cwd: root }
  )
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((path) => ({ path, sha256: digest(readFileSync(resolve(root, path))) }));
  return { files, sourceIdentity: digest(JSON.stringify(files)) };
}

function main() {
  const [operation, target, binaryPath, receiptPath] = process.argv.slice(2);
  if (!['create', 'verify'].includes(operation) || !targets.has(target) || !receiptPath) {
    throw new Error('Usage: coverage-helper-artifact.mjs create|verify TARGET BINARY RECEIPT');
  }
  const binary = readFileSync(binaryPath);
  const platform = target.includes('apple')
    ? 'darwin'
    : target.includes('windows')
      ? 'win32'
      : 'linux';
  describeNativeBinary(binaryPath, {
    platform,
    arch: target.startsWith('aarch64') ? 'arm64' : 'x64',
  });
  const observed = {
    target,
    version: execFileSync(resolve(binaryPath), ['schema-version'], { encoding: 'utf8' }).trim(),
    binarySha256: digest(binary),
    binaryBytes: binary.length,
    ...coverageSourceIdentity(),
  };
  const receipt =
    operation === 'create'
      ? {
          schema: 'dnaforge.coverage-helper-artifact/v1',
          sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          runId: process.env.GITHUB_RUN_ID ?? null,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          host: { platform: process.platform, arch: process.arch },
          ...observed,
        }
      : JSON.parse(readFileSync(receiptPath, 'utf8'));
  validateCoverageArtifactReceipt(receipt, observed);
  if (operation === 'create') writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify({ operation, target, sha256: observed.binarySha256, version: observed.version })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
