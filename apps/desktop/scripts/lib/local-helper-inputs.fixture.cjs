'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DNA_HELPER_SPECS } = require('./native-binary.cjs');
const { helperExecutableName } = require('./verify-package-helpers.cjs');

function git(root, args, input) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {
      cwd: root,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }
  ).trim();
}

function seedHelpers(root, { arch = 'arm64', binaryArch = arch, mutatePointer = (s) => s } = {}) {
  git(root, ['init', '-q']);
  const helpers = DNA_HELPER_SPECS.map((spec) => {
    const relativePath = `apps/desktop/resources/helpers/${helperExecutableName(spec.name, 'darwin', arch)}`;
    const helperPath = path.join(root, relativePath);
    const bytes = Buffer.alloc(4096);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(binaryArch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
    const pointer = mutatePointer(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`
    );
    const blob = git(root, ['hash-object', '-w', '--stdin'], pointer);
    git(root, ['update-index', '--add', '--cacheinfo', `100755,${blob},${relativePath}`]);
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, bytes, { mode: 0o755 });
    return { ...spec, relativePath, helperPath, bytes, pointer };
  });
  const tree = git(root, ['write-tree']);
  const commit = git(root, ['commit-tree', tree, '-m', 'Synthetic helper authority']);
  git(root, ['update-ref', 'HEAD', commit]);
  return { helpers, commit };
}

function helperProbe(executable, args) {
  const coverage = path.basename(executable).startsWith('dna-coverage-');
  if (JSON.stringify(args) !== JSON.stringify(coverage ? ['schema-version'] : ['--version'])) {
    throw new Error('unexpected schema invocation');
  }
  return { status: 0, stdout: `${coverage ? 'dna-coverage schema 2' : 'dna-indexer schema 2'}\n` };
}

function indexerContractProbe() {
  return { problem: null };
}

module.exports = { seedHelpers, helperProbe, indexerContractProbe, git };
