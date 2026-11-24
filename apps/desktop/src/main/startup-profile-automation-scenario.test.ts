import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareStartupProfile, type PrepareStartupProfileInput } from './startup-profile';
import { classifyReleaseBuildStamp } from './release-stamp';
import { isDisposableScenarioProfileAuthorized } from './scenario-profile';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function automation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-startup-contract-')));
  roots.push(root);
  const profile = join(root, 'profile');
  const workspace = join(root, 'workspace');
  for (const directory of [profile, workspace, join(root, 'tmp')])
    mkdirSync(directory, { mode: 0o700 });
  const context = join(root, 'context.json');
  writeFileSync(
    context,
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent-automation',
      id: randomUUID(),
      root,
      profile,
      workspace,
    }),
    { mode: 0o600 }
  );
  vi.stubEnv('DNAFORGE_AUTOMATION_CONTEXT', context);
  vi.stubEnv('DNAFORGE_DATA_CONFINEMENT_REQUIRED', '1');
  vi.stubEnv('DNAFORGE_ALLOW_SCENARIO_MUTATION', '');
  vi.stubEnv('WAYPOINT_TEST', '');
  const input: PrepareStartupProfileInput = {
    defaultUserData: join(root, 'unowned-default'),
    argv: ['DNAForge'],
    isDev: true,
    desktopDevPort: '12345',
    release: classifyReleaseBuildStamp(''),
    currentSchemaVersion: 1,
    applicationDirectory: workspace,
  };
  return { input, profile };
}

describe('automation scenario startup admission', () => {
  it('authorizes only the context-owned profile for an environment scenario request', () => {
    const { input, profile } = automation();
    vi.stubEnv('DNAFORGE_ALLOW_SCENARIO_MUTATION', '1');
    const decision = prepareStartupProfile(input);
    expect(decision).toMatchObject({
      kind: 'scenario-disposable',
      userDataPath: profile,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    });
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(true);
    expect(existsSync(input.defaultUserData)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(profile, '.dnaforge-disposable-scenario.json'), 'utf8'))
    ).toMatchObject({ purpose: 'disposable-scenario', canonicalPath: profile });
  });

  it('uses the same owner when the request and profile are explicit startup inputs', () => {
    const { input, profile } = automation();
    const decision = prepareStartupProfile({
      ...input,
      scenarioMutationRequested: true,
      argv: ['DNAForge', `--user-data-dir=${profile}`],
    });
    expect(decision.userDataPath).toBe(profile);
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(true);
  });

  it('leaves ordinary automation isolated without scenario authority', () => {
    const { input, profile } = automation();
    const decision = prepareStartupProfile(input);
    expect(decision.kind).toBe('automation-isolated');
    expect(decision.userDataPath).toBe(profile);
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(false);
    expect(existsSync(join(profile, '.dnaforge-disposable-scenario.json'))).toBe(false);
  });

  it('refuses a shared profile request even inside a valid automation context', () => {
    const { input, profile } = automation();
    expect(() =>
      prepareStartupProfile({
        ...input,
        scenarioMutationRequested: true,
        treatExplicitUserDataAsShared: true,
      })
    ).toThrow(/shared/iu);
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(false);
  });

  it('refuses to adopt an unmarked populated profile and preserves its bytes', () => {
    const { input, profile } = automation();
    const database = join(profile, 'dnaforge.db');
    writeFileSync(database, 'existing-user-data');
    expect(() => prepareStartupProfile({ ...input, scenarioMutationRequested: true })).toThrow(
      /scenario|disposable|profile/iu
    );
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(false);
    expect(readFileSync(database, 'utf8')).toBe('existing-user-data');
    expect(existsSync(join(profile, '.dnaforge-disposable-scenario.json'))).toBe(false);
  });

  it('admits only the existing owner-approved development boot files', () => {
    const { input, profile } = automation();
    writeFileSync(join(profile, 'Local State'), '{}');
    prepareStartupProfile({ ...input, scenarioMutationRequested: true });
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(true);
    expect(readFileSync(join(profile, 'Local State'), 'utf8')).toBe('{}');
  });

  it('reuses its admitted profile after a scenario writes application data', () => {
    const { input, profile } = automation();
    const requested = { ...input, scenarioMutationRequested: true };
    prepareStartupProfile(requested);
    const marker = readFileSync(join(profile, '.dnaforge-disposable-scenario.json'), 'utf8');
    writeFileSync(join(profile, 'dnaforge.db'), 'scenario-data');
    const reopened = prepareStartupProfile(requested);
    expect(reopened.userDataPath).toBe(profile);
    expect(isDisposableScenarioProfileAuthorized(profile)).toBe(true);
    expect(readFileSync(join(profile, '.dnaforge-disposable-scenario.json'), 'utf8')).toBe(marker);
    expect(readFileSync(join(profile, 'dnaforge.db'), 'utf8')).toBe('scenario-data');
  });
});
