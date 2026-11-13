// @vitest-environment node
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createProfileBoundNativeDocumentOwnerId,
  nativeDocumentOwnerProfile,
  nativeDocumentProfileKey,
} from './native-document-owner-identity';

it('binds aliases of one physical profile together without exposing its path', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-profile-'));
  const alias = `${root}-alias`;
  try {
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const key = nativeDocumentProfileKey(root);
    expect(nativeDocumentProfileKey(alias)).toBe(key);
    const first = createProfileBoundNativeDocumentOwnerId(key);
    const successor = createProfileBoundNativeDocumentOwnerId(key);
    expect(successor).not.toBe(first);
    expect(nativeDocumentOwnerProfile(first)).toBe(key);
    expect(nativeDocumentOwnerProfile(successor)).toBe(key);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).not.toContain(root);
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not treat legacy, truncated or appended identities as a profile binding', () => {
  const owner = createProfileBoundNativeDocumentOwnerId('a'.repeat(64));
  for (const value of ['legacy-owner', owner.slice(0, -1), `${owner}:extra`, `${owner}\n`]) {
    expect(nativeDocumentOwnerProfile(value)).toBeUndefined();
  }
  expect(() => createProfileBoundNativeDocumentOwnerId('/profile')).toThrow(/profile/i);
});
