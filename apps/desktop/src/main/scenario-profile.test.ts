/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
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

import {
  getScenarioProfileAdmissionDiagnostic,
  isDisposableScenarioProfileAuthorized,
  prepareDisposableScenarioProfile,
} from './scenario-profile';
import { prepareStartupProfile } from './startup-profile';
import { classifyReleaseBuildStamp } from './release-stamp';

const owned: string[] = [];
const temporaryProfile = () => {
  const path = mkdtempSync(join(tmpdir(), 'dnaforge-scenario-contract-'));
  owned.push(path);
  return path;
};
afterEach(() => {
  vi.restoreAllMocks();
  owned.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('scenario launch physical data boundary', () => {
  it('a requested ordinary dev launch starts a fresh temporary profile without cloning human data', () => {
    const base = temporaryProfile();
    const persistent = join(base, 'DNAForge');
    mkdirSync(persistent);
    writeFileSync(join(persistent, 'dnaforge.db'), 'human data sentinel');
    const decision = prepareStartupProfile({
      defaultUserData: persistent,
      argv: ['DNAForge'],
      isDev: true,
      desktopDevPort: '1650',
      release: classifyReleaseBuildStamp(''),
      currentSchemaVersion: 38,
      scenarioMutationRequested: true,
    });
    if (decision.kind === 'scenario-disposable') owned.push(decision.userDataPath);
    expect(decision.kind).toBe('scenario-disposable');
    expect(decision.cloneSharedDatabase).toBe(false);
    expect(existsSync(join(decision.userDataPath, 'dnaforge.db'))).toBe(false);
    expect(readFileSync(join(persistent, 'dnaforge.db'), 'utf8')).toBe('human data sentinel');
    expect(isDisposableScenarioProfileAuthorized(decision.userDataPath)).toBe(true);
  });

  it('approves an empty mkdtemp E2E profile and its later restart', () => {
    const path = temporaryProfile();
    const input = {
      requested: true,
      explicitUserDataPath: path,
    };
    expect(prepareDisposableScenarioProfile(input)).not.toBeNull();
    writeFileSync(join(path, 'dnaforge.db'), 'only this approved scenario owns the database');
    expect(prepareDisposableScenarioProfile(input)).not.toBeNull();
    expect(isDisposableScenarioProfileAuthorized(path)).toBe(true);
  });

  it('admits Chromium debugger metadata written before a fresh dev profile is authorized', () => {
    const path = temporaryProfile();
    const debuggerFile = join(path, 'DevToolsActivePort');
    const debuggerState = '9612\n/devtools/browser/owned-profile-fixture\n';
    mkdirSync(join(path, 'Crashpad'));
    writeFileSync(debuggerFile, debuggerState);
    const decision = prepareStartupProfile({
      defaultUserData: path,
      argv: ['DNAForge', `--user-data-dir=${path}`],
      isDev: true,
      desktopDevPort: '1812',
      release: classifyReleaseBuildStamp(''),
      currentSchemaVersion: 38,
      scenarioMutationRequested: true,
    });
    expect(decision.kind).toBe('scenario-disposable');
    expect(isDisposableScenarioProfileAuthorized(decision.userDataPath)).toBe(true);
    expect(readFileSync(debuggerFile, 'utf8')).toBe(debuggerState);
    expect(existsSync(join(path, 'dnaforge.db'))).toBe(false);
  });

  it('retains a preapproved debug-enabled dev profile after Electron creates its boot metadata', () => {
    const path = temporaryProfile();
    expect(
      prepareDisposableScenarioProfile({
        requested: true,
        explicitUserDataPath: path,
      })
    ).toBe(realpathSync(path));
    const marker = readFileSync(join(path, '.dnaforge-disposable-scenario.json'), 'utf8');
    mkdirSync(join(path, 'Crashpad'));
    const debugMetadata = '9473\n/devtools/browser/fresh-electron-boot\n';
    writeFileSync(join(path, 'DevToolsActivePort'), debugMetadata);
    const decision = prepareStartupProfile({
      defaultUserData: path,
      argv: ['DNAForge', `--user-data-dir=${path}`, '--dnaforge-allow-scenario-mutation=1'],
      isDev: true,
      desktopDevPort: '1673',
      release: classifyReleaseBuildStamp(''),
      currentSchemaVersion: 38,
      scenarioMutationRequested: true,
    });
    expect(decision.kind).toBe('scenario-disposable');
    expect(isDisposableScenarioProfileAuthorized(path)).toBe(true);
    expect(readFileSync(join(path, 'DevToolsActivePort'), 'utf8')).toBe(debugMetadata);
    expect(readFileSync(join(path, '.dnaforge-disposable-scenario.json'), 'utf8')).toBe(marker);
    expect(existsSync(join(path, 'dnaforge.db'))).toBe(false);
  });

  it('a permission flag never adopts existing unmarked data, even inside OS temp', () => {
    const path = temporaryProfile();
    const dbPath = join(path, 'dnaforge.db');
    writeFileSync(dbPath, 'retain me');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      prepareDisposableScenarioProfile({
        requested: true,
        explicitUserDataPath: path,
      })
    ).toBeNull();
    expect(isDisposableScenarioProfileAuthorized(path)).toBe(false);
    expect(readFileSync(dbPath, 'utf8')).toBe('retain me');
    expect(existsSync(join(path, '.dnaforge-disposable-scenario.json'))).toBe(false);
    expect(getScenarioProfileAdmissionDiagnostic()).toEqual({
      stage: 'unmarked-profile-populated',
      entryCount: 1,
      entryNames: ['dnaforge.db'],
    });
    expect(warning).toHaveBeenCalledWith(
      '[scenario-profile] admission_denied ' +
        JSON.stringify({
          stage: 'unmarked-profile-populated',
          entryCount: 1,
          entryNames: ['dnaforge.db'],
        })
    );
  });

  it('does not follow an explicit profile symlink into another directory', () => {
    const base = temporaryProfile();
    const target = join(base, 'real-profile');
    mkdirSync(target);
    const link = join(base, 'alias');
    symlinkSync(target, link);
    expect(
      prepareDisposableScenarioProfile({
        requested: true,
        explicitUserDataPath: link,
      })
    ).toBeNull();
    expect(isDisposableScenarioProfileAuthorized(target)).toBe(false);
  });

  it('shared-profile recovery fixtures never gain destructive scenario permission', () => {
    const path = temporaryProfile();
    expect(
      prepareDisposableScenarioProfile({
        requested: true,
        explicitUserDataPath: path,
        treatExplicitUserDataAsShared: true,
      })
    ).toBeNull();
    expect(isDisposableScenarioProfileAuthorized(path)).toBe(false);
  });
});
