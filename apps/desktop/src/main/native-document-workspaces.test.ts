import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeDocumentWorkspaces } from './native-document-workspaces';

const first = resolve('workspace-first');
const second = resolve('workspace-second');

describe('explicit native document workspace enrollment', () => {
  it('retains an existing workspace permit when another workspace is added, but never restores a retired permit', async () => {
    const access = new NativeDocumentWorkspaces({ resolveRoot: async (root) => root });
    expect(access.roots()).toEqual([]);
    expect(() => access.capture(first)).toThrow(/enrolled/i);
    await access.replaceRoots([first]);
    const assertFirst = access.capture(first);
    await access.replaceRoots([second, first]);
    expect(() => assertFirst()).not.toThrow();
    const assertSecond = access.capture(second);
    await access.replaceRoots([second]);
    expect(() => assertFirst()).toThrow(/enrollment changed/i);
    expect(() => assertSecond()).not.toThrow();
    await access.replaceRoots([first, second]);
    expect(() => assertFirst()).toThrow(/enrollment changed/i);
    expect(() => access.capture(first)()).not.toThrow();
  });

  it('does not let a delayed older mount overwrite the current workspace set', async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access = new NativeDocumentWorkspaces({
      resolveRoot: async (root) => {
        if (root === first) await waiting;
        return root;
      },
    });
    const older = access.replaceRoots([first]);
    expect(await access.replaceRoots([second])).toBe(true);
    release();
    expect(await older).toBe(false);
    expect(access.roots()).toEqual([second]);
    expect(() => access.capture(first)).toThrow(/enrolled/i);
  });

  it('captures the submitted roots before resolving aliases and keeps one canonical permit', async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const alias = resolve('workspace-alias');
    const roots = [alias, first];
    const access = new NativeDocumentWorkspaces({
      resolveRoot: async (root) => {
        await waiting;
        return root === alias ? first : root;
      },
    });
    const enrolling = access.replaceRoots(roots);
    roots.splice(0, roots.length, second);
    release();
    expect(await enrolling).toBe(true);
    expect(access.roots()).toEqual([first]);
    expect(() => access.capture(second)).toThrow(/enrolled/i);
  });

  it('does not partially enroll a set whose native path authorization fails', async () => {
    const access = new NativeDocumentWorkspaces({
      resolveRoot: async (root) => {
        if (root === second) throw new Error('Reference workspace is read-only');
        return root;
      },
    });
    await expect(access.replaceRoots([first, second])).rejects.toThrow(/read-only/i);
    expect(access.roots()).toEqual([]);
  });

  it('discards a workspace update whose initiating application load was replaced', async () => {
    let current = true;
    const access = new NativeDocumentWorkspaces({
      resolveRoot: async (root) => {
        current = false;
        return root;
      },
    });
    expect(await access.replaceRoots([first], () => current)).toBe(false);
    expect(access.roots()).toEqual([]);
  });

  it.each([
    { roots: ['relative/path'] },
    { roots: Array.from({ length: 129 }, (_, index) => resolve(String(index))) },
  ])('refuses invalid or unbounded enrollment without resolving any paths', async ({ roots }) => {
    let calls = 0;
    const access = new NativeDocumentWorkspaces({
      resolveRoot: async (root) => {
        calls++;
        return root;
      },
    });
    await expect(access.replaceRoots(roots)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(access.roots()).toEqual([]);
  });
});
