'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  acquireHelperInputs,
  helperInputStatus,
  parseLfsPointer,
} = require('./local-helper-inputs.cjs');
const {
  seedHelpers,
  helperProbe,
  indexerContractProbe,
} = require('./local-helper-inputs.fixture.cjs');

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-lfs-input-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    ...seedHelpers(root, settings),
    root,
    options: {
      repoRoot: root,
      platform: 'darwin',
      arch: settings.arch ?? 'arm64',
      probe: helperProbe,
      indexerContractProbe,
    },
  };
}

test('exact native inputs are a no-op and run the supported schema probes', (t) => {
  const { options } = fixture(t);
  assert.deepEqual(
    acquireHelperInputs(options, { runGit: () => assert.fail('must not fetch') }).problems,
    []
  );
});

test('only missing/pointer helpers fetch exact HEAD paths before checkout and validation', (t) => {
  const { options, helpers, commit } = fixture(t);
  fs.unlinkSync(helpers[0].helperPath);
  fs.writeFileSync(helpers[1].helperPath, helpers[1].pointer);
  const commands = [];
  const result = acquireHelperInputs(options, {
    runGit: (root, args) => {
      assert.equal(root, options.repoRoot);
      commands.push(args);
      if (args[1] === 'checkout')
        for (const helper of helpers)
          fs.writeFileSync(helper.helperPath, helper.bytes, { mode: 0o755 });
    },
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(commands, [
    ['lfs', 'version'],
    [
      'lfs',
      'fetch',
      `--include=${helpers.map((h) => h.relativePath).join(',')}`,
      '--exclude=',
      'origin',
      commit,
    ],
    ['lfs', 'checkout', ...helpers.map((h) => h.relativePath)],
  ]);
});

test('one missing helper never checks out the already-valid helper', (t) => {
  const { options, helpers } = fixture(t);
  fs.unlinkSync(helpers[0].helperPath);
  const commands = [];
  acquireHelperInputs(options, {
    runGit: (_, args) => {
      commands.push(args);
      if (args[1] === 'checkout')
        fs.writeFileSync(helpers[0].helperPath, helpers[0].bytes, { mode: 0o755 });
    },
  });
  assert.deepEqual(commands.at(-1), ['lfs', 'checkout', helpers[0].relativePath]);
});

for (const defect of ['corrupt', 'non-executable', 'truncated', 'symlink', 'changed-pointer']) {
  test(`refuses ${defect} bytes without overwriting or probing them`, (t) => {
    const { options, helpers } = fixture(t);
    const first = helpers[0];
    if (defect === 'corrupt') fs.appendFileSync(first.helperPath, 'corrupt');
    if (defect === 'non-executable') fs.chmodSync(first.helperPath, 0o644);
    if (defect === 'truncated') fs.writeFileSync(first.helperPath, 'placeholder');
    if (defect === 'changed-pointer')
      fs.writeFileSync(first.helperPath, first.pointer.replace('size 4096', 'size 4097'));
    if (defect === 'symlink') {
      fs.unlinkSync(first.helperPath);
      fs.symlinkSync(helpers[1].helperPath, first.helperPath);
    }
    const result = acquireHelperInputs(
      {
        ...options,
        probe: (exe, args) => {
          assert.notEqual(exe, first.helperPath);
          return helperProbe(exe, args);
        },
      },
      { runGit: () => assert.fail('must preserve invalid bytes') }
    );
    assert.ok(result.problems.length > 0);
    assert.equal(result.missing.length, 0);
  });
}

test('rejects wrong architecture even when its hash matches HEAD', (t) => {
  const { options } = fixture(t, { binaryArch: 'x64' });
  const result = helperInputStatus({
    ...options,
    probe: () => assert.fail('foreign binary must not run'),
  });
  assert.match(result.problems.join('\n'), /architecture mismatch/);
});

test('rejects unsupported schema after exact byte and architecture checks', (t) => {
  const { options } = fixture(t);
  const result = helperInputStatus({
    ...options,
    probe: () => ({ status: 0, stdout: 'schema 99' }),
  });
  assert.equal(result.problems.length, 2);
  assert.match(result.problems.join('\n'), /unsupported helper schema/);
});

test('rejects a schema-compatible indexer with the legacy output contract', (t) => {
  const { options } = fixture(t);
  const result = helperInputStatus({
    ...options,
    indexerContractProbe: () => ({
      problem: 'output inventory contains contract.fa instead of contract.fa.gz',
    }),
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /incompatible indexed-genome output contract/);
  assert.match(result.problems[0], /contract\.fa instead of contract\.fa\.gz/);
});

test('missing Git LFS fails before checkout and preserves pointers', (t) => {
  const { options, helpers } = fixture(t);
  fs.writeFileSync(helpers[0].helperPath, helpers[0].pointer);
  const result = acquireHelperInputs(options, {
    runGit: (_, args) => {
      assert.deepEqual(args, ['lfs', 'version']);
      throw new Error('git-lfs unavailable');
    },
  });
  assert.match(result.problems.join('\n'), /git-lfs unavailable/);
  assert.equal(fs.readFileSync(helpers[0].helperPath, 'utf8'), helpers[0].pointer);
});

test('an absent x64 object fails clearly without a replacement build', (t) => {
  const { options } = fixture(t);
  const result = acquireHelperInputs(
    { ...options, arch: 'x64' },
    { runGit: () => assert.fail('no invented x64 source') }
  );
  assert.match(
    result.problems.join('\n'),
    /supply the reviewed x64 object, do not compile a replacement/
  );
});

test('a tracked x64 helper uses its own exact object and architecture', (t) => {
  const { options } = fixture(t, { arch: 'x64' });
  assert.deepEqual(helperInputStatus(options).problems, []);
});

test('source pointer parser refuses extension, extra line, noncanonical size and unsafe size', () => {
  const valid = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 4096\n`;
  assert.equal(parseLfsPointer(valid).size, 4096);
  for (const invalid of [
    valid + '\n',
    valid.replace('4096', '04096'),
    valid.replace('4096', '9007199254740992'),
    valid.replace('4096', '132'),
    valid.replace('oid ', 'ext-0-foo x\noid '),
  ]) {
    assert.throws(() => parseLfsPointer(invalid), /three-line/);
  }
});
