import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { SequenceDesign } from '../features/design/types';
import {
  designContentIdentity,
  DesignArtifactConflictError,
} from '../features/design/design-recovery';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from './sequence-package';

const ROOT = '/workspace/sequence-1';
const META = `${ROOT}/.forge/plasmid.json`;
const COPY = `${ROOT}/contents/assembly-working-copy.wpdesign.json`;

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failMarkerWrite: false,
  writes: [] as Array<{ path: string; mode: string }>,
  trashItem: vi.fn(),
  beginWorkspaceMutation: vi.fn(async () => 'mutation-token'),
  endWorkspaceMutation: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      exists: vi.fn(async (path: string) => mocks.files.has(path)),
      readTextFile: vi.fn(async (path: string) => {
        const value = mocks.files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      }),
      mkdir: vi.fn(async () => undefined),
      beginWorkspaceMutation: mocks.beginWorkspaceMutation,
      endWorkspaceMutation: mocks.endWorkspaceMutation,
      writeWorkspaceTextFileAtomic: vi.fn(
        async (input: {
          path: string;
          content: string;
          mode: 'create' | 'replace';
          expectedContentHash?: string;
        }) => {
          if (input.path === META && mocks.failMarkerWrite) throw new Error('marker CAS failed');
          const current = mocks.files.get(input.path);
          if (input.mode === 'create' && current !== undefined) throw new Error('file exists');
          if (input.mode === 'replace') {
            if (current === undefined) throw new Error('file missing');
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current));
            const actual = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0')
            ).join('');
            if (actual !== input.expectedContentHash) throw new Error('content changed');
          }
          mocks.files.set(input.path, input.content);
          mocks.writes.push({ path: input.path, mode: input.mode });
          return { path: input.path, contentHash: 'saved' };
        }
      ),
    },
    shell: {
      trashItem: mocks.trashItem.mockImplementation(async (path: string) => {
        mocks.files.delete(path);
      }),
    },
  }),
}));

vi.mock('./workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: vi.fn(async (id: string) =>
    id === 'sequence-1' ? { path: ROOT, file_kind: 'waypoint-sequence' } : null
  ),
}));

import {
  consumePackageAssemblyWorkingCopy,
  createPackageAssemblyWorkingCopy,
  readPackageAssemblyWorkingCopy,
  writePackageAssemblyWorkingCopySnapshot,
} from './sequence-package-working-copy-storage';

function draft(name = 'Draft'): SequenceDesign {
  return {
    id: 'draft-1',
    name,
    constructId: 'sequence-1',
    parentAcceptedAssemblyVersionId: 'accepted-1',
  } as SequenceDesign;
}

function document() {
  return buildSequencePackageDocument({
    id: 'sequence-1',
    name: 'Sequence 1',
    product: { file: 'sequence.gb' },
    assembly: { accepted: { acceptedAssemblyVersionId: 'accepted-1', designId: 'original' } },
  });
}

describe('assembly working-copy package storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.files.clear();
    mocks.writes = [];
    mocks.failMarkerWrite = false;
    mocks.files.set(META, serializeSequencePackageDocument(document()));
    useWorkspaceStore.setState({
      folders: [{ name: 'workspace', path: '/workspace', addedAt: 1 }],
    });
  });

  it('creates only an internal member and resumes its recorded bytes', async () => {
    const created = await createPackageAssemblyWorkingCopy({
      packageRoot: ROOT,
      packageId: 'sequence-1',
      design: draft(),
    });
    expect(created).toMatchObject({ created: true, copy: { path: COPY } });
    expect([...mocks.files.keys()]).toEqual([META, COPY]);
    expect(mocks.writes).toEqual([
      { path: COPY, mode: 'create' },
      { path: META, mode: 'replace' },
    ]);
    expect(parseSequencePackageDocument(mocks.files.get(META)!).members).toContainEqual(
      expect.objectContaining({ id: 'draft-1', role: 'assembly-working-copy', replaceable: false })
    );
    expect(await readPackageAssemblyWorkingCopy(ROOT)).toMatchObject({
      path: COPY,
      design: { id: 'draft-1', name: 'Draft' },
      published: false,
    });
    expect(
      await createPackageAssemblyWorkingCopy({
        packageRoot: ROOT,
        packageId: 'sequence-1',
        design: draft('Recreated'),
      })
    ).toMatchObject({ created: false, copy: { design: { name: 'Draft' } } });
  });

  it('publishes edits with a checked base revision and rejects external conflicts', async () => {
    await createPackageAssemblyWorkingCopy({
      packageRoot: ROOT,
      packageId: 'sequence-1',
      design: draft(),
    });
    const base = designContentIdentity(draft());
    const result = await writePackageAssemblyWorkingCopySnapshot({
      designId: 'draft-1',
      name: 'Edited',
      design: draft('Edited'),
      recovery: { base, beforeWrite: vi.fn() },
    });
    expect(result?.path).toBe(COPY);
    expect(JSON.parse(mocks.files.get(COPY)!).design.name).toBe('Edited');
    mocks.files.set(COPY, mocks.files.get(COPY)!.replace('Edited', 'External'));
    await expect(
      writePackageAssemblyWorkingCopySnapshot({
        designId: 'draft-1',
        name: 'Another edit',
        design: draft('Another edit'),
        recovery: { base, beforeWrite: vi.fn() },
      })
    ).rejects.toBeInstanceOf(DesignArtifactConflictError);
  });

  it('retires only a copy that produced the accepted version', async () => {
    await createPackageAssemblyWorkingCopy({
      packageRoot: ROOT,
      packageId: 'sequence-1',
      design: draft(),
    });
    await expect(
      consumePackageAssemblyWorkingCopy({
        packageRoot: ROOT,
        packageId: 'sequence-1',
        designId: 'draft-1',
      })
    ).rejects.toThrow(/does not consume/);
    const current = parseSequencePackageDocument(mocks.files.get(META)!);
    mocks.files.set(
      META,
      serializeSequencePackageDocument({
        ...current,
        assembly: { accepted: { acceptedAssemblyVersionId: 'accepted-2', designId: 'draft-1' } },
      })
    );
    expect(await readPackageAssemblyWorkingCopy(ROOT)).toMatchObject({ published: true });
    await expect(
      writePackageAssemblyWorkingCopySnapshot({
        designId: 'draft-1',
        name: 'Too late',
        design: draft('Too late'),
      })
    ).rejects.toThrow();
    expect(
      await consumePackageAssemblyWorkingCopy({
        packageRoot: ROOT,
        packageId: 'sequence-1',
        designId: 'draft-1',
      })
    ).toBe(COPY);
    expect(parseSequencePackageDocument(mocks.files.get(META)!).members).toHaveLength(0);
    expect(mocks.files.has(COPY)).toBe(false);
  });

  it('leaves an unregistered file intact if marker publication fails', async () => {
    mocks.failMarkerWrite = true;
    await expect(
      createPackageAssemblyWorkingCopy({
        packageRoot: ROOT,
        packageId: 'sequence-1',
        design: draft(),
      })
    ).rejects.toThrow(/marker CAS failed/);
    expect(mocks.files.has(COPY)).toBe(true);
    expect(parseSequencePackageDocument(mocks.files.get(META)!).members).toHaveLength(0);
    mocks.failMarkerWrite = false;
    await expect(
      createPackageAssemblyWorkingCopy({
        packageRoot: ROOT,
        packageId: 'sequence-1',
        design: draft(),
      })
    ).rejects.toThrow(/Unregistered assembly working copy exists/);
    expect(mocks.files.has(COPY)).toBe(true);
  });
});
