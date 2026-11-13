import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { hasExplicitUserDataDir } from './userdata-migration';

const PROFILE_MARKER = '.dnaforge-disposable-scenario.json';
const authorizedProfiles = new Map<string, string>();

const ELECTRON_BOOT_FILES = new Set([
  'Local State',
  'Crashpad',
  'Crash Reports',
  'DevToolsActivePort',
  'logs',
]);

interface ScenarioProfileAdmissionDiagnostic {
  stage: string;
  entryCount: number;
  entryNames: string[];
}

let admissionDiagnostic: ScenarioProfileAdmissionDiagnostic | null = null;

export function getScenarioProfileAdmissionDiagnostic(): ScenarioProfileAdmissionDiagnostic | null {
  return admissionDiagnostic
    ? { ...admissionDiagnostic, entryNames: [...admissionDiagnostic.entryNames] }
    : null;
}

function denyScenarioProfile(stage: string, entries: readonly string[] = []): null {
  admissionDiagnostic = {
    stage,
    entryCount: entries.length,
    entryNames: [...entries].sort().slice(0, 32),
  };
  try {
    console.warn(`[scenario-profile] admission_denied ${JSON.stringify(admissionDiagnostic)}`);
  } catch {}
  return null;
}

interface DisposableScenarioMarker {
  version: 1;
  purpose: 'disposable-scenario';
  profileId: string;
  canonicalPath: string;
}

function isTemporaryProfile(path: string, allowTemporaryRoot = false): boolean {
  const difference = relative(realpathSync(tmpdir()), path);
  return (
    (allowTemporaryRoot || Boolean(difference)) &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`)
  );
}

function readMarker(path: string): DisposableScenarioMarker | null {
  const markerPath = join(path, PROFILE_MARKER);
  try {
    if (!lstatSync(markerPath).isFile() || lstatSync(markerPath).isSymbolicLink()) return null;
    const marker: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (!marker || typeof marker !== 'object') return null;
    const value = marker as Partial<DisposableScenarioMarker>;
    return value.version === 1 &&
      value.purpose === 'disposable-scenario' &&
      typeof value.profileId === 'string' &&
      /^[0-9a-f-]{36}$/.test(value.profileId) &&
      value.canonicalPath === path
      ? (value as DisposableScenarioMarker)
      : null;
  } catch {
    return null;
  }
}

export function prepareDisposableScenarioProfile(input: {
  requested: boolean;
  argv: readonly string[];
  defaultUserData: string;
  treatExplicitUserDataAsShared?: boolean;
  allowUnmarkedElectronBootFiles?: boolean;
}): string | null {
  admissionDiagnostic = null;
  if (!input.requested) return null;
  if (input.treatExplicitUserDataAsShared) return denyScenarioProfile('explicit-shared-profile');
  const explicit = hasExplicitUserDataDir(input.argv);
  const profilePath = explicit
    ? resolve(input.defaultUserData)
    : mkdtempSync(join(tmpdir(), 'dnaforge-scenario-'));
  try {
    const parent = existsSync(profilePath) ? profilePath : resolve(profilePath, '..');
    if (!isTemporaryProfile(realpathSync(parent), true))
      return denyScenarioProfile('outside-temporary-parent');
    if (!existsSync(profilePath)) mkdirSync(profilePath, { recursive: false });
    const canonicalPath = realpathSync(profilePath);
    if (!isTemporaryProfile(canonicalPath) || lstatSync(profilePath).isSymbolicLink())
      return denyScenarioProfile('invalid-physical-profile');
    let marker = readMarker(canonicalPath);
    if (!marker) {
      const entries = readdirSync(canonicalPath);
      if (
        entries.length > 0 &&
        (!input.allowUnmarkedElectronBootFiles ||
          entries.some((name) => !ELECTRON_BOOT_FILES.has(name)))
      )
        return denyScenarioProfile('unmarked-profile-populated', entries);
      marker = {
        version: 1,
        purpose: 'disposable-scenario',
        profileId: randomUUID(),
        canonicalPath,
      };
      writeFileSync(join(canonicalPath, PROFILE_MARKER), JSON.stringify(marker), { flag: 'wx' });
    }
    authorizedProfiles.set(canonicalPath, marker.profileId);
    return canonicalPath;
  } catch {
    return denyScenarioProfile('filesystem-rejection');
  }
}

export function isDisposableScenarioProfileAuthorized(userDataPath: string): boolean {
  try {
    const canonicalPath = realpathSync(userDataPath);
    if (!isTemporaryProfile(canonicalPath)) return false;
    const marker = readMarker(canonicalPath);
    return marker !== null && authorizedProfiles.get(canonicalPath) === marker.profileId;
  } catch {
    return false;
  }
}
