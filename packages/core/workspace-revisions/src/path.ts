import { utf8ToBytes } from '@noble/hashes/utils';

import type { Brand, ResourcePath, Result, WorkspacePath } from './identity';
import { unicodeFullCaseFoldV15_1 } from './unicode-case-fold-v15_1';
import { isUnicodeScalarString } from './unicode';

export type PathError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'absolute' }
  | { readonly kind: 'drive-qualified' }
  | { readonly kind: 'backslash' }
  | { readonly kind: 'empty-segment' }
  | { readonly kind: 'dot-segment' }
  | { readonly kind: 'control-character' }
  | { readonly kind: 'invalid-unicode' }
  | { readonly kind: 'reserved-character' }
  | { readonly kind: 'trailing-dot-or-space' }
  | { readonly kind: 'reserved-name' }
  | { readonly kind: 'segment-too-long' }
  | { readonly kind: 'path-too-long' };

const MAX_PORTABLE_SEGMENT_BYTES = 255;
const MAX_PORTABLE_SEGMENT_CODE_UNITS = 255;
const MAX_PORTABLE_PATH_BYTES = 1_023;

export type MaterializedPathError =
  | {
      readonly kind: 'path-collision';
      readonly paths: readonly [WorkspacePath, WorkspacePath];
    }
  | {
      readonly kind: 'file-ancestor-collision';
      readonly ancestor: WorkspacePath;
      readonly descendant: WorkspacePath;
    };

export interface MaterializedPathEntry {
  readonly owner: string;
  readonly kind: 'file' | 'directory';
  readonly path: WorkspacePath;
}

export function parseWorkspacePath(value: string): Result<WorkspacePath, PathError> {
  return parsePortablePath(value);
}

export function parseResourcePath(value: string): Result<ResourcePath, PathError> {
  return parsePortablePath(value);
}

export function pathCollisionKey(path: WorkspacePath | ResourcePath): string {
  return unicodeFullCaseFoldV15_1(path);
}

export function validateMaterializedTree(
  entries: readonly MaterializedPathEntry[]
): Result<void, MaterializedPathError> {
  const keyed = entries.map((entry) => ({ entry, key: pathCollisionKey(entry.path) }));
  const firstByKey = new Map<string, MaterializedPathEntry>();
  for (const candidate of keyed) {
    const first = firstByKey.get(candidate.key);
    if (first) {
      return {
        ok: false,
        error: { kind: 'path-collision', paths: [first.path, candidate.entry.path] },
      };
    }
    firstByKey.set(candidate.key, candidate.entry);
  }

  keyed.sort((left, right) => deterministicCompare(left.key, right.key));
  for (const possibleDescendant of keyed) {
    const collision = fileAncestorCollision(possibleDescendant, firstByKey);
    if (collision) return { ok: false, error: collision };
  }
  return { ok: true, value: undefined };
}

export function validatePathMove(input: {
  readonly owner: string;
  readonly currentPath: WorkspacePath;
  readonly destination: WorkspacePath;
  readonly occupied: readonly MaterializedPathEntry[];
}): Result<void, MaterializedPathError> {
  const remaining = input.occupied.filter(
    (entry) => entry.owner !== input.owner || entry.path !== input.currentPath
  );
  return validateMaterializedTree([
    ...remaining,
    { owner: input.owner, kind: 'file', path: input.destination },
  ]);
}

function parsePortablePath<Path extends Brand<string, string>>(
  value: string
): Result<Path, PathError> {
  if (value.length === 0) return { ok: false, error: { kind: 'empty' } };
  if (value.startsWith('/')) return { ok: false, error: { kind: 'absolute' } };
  if (/^[A-Za-z]:/u.test(value)) return { ok: false, error: { kind: 'drive-qualified' } };
  if (value.includes('\\')) return { ok: false, error: { kind: 'backslash' } };
  if (!isUnicodeScalarString(value)) return { ok: false, error: { kind: 'invalid-unicode' } };

  const normalized = value.normalize('NFC');
  if (utf8ToBytes(normalized).length > MAX_PORTABLE_PATH_BYTES) {
    return { ok: false, error: { kind: 'path-too-long' } };
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, error: { kind: 'empty-segment' } };
    if (segment === '.' || segment === '..') {
      return { ok: false, error: { kind: 'dot-segment' } };
    }
    if (hasControlCharacter(segment)) {
      return { ok: false, error: { kind: 'control-character' } };
    }
    if (/[<>:"|?*]/u.test(segment)) {
      return { ok: false, error: { kind: 'reserved-character' } };
    }
    if (/[. ]$/u.test(segment)) {
      return { ok: false, error: { kind: 'trailing-dot-or-space' } };
    }
    const reservedStem = segment.split('.', 1)[0]?.toUpperCase();
    if (reservedStem && isWindowsReservedName(reservedStem)) {
      return { ok: false, error: { kind: 'reserved-name' } };
    }
    if (
      segment.length > MAX_PORTABLE_SEGMENT_CODE_UNITS ||
      utf8ToBytes(segment).length > MAX_PORTABLE_SEGMENT_BYTES
    ) {
      return { ok: false, error: { kind: 'segment-too-long' } };
    }
  }
  return { ok: true, value: normalized as Path };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isWindowsReservedName(value: string): boolean {
  return (
    value === 'CON' ||
    value === 'PRN' ||
    value === 'AUX' ||
    value === 'NUL' ||
    /^(?:COM|LPT)(?:[1-9¹²³])$/u.test(value)
  );
}

function fileAncestorCollision(
  possibleDescendant: { readonly entry: MaterializedPathEntry; readonly key: string },
  entriesByKey: ReadonlyMap<string, MaterializedPathEntry>
): MaterializedPathError | null {
  let separatorIndex = possibleDescendant.key.indexOf('/');
  while (separatorIndex >= 0) {
    const possibleAncestor = entriesByKey.get(possibleDescendant.key.slice(0, separatorIndex));
    if (possibleAncestor?.kind === 'file') {
      return {
        kind: 'file-ancestor-collision',
        ancestor: possibleAncestor.path,
        descendant: possibleDescendant.entry.path,
      };
    }
    separatorIndex = possibleDescendant.key.indexOf('/', separatorIndex + 1);
  }
  return null;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
