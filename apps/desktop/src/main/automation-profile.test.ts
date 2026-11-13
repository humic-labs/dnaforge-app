import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { automationUserDataPath } from './automation-profile';
import { prepareStartupProfile } from './startup-profile';
import { classifyReleaseBuildStamp } from './release-stamp';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('the real startup owner selects automation before inspecting or cloning shared data', () => {
  const f = fixture();
  vi.stubEnv('DNAFORGE_AUTOMATION_CONTEXT', f.context);
  const decision = prepareStartupProfile(
    {
      defaultUserData: join(f.root, 'unrelated-shared-profile'),
      argv: ['DNAForge'],
      isDev: false,
      desktopDevPort: undefined,
      release: classifyReleaseBuildStamp(''),
      currentSchemaVersion: 47,
      applicationDirectory: f.root,
    },
    {
      openDatabase: () => {
        throw new Error('Shared profile was inspected');
      },
    }
  );
  expect(decision).toEqual({
    kind: 'automation-isolated',
    userDataPath: f.profile,
    migrationAllowed: true,
    migrateLegacyUserData: false,
    cloneSharedDatabase: false,
  });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-agent-')));
  roots.push(root);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(root, 'tmp'), { mode: 0o700 });
  const context = join(root, 'context.json');
  writeFileSync(
    context,
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent-automation',
      id: randomUUID(),
      root,
      workspace: root,
      profile,
    }),
    { mode: 0o600 }
  );
  return { root, profile, context };
}

it('selects exactly the owned automation profile before shared profile inspection', () => {
  const f = fixture();
  expect(automationUserDataPath([], { DNAFORGE_AUTOMATION_CONTEXT: f.context })).toBe(f.profile);
  expect(
    automationUserDataPath([`--user-data-dir=${f.profile}`], {
      DNAFORGE_AUTOMATION_CONTEXT: f.context,
    })
  ).toBe(f.profile);
});

it('refuses a missing required context and a contradictory explicit shared profile', () => {
  expect(() => automationUserDataPath([], { DNAFORGE_DATA_CONFINEMENT_REQUIRED: '1' })).toThrow();
  const f = fixture();
  expect(() =>
    automationUserDataPath(['--user-data-dir=/unrelated/profile'], {
      DNAFORGE_AUTOMATION_CONTEXT: f.context,
    })
  ).toThrow();
  expect(() =>
    automationUserDataPath(['--dnaforge-test-shared-profile'], {
      DNAFORGE_AUTOMATION_CONTEXT: f.context,
    })
  ).toThrow();
});

it('rejects a forged outside profile or unknown policy fields', () => {
  for (const changes of [{ profile: '/unrelated/profile' }, { writeRoots: ['/'] }]) {
    const f = fixture();
    writeFileSync(
      f.context,
      JSON.stringify({ ...JSON.parse(readFileSync(f.context, 'utf8')), ...changes })
    );
    expect(() => automationUserDataPath([], { DNAFORGE_AUTOMATION_CONTEXT: f.context })).toThrow();
  }
});

it('preserves ordinary human startup without an automation context', () => {
  expect(automationUserDataPath([], {})).toBeNull();
});

it('refuses a private profile from a different application worktree', () => {
  const first = fixture();
  const second = fixture();
  expect(() =>
    automationUserDataPath(
      [],
      {
        DNAFORGE_AUTOMATION_CONTEXT: first.context,
      },
      second.root
    )
  ).toThrow('another automation workspace');
});
