import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { createRegisteredProjectAuthorityFixture } from './__tests__/registered-project-authority-fixture';

const first = resolve('workspace-first');
const second = resolve('workspace-second');

describe('registered native project access and displayed roots', () => {
  it('retains registered access when display roots change and never restores a replaced owner permit', async () => {
    const registry = createRegisteredProjectAuthorityFixture();
    const access = new NativeDocumentWorkspaces({ authority: registry.authority });
    expect(access.roots()).toEqual([]);
    expect(() => access.capture(first)).toThrow(/registered project/i);
    await access.replaceRoots([first]);
    expect(access.roots()).toEqual([]);
    registry.register(first);
    expect(access.roots()).toEqual([first]);
    await access.replaceRoots([first]);
    const assertFirst = access.capture(first);
    registry.register(second);
    await access.replaceRoots([second, first]);
    expect(() => assertFirst()).not.toThrow();
    const assertSecond = access.capture(second);
    await access.replaceRoots([second]);
    expect(access.observedRoots()).toEqual([second]);
    expect(() => assertFirst()).not.toThrow();
    registry.remove(first);
    expect(() => assertFirst()).toThrow(/registered project authority changed/i);
    expect(() => assertSecond()).not.toThrow();
    registry.register(first);
    await access.replaceRoots([first, second]);
    expect(() => assertFirst()).toThrow(/registered project authority changed/i);
    expect(() => access.capture(first)()).not.toThrow();
  });

  it('replaces presentation roots without changing registered access', async () => {
    const registry = createRegisteredProjectAuthorityFixture([first, second]);
    const access = new NativeDocumentWorkspaces({ authority: registry.authority });
    await access.replaceRoots([first]);
    expect(await access.replaceRoots([second])).toBe(true);
    expect(access.observedRoots()).toEqual([second]);
    expect(access.roots()).toEqual([first, second]);
    expect(() => access.capture(first)()).not.toThrow();
  });

  it('copies and deduplicates submitted presentation roots without admitting another project', async () => {
    const registry = createRegisteredProjectAuthorityFixture([first]);
    const access = new NativeDocumentWorkspaces({ authority: registry.authority });
    const roots = [first, first];
    const observing = access.replaceRoots(roots);
    roots.splice(0, roots.length, second);
    expect(await observing).toBe(true);
    expect(access.observedRoots()).toEqual([first]);
    expect(access.roots()).toEqual([first]);
    expect(() => access.capture(second)).toThrow(/registered project/i);
  });

  it('keeps readable registered references out of writable access and observed writable roots', async () => {
    const registry = createRegisteredProjectAuthorityFixture([first]);
    registry.register(second, true);
    const access = new NativeDocumentWorkspaces({ authority: registry.authority });
    await access.replaceRoots([first, second]);
    expect(access.roots()).toEqual([first]);
    expect(access.readableRoots()).toEqual([first, second]);
    expect(access.observedRoots()).toEqual([first]);
    expect(access.observedReadableRoots()).toEqual([first, second]);
    expect(() => access.capture(second)).toThrow(/registered project/i);
    expect(() => access.captureReadable(second)()).not.toThrow();
  });

  it('discards a presentation update whose initiating application load was replaced', async () => {
    const registry = createRegisteredProjectAuthorityFixture([first]);
    const access = new NativeDocumentWorkspaces({ authority: registry.authority });
    expect(await access.replaceRoots([first], () => false)).toBe(false);
    expect(access.observedRoots()).toEqual([]);
    expect(access.roots()).toEqual([first]);
  });

  it.each([
    { roots: ['relative/path'] },
    { roots: Array.from({ length: 129 }, (_, index) => resolve(String(index))) },
  ])(
    'refuses invalid or unbounded presentation roots before consulting registered authority',
    async ({ roots }) => {
      let calls = 0;
      const registry = createRegisteredProjectAuthorityFixture();
      const access = new NativeDocumentWorkspaces({
        authority: {
          ...registry.authority,
          list: () => {
            calls++;
            return [];
          },
        },
      });
      await expect(access.replaceRoots(roots)).rejects.toThrow();
      expect(calls).toBe(0);
      expect(access.observedRoots()).toEqual([]);
    }
  );
});
