#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { arch, availableParallelism, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const lockBytes = readFileSync(path.join(repository, '.ci/fastp-source.lock.json'));
const lock = JSON.parse(lockBytes);
const builderSha256 = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  options.set(process.argv[index], process.argv[index + 1]);
const target = options.get('--arch') ?? arch();
const output = options.get('--output');
if (
  process.platform !== 'darwin' ||
  target !== arch() ||
  !['arm64', 'x64'].includes(target) ||
  !output
)
  throw new Error('Build fastp on its native macOS arm64/x64 host with --output PATH.');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const capture = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const buildIdentity = {
  target,
  builderSha256,
  sourceLockSha256: sha256(lockBytes),
  compiler: capture('clang++', ['--version']),
  sdk: capture('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']),
};
const recipeKey = sha256(JSON.stringify(buildIdentity));
const cache = options.get('--cache-dir') ?? path.join(homedir(), '.cache/dnaforge-fastp');
mkdirSync(cache, { recursive: true });
const published = path.join(cache, `${target}-${recipeKey}`);
const cached = existsSync(published);
let root = cached ? published : mkdtempSync(path.join(cache, `.build-${target}-`));
const scratch = cached ? undefined : root;
const prefix = path.join(root, 'prefix');
const run = (command, args, cwd = root, env = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
function verify(binary) {
  const expected = target === 'arm64' ? 'arm64' : 'x86_64';
  if (capture('lipo', ['-archs', binary]) !== expected)
    throw new Error(`fastp architecture differs from ${expected}`);
  const dependencies = capture('otool', ['-L', binary])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0]);
  if (
    dependencies.some(
      (dependency) =>
        !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')
    )
  )
    throw new Error(`Non-system fastp dylibs: ${dependencies.join(', ')}`);
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0 || (probe.stdout + probe.stderr).trim() !== `fastp ${lock.version}`)
    throw new Error('Unexpected fastp version');
  return dependencies;
}
let binary = path.join(root, 'fastp/fastp');
let receipt = path.join(root, 'fastp-build.json');
function validatePublished(directory) {
  const executable = path.join(directory, 'fastp/fastp');
  const previous = JSON.parse(readFileSync(path.join(directory, 'fastp-build.json'), 'utf8'));
  if (previous.recipeKey !== recipeKey || previous.sha256 !== sha256(readFileSync(executable)))
    throw new Error('The immutable fastp build cache does not match its source-bound identity.');
  verify(executable);
}
if (cached) validatePublished(root);
if (!cached) {
  const packages = [
    'autoconf',
    'automake',
    'libtool',
    'cmake',
    ...(target === 'x64' ? ['nasm'] : []),
  ];
  const commands = {
    autoconf: 'autoconf',
    automake: 'automake',
    libtool: 'glibtoolize',
    cmake: 'cmake',
    nasm: 'nasm',
  };
  const missing = packages.filter(
    (name) => spawnSync('which', [commands[name]], { stdio: 'ignore' }).status !== 0
  );
  if (missing.length) run('brew', ['install', ...missing], root, { HOMEBREW_NO_AUTO_UPDATE: '1' });
  for (const [name, source] of Object.entries(lock.sources)) {
    const archive = path.join(root, `${name}.tar.gz`);
    if (!existsSync(archive) || sha256(readFileSync(archive)) !== source.sha256) {
      run('curl', [
        '--fail',
        '--location',
        '--retry',
        '3',
        '--connect-timeout',
        '20',
        '--max-time',
        '300',
        '--output',
        archive,
        source.url,
      ]);
    }
    if (sha256(readFileSync(archive)) !== source.sha256)
      throw new Error(`Untrusted ${name} source archive`);
    mkdirSync(path.join(root, name), { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', path.join(root, name)]);
  }
  const jobs = String(Math.min(4, availableParallelism()));
  const buildEnvironment = {
    CFLAGS: '-mmacosx-version-min=12.0',
    CXXFLAGS: '-mmacosx-version-min=12.0',
    MACOSX_DEPLOYMENT_TARGET: '12.0',
  };
  run('./autogen.sh', [], path.join(root, 'isal'), buildEnvironment);
  run(
    './configure',
    [`--prefix=${prefix}`, '--disable-shared', '--enable-static'],
    path.join(root, 'isal'),
    buildEnvironment
  );
  run('make', ['-j', jobs], path.join(root, 'isal'), buildEnvironment);
  run('make', ['install'], path.join(root, 'isal'), buildEnvironment);
  for (const name of ['deflate', 'highway']) {
    const source = path.join(root, name),
      build = path.join(root, `cmake-${name}`);
    run(
      'cmake',
      [
        '-S',
        source,
        '-B',
        build,
        `-DCMAKE_INSTALL_PREFIX=${prefix}`,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DLIBDEFLATE_BUILD_SHARED_LIB=OFF',
        '-DLIBDEFLATE_BUILD_STATIC_LIB=ON',
        '-DHWY_ENABLE_TESTS=OFF',
        '-DHWY_ENABLE_EXAMPLES=OFF',
        '-DHWY_ENABLE_CONTRIB=OFF',
      ],
      root,
      buildEnvironment
    );
    run('cmake', ['--build', build, '--parallel', jobs], root, buildEnvironment);
    run('cmake', ['--install', build], root, buildEnvironment);
  }
  for (const name of ['isal', 'deflate', 'hwy'])
    if (!existsSync(path.join(prefix, 'lib', `lib${name}.a`)))
      throw new Error(`Missing static ${name} library`);
  run('make', ['clean'], path.join(root, 'fastp'));
  run(
    'make',
    [
      '-j',
      jobs,
      'CXX=clang++',
      'PKG_CONFIG=/usr/bin/false',
      `INCLUDE_DIRS=${prefix}/include`,
      `LIBRARY_DIRS=${prefix}/lib`,
    ],
    path.join(root, 'fastp'),
    buildEnvironment
  );
  const dependencies = verify(binary);
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        ...buildIdentity,
        recipeKey,
        version: lock.version,
        target,
        sha256: sha256(readFileSync(binary)),
        sources: lock.sources,
        dependencies,
        compiler: capture('clang++', ['--version']),
        libraries: Object.fromEntries(
          ['isal', 'deflate', 'hwy'].map((name) => [
            name,
            sha256(readFileSync(path.join(prefix, 'lib', `lib${name}.a`))),
          ])
        ),
      },
      null,
      2
    )
  );
}
if (!cached) {
  const stage = mkdtempSync(path.join(cache, '.publish-'));
  mkdirSync(path.join(stage, 'fastp'));
  copyFileSync(binary, path.join(stage, 'fastp/fastp'));
  copyFileSync(receipt, path.join(stage, 'fastp-build.json'));
  for (const name of Object.keys(lock.sources)) {
    const source = path.join(root, name);
    const legal = readdirSync(source).filter((entry) =>
      /^(license|copying)(?:[.-]|$)/i.test(entry)
    );
    if (!legal.length) throw new Error(`Missing ${name} license`);
    mkdirSync(path.join(stage, name), { recursive: true });
    for (const entry of legal)
      copyFileSync(path.join(source, entry), path.join(stage, name, entry));
  }
  validatePublished(stage);
  try {
    renameSync(stage, published);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    validatePublished(published);
    rmSync(stage, { recursive: true });
  }
  root = published;
  binary = path.join(root, 'fastp/fastp');
  receipt = path.join(root, 'fastp-build.json');
}
function publishFile(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}
mkdirSync(path.dirname(output), { recursive: true });
publishFile(binary, output);
publishFile(receipt, path.join(path.dirname(output), 'fastp.build.json'));
const licenses = path.join(path.dirname(output), 'fastp.licenses');
mkdirSync(licenses, { recursive: true });
for (const name of Object.keys(lock.sources)) {
  const source = path.join(root, name);
  for (const entry of readdirSync(source).filter((entry) =>
    /^(license|copying)(?:[.-]|$)/i.test(entry)
  ))
    publishFile(path.join(source, entry), path.join(licenses, `${name}-${entry}`));
}
verify(output);
if (scratch) rmSync(scratch, { recursive: true });
process.stdout.write(
  `Built app-owned fastp ${lock.version} for ${target}: ${sha256(readFileSync(output))}\n`
);
