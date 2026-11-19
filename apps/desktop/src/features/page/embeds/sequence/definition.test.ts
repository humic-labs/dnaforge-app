/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockContentHash, readMarker } = vi.hoisted(() => ({
  mockContentHash: vi.fn(),
  readMarker: vi.fn(),
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    fs: {
      contentHash: mockContentHash,
      exists: async () => true,
      readTextFile: readMarker,
      validateWorkspacePath: async () => true,
    },
  }),
}));

import { sequenceCommand } from './definition';
import type { PickerResult } from '../types';

const BASE = {
  sequenceName: 'pUC19',
  path: 'sequences/vectors/pUC19.gb',
  owningRoot: '/ws/beta',
};

async function complete(data: Record<string, unknown>): Promise<PickerResult> {
  return (await sequenceCommand.picker.onComplete(data)) as PickerResult;
}

describe('sequenceCommand.onComplete', () => {
  beforeEach(() => {
    mockContentHash.mockReset();
    mockContentHash.mockResolvedValue(`sha256:${'a'.repeat(64)}`);
  });

  it('builds a mention carrying the portable path', async () => {
    const result = await complete({ ...BASE, entityId: 'ent-1', contentHash: null });

    expect(result).toMatchObject({
      nodeType: 'mention',
      entityType: 'sequence',
      entityId: 'ent-1',
      label: 'pUC19',
      path: 'sequences/vectors/pUC19.gb',
    });
  });

  it('accepts a null entityId (D8 — a plain .gb has no deterministic id)', async () => {
    const result = await complete({ ...BASE, entityId: null, contentHash: null });

    expect(result).toMatchObject({ entityId: null, path: BASE.path });
  });

  it('REFUSES to build a reference with no path', async () => {
    await expect(complete({ sequenceName: 'x', owningRoot: '/ws/beta' })).rejects.toThrow(/path/);
  });

  it('re-hashes a git: catalog value instead of copying it', async () => {
    const result = await complete({ ...BASE, contentHash: 'git:deadbeef' });

    expect(mockContentHash).toHaveBeenCalledWith({
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'sequences/vectors/pUC19.gb',
    });
    expect((result as { contentHash: string }).contentHash).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('fingerprints the document file and persists the portable package path', async () => {
    const packageRoot = '/ws/beta/sequences/document';
    const sequenceDocument = { kind: 'managed-sequence', packageId: 'ent-1', packageRoot };
    const { buildSequencePackageDocument, serializeSequencePackageDocument } =
      await import('../../../../db/sequence-package');
    readMarker.mockResolvedValue(
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'ent-1',
          name: 'Document',
          product: { file: 'primary.gb' },
        })
      )
    );
    const data = {
      ...BASE,
      path: 'sequences/document',
      entityId: 'ent-1',
      sequenceDocument,
      contentHash: 'git-package:revision',
    };
    expect(await complete(data)).toMatchObject({
      path: data.path,
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    expect(mockContentHash).toHaveBeenCalledWith({
      workspaceRoot: BASE.owningRoot,
      workspaceRelativePath: 'sequences/document/primary.gb',
    });
    mockContentHash.mockClear();
    expect(
      await complete({ ...data, sequenceDocument: { ...sequenceDocument, packageId: 'other' } })
    ).toMatchObject({ contentHash: null });
    expect(mockContentHash).not.toHaveBeenCalled();
  });

  it('passes an existing sha256 through without a main round trip', async () => {
    const existing = `sha256:${'e'.repeat(64)}`;
    const result = await complete({ ...BASE, contentHash: existing });

    expect(mockContentHash).not.toHaveBeenCalled();
    expect((result as { contentHash: string }).contentHash).toBe(existing);
  });

  it('still produces a usable chip when hashing fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockContentHash.mockRejectedValue(new Error('gone'));

    const result = await complete({ ...BASE, contentHash: null });

    expect((result as { contentHash: string | null }).contentHash).toBeNull();
    expect((result as { path: string }).path).toBe(BASE.path);
    error.mockRestore();
  });
});
