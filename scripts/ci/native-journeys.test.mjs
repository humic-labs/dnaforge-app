import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createAutomationContext,
  journeyEnvironment,
  selectNativeJourneys,
  sourceIdentity,
  validateJourneyReceipt,
} from './native-journeys.mjs';
import { automationUserDataPath } from '../../apps/desktop/src/main/automation-profile.cjs';
import { helperExecutableName } from '../../apps/desktop/scripts/lib/verify-package-helpers.cjs';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-native-control-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function image(directory, name) {
  writeFileSync(join(directory, name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
}

test('native result rejects absent receipts, incomplete steps, wrong source and lost originals', (t) => {
  const directory = fixture(t);
  const sha = 'a'.repeat(40);
  const phase = { steps: 1 };
  assert.throws(() => validateJourneyReceipt(directory, phase, sha), /ENOENT/);
  const receipt = { sourceCommit: sha, status: 'passed', steps: [] };
  const save = () => writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
  save();
  assert.throws(() => validateJourneyReceipt(directory, phase, sha), /every step/);
  receipt.steps.push({ name: 'saved file', screenshot: 'saved.png' });
  save();
  assert.throws(() => validateJourneyReceipt(directory, phase, sha), /ENOENT/);
  image(directory, 'saved.png');
  assert.equal(validateJourneyReceipt(directory, phase, sha).steps, 1);
  assert.throws(() => validateJourneyReceipt(directory, phase, 'b'.repeat(40)), /another source/);
  receipt.pageErrors = ['renderer crashed'];
  save();
  assert.throws(() => validateJourneyReceipt(directory, phase, sha), /pageErrors/);
});

test('native interaction rejects a screenshot in place of video and missing original frames', (t) => {
  const directory = fixture(t);
  const sha = 'a'.repeat(40);
  image(directory, 'saved.png');
  writeFileSync(join(directory, 'frame.jpg'), Buffer.from([255, 216, 255, 217]));
  const receipt = {
    sourceCommit: sha,
    status: 'passed',
    steps: [{ screenshot: 'saved.png' }],
    frames: [{ file: 'frame.jpg' }, { file: 'missing.jpg' }],
  };
  const save = () => writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
  save();
  assert.throws(
    () => validateJourneyReceipt(directory, { steps: 1, video: 'video.mp4' }, sha),
    /ENOENT/
  );
  writeFileSync(join(directory, 'missing.jpg'), Buffer.from([255, 216, 255, 217]));
  image(directory, 'video.mp4');
  assert.throws(
    () => validateJourneyReceipt(directory, { steps: 1, video: 'video.mp4' }, sha),
    /MP4/
  );
  receipt.steps[0].screenshot = '../outside.png';
  save();
  assert.throws(() => validateJourneyReceipt(directory, { steps: 1 }, sha), /escaped/);
  const outside = fixture(t);
  image(outside, 'linked.png');
  symlinkSync(outside, join(directory, 'linked'), 'dir');
  receipt.steps[0].screenshot = 'linked/linked.png';
  save();
  assert.throws(() => validateJourneyReceipt(directory, { steps: 1 }, sha), /through a link/);
});

test('an automation context is accepted by the production profile owner and rejects another app', (t) => {
  const directory = fixture(t);
  const root = join(directory, 'repo');
  mkdirSync(root);
  const context = createAutomationContext(root, directory);
  assert.equal(
    automationUserDataPath([], { DNAFORGE_AUTOMATION_CONTEXT: context.file }, root),
    context.profile
  );
  const foreign = join(directory, 'other-repo');
  mkdirSync(foreign);
  assert.throws(
    () => automationUserDataPath([], { DNAFORGE_AUTOMATION_CONTEXT: context.file }, foreign),
    /another automation workspace/
  );
  assert.equal(JSON.parse(readFileSync(context.file)).workspace, root);
});

test('the candidate identity fails after a source edit and after checkout changes', (t) => {
  const directory = fixture(t);
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q');
  writeFileSync(join(directory, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=Native qualification fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture'
  );
  const sha = git('rev-parse', 'HEAD');
  assert.equal(sourceIdentity(directory, sha).sourceTree, git('rev-parse', 'HEAD^{tree}'));
  const helperDirectory = join(directory, 'apps/desktop/resources/helpers');
  mkdirSync(helperDirectory, { recursive: true });
  const helperNames = ['dna-indexer', 'dna-coverage', 'dna-process-guardian'].map((name) =>
    helperExecutableName(name, process.platform, process.arch)
  );
  for (const name of helperNames) writeFileSync(join(helperDirectory, name), `generated ${name}`);
  const generated = sourceIdentity(directory, sha).generatedOutputs;
  assert.deepEqual(
    generated.map(({ file }) => file),
    helperNames.map((name) => `apps/desktop/resources/helpers/${name}`).sort()
  );
  for (const output of generated) assert.match(output.sha256, /^[a-f0-9]{64}$/u);
  const foreignHelper = join(helperDirectory, 'dna-indexer-not-the-current-host');
  writeFileSync(foreignHelper, 'unexpected build output');
  assert.throws(() => sourceIdentity(directory, sha), /Untracked source/);
  rmSync(foreignHelper);
  const linkedHelper = join(helperDirectory, helperNames[0]);
  rmSync(linkedHelper);
  symlinkSync(join(directory, 'source.txt'), linkedHelper);
  assert.throws(() => sourceIdentity(directory, sha), /original file/);
  rmSync(linkedHelper);
  writeFileSync(linkedHelper, 'generated helper');
  writeFileSync(join(directory, 'untracked.txt'), 'untracked source\n');
  assert.throws(() => sourceIdentity(directory, sha), /Untracked source/);
  rmSync(join(directory, 'untracked.txt'));
  writeFileSync(join(directory, 'source.txt'), 'changed\n');
  assert.throws(() => sourceIdentity(directory, sha), /Tracked source changed/);
  assert.throws(() => sourceIdentity(directory, 'b'.repeat(40)), /requested source/);
});

test('journey selection refuses empty, duplicate and unknown coverage', () => {
  for (const names of ['', 'chat,chat', 'chat,unknown'])
    assert.throws(() => selectNativeJourneys(names));
  assert.deepEqual(selectNativeJourneys('chat'), ['chat']);
});

test('owned launch replaces inherited worktree identity without bypassing ownership checks', () => {
  const environment = journeyEnvironment(
    {
      DESKTOP_DEV_PORT: '1420',
      API_PORT: '8000',
      DEV_PORT: '1900',
      ALLOW_FOREIGN_DESKTOP_DEV_PORT: '1',
    },
    { renderer: 21000, hmr: 21001, api: 21002, debug: 21003 },
    { file: '/owned/context.json' },
    'chat'
  );
  assert.equal(environment.DESKTOP_DEV_PORT, '21000');
  assert.equal(environment.VITE_API_URL, 'http://127.0.0.1:21002');
  assert.equal(environment.DEV_PORT, undefined);
  assert.equal(environment.ALLOW_FOREIGN_DESKTOP_DEV_PORT, undefined);
  assert.equal(environment.DNAFORGE_DATA_CONFINEMENT_REQUIRED, '1');
  assert.equal(environment.WAYPOINT_DEV_ANTHROPIC_API_KEY, 'verification-fixture');
});
