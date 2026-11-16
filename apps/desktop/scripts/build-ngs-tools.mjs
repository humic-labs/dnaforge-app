#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { arch, availableParallelism, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SOURCE_LOCK: lock,
  SOURCE_LOCK_BYTES: lockBytes,
  NGS_TOOL_SPECS,
  ngsToolSuffix,
  verifyNgsVersion,
  macSystemDependencies,
} = require('./lib/ngs-tools.cjs');
const { describeNativeBinary } = require('./lib/native-binary.cjs');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const capture = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (
    !['--arch', '--output-dir', '--cache-dir'].includes(key) ||
    options.has(key) ||
    !process.argv[index + 1]
  ) {
    throw new Error(
      'Usage: build-ngs-tools.mjs --output-dir PATH [--arch arm64|x64] [--cache-dir PATH]'
    );
  }
  options.set(key, process.argv[index + 1]);
}
const target = options.get('--arch') ?? arch();
const output = options.get('--output-dir');
if (process.platform !== 'darwin' || target !== arch() || !output) {
  throw new Error('Build NGS tools on their native macOS arm64/x64 host with --output-dir PATH.');
}
const suffix = ngsToolSuffix(target);
const compiler = capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'clang']);
const sdkPath = capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
const recipe = {
  target: suffix,
  profile: 'local-bam-v1',
  builderSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  verifierSha256: digest(
    readFileSync(fileURLToPath(new URL('./lib/ngs-tools.cjs', import.meta.url)))
  ),
  nativeBinaryVerifierSha256: digest(
    readFileSync(fileURLToPath(new URL('./lib/native-binary.cjs', import.meta.url)))
  ),
  sourceLockSha256: digest(lockBytes),
  compiler: capture(compiler, ['--version']),
  sdk: capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']),
  deploymentTarget: '12.0',
};
const recipeKey = digest(JSON.stringify(recipe));
const cache = options.get('--cache-dir') ?? path.join(homedir(), '.cache/dnaforge-ngs-tools');
mkdirSync(cache, { recursive: true });
const published = path.join(cache, `${target}-${recipeKey}`);
const run = (command, args, cwd, env = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

function verifyBinary(name, binary) {
  describeNativeBinary(binary, { platform: 'darwin', arch: target });
  const dependencies = macSystemDependencies(capture('/usr/bin/otool', ['-L', binary]));
  const versionOutput = capture(binary, ['--version']);
  return {
    version: verifyNgsVersion(name, versionOutput),
    versionOutput,
    sha256: digest(readFileSync(binary)),
    bytes: readFileSync(binary).length,
    dependencies,
  };
}

function validatePublished(directory) {
  if (
    digest(readFileSync(path.join(directory, 'ngs-tools.source.lock.json'))) !==
    recipe.sourceLockSha256
  ) {
    throw new Error('The NGS tool cache has a different packaged source lock.');
  }
  const receipt = JSON.parse(readFileSync(path.join(directory, 'ngs-tools.build.json'), 'utf8'));
  if (receipt.schema !== 'dnaforge.ngs-tools-build.v1' || receipt.recipeKey !== recipeKey) {
    throw new Error('The immutable NGS tool cache has a different source/build identity.');
  }
  for (const [key, value] of Object.entries(recipe)) {
    if (JSON.stringify(receipt[key]) !== JSON.stringify(value)) {
      throw new Error(`The NGS tool cache has a different ${key}.`);
    }
  }
  if (JSON.stringify(receipt.sources) !== JSON.stringify(lock.sources)) {
    throw new Error('The NGS tool cache has different pinned source archives.');
  }
  for (const { name } of NGS_TOOL_SPECS) {
    const actual = verifyBinary(name, path.join(directory, `${name}-${suffix}`));
    if (actual.sha256 !== receipt.tools[name].sha256) {
      throw new Error(`The cached ${name} differs from its source-build receipt.`);
    }
  }
  for (const license of receipt.licenses) {
    const bytes = readFileSync(path.join(directory, 'ngs-tools.licenses', license.file));
    if (bytes.length !== license.bytes || digest(bytes) !== license.sha256) {
      throw new Error(`The cached ${license.file} license differs from its receipt.`);
    }
  }
  return receipt;
}

if (!existsSync(published)) {
  const root = mkdtempSync(path.join(cache, `.build-${target}-`));
  for (const [name, source] of Object.entries(lock.sources)) {
    const archive = path.join(root, `${name}.tar.bz2`);
    run(
      '/usr/bin/curl',
      [
        '--fail',
        '--location',
        '--retry',
        '2',
        '--connect-timeout',
        '20',
        '--max-time',
        '180',
        '--max-filesize',
        String(source.bytes),
        '--output',
        archive,
        source.url,
      ],
      root
    );
    const bytes = readFileSync(archive);
    if (bytes.length !== source.bytes || digest(bytes) !== source.sha256) {
      throw new Error(`Untrusted ${name} source archive; retained failed build at ${root}`);
    }
    const directory = path.join(root, name);
    mkdirSync(directory);
    run('/usr/bin/tar', ['-xjf', archive, '--strip-components=1', '-C', directory], root);
  }
  const jobs = String(Math.min(4, availableParallelism()));
  const cpu = target === 'arm64' ? 'arm64' : 'x86_64';
  const flags = `-O2 -arch ${cpu} -isysroot ${sdkPath} -mmacosx-version-min=12.0`;
  const env = {
    CC: compiler,
    AR: '/usr/bin/ar',
    RANLIB: '/usr/bin/ranlib',
    CFLAGS: flags,
    CPPFLAGS: '',
    LDFLAGS: `-arch ${cpu} -isysroot ${sdkPath} -mmacosx-version-min=12.0`,
    PKG_CONFIG: '/usr/bin/false',
    MACOSX_DEPLOYMENT_TARGET: '12.0',
  };
  run(
    '/usr/bin/make',
    [
      '-j',
      jobs,
      `CC=${compiler}`,
      `CFLAGS=${flags} -Wall -Wc++-compat${target === 'arm64' ? ' -D_FILE_OFFSET_BITS=64 -fsigned-char' : ''}`,
      ...(target === 'arm64' ? ['aarch64=1'] : []),
    ],
    path.join(root, 'minimap2'),
    env
  );
  const htslib = path.join(root, 'htslib');
  run(
    './configure',
    [
      '--disable-libcurl',
      '--disable-plugins',
      '--disable-s3',
      '--disable-gcs',
      '--disable-bz2',
      '--disable-lzma',
      '--without-libdeflate',
    ],
    htslib,
    env
  );
  run('/usr/bin/make', ['-j', jobs, 'libhts.a'], htslib, env);
  run(
    './configure',
    [`--with-htslib=${htslib}`, '--disable-configure-htslib', '--without-curses'],
    path.join(root, 'samtools'),
    env
  );
  run('/usr/bin/make', ['-j', jobs, 'samtools'], path.join(root, 'samtools'), env);
  const stage = mkdtempSync(path.join(cache, '.publish-'));
  writeFileSync(path.join(stage, 'ngs-tools.source.lock.json'), lockBytes);
  const tools = {};
  for (const { name } of NGS_TOOL_SPECS) {
    const file = `${name}-${suffix}`;
    copyFileSync(path.join(root, name, name), path.join(stage, file));
    tools[name] = { file, ...verifyBinary(name, path.join(stage, file)) };
  }
  mkdirSync(path.join(stage, 'ngs-tools.licenses'));
  const licenses = [];
  for (const [name, source] of Object.entries(lock.sources)) {
    for (const relative of source.licenses) {
      const file = `${name}-${relative.replaceAll('/', '-')}`;
      const bytes = readFileSync(path.join(root, name, relative));
      copyFileSync(path.join(root, name, relative), path.join(stage, 'ngs-tools.licenses', file));
      licenses.push({ file, sha256: digest(bytes), bytes: bytes.length });
    }
  }
  const receipt = {
    schema: 'dnaforge.ngs-tools-build.v1',
    phase: 'source-build-before-package-signing',
    sourceCommit: capture('git', ['-C', repository, 'rev-parse', 'HEAD']),
    runId: process.env.GITHUB_RUN_ID ?? null,
    recipeKey,
    ...recipe,
    sources: lock.sources,
    tools,
    licenses,
    staticLibraries: { htslib: digest(readFileSync(path.join(htslib, 'libhts.a'))) },
  };
  writeFileSync(path.join(stage, 'ngs-tools.build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  validatePublished(stage);
  try {
    renameSync(stage, published);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    validatePublished(published);
  }
}
validatePublished(published);
mkdirSync(output, { recursive: true });
function publish(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}
for (const { name } of NGS_TOOL_SPECS) {
  publish(path.join(published, `${name}-${suffix}`), path.join(output, `${name}-${suffix}`));
}
publish(path.join(published, 'ngs-tools.build.json'), path.join(output, 'ngs-tools.build.json'));
publish(
  path.join(published, 'ngs-tools.source.lock.json'),
  path.join(output, 'ngs-tools.source.lock.json')
);
mkdirSync(path.join(output, 'ngs-tools.licenses'), { recursive: true });
for (const { file } of validatePublished(published).licenses) {
  publish(
    path.join(published, 'ngs-tools.licenses', file),
    path.join(output, 'ngs-tools.licenses', file)
  );
}
