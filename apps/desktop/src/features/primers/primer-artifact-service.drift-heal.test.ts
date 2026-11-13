import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const validateWorkspacePath = vi.fn(async () => true);
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { validateWorkspacePath } }),
}));

const buildFileDnaSequenceRef = vi.fn();
vi.mock('../lims/dna-sequence', () => ({
  buildFileDnaSequenceRef: (...args: unknown[]) => buildFileDnaSequenceRef(...args),
  buildInlineDnaSequenceRef: vi.fn(),
}));

import { resolvePrimerBindings } from './primer-artifact-service';

const artifactWith = (targets: Array<{ rel: string; length?: number }>): any => ({
  bindings: targets.map((t, i) => ({
    id: `b${i}`,
    relation: 'binds_to_sequence',
    target: {
      workspaceRelativePath: t.rel,
      length: t.length ?? 10,
      topology: 'circular',
      fileContentHash: 'fch',
      normalizedSequenceHash: 'nsh',
    },
    coordinates: { system: 'zero_based_half_open', start: 0, end: 4, strand: 1 },
    source: 'manual',
  })),
});

describe('resolvePrimerBindings drift-heal', () => {
  beforeEach(() => {
    validateWorkspacePath.mockResolvedValue(true);
    buildFileDnaSequenceRef.mockReset();
  });

  it('(a) a missing / moved-away target is SOFT-skipped — no throw, binding dropped', async () => {
    buildFileDnaSequenceRef.mockRejectedValue(new Error('ENOENT: file not found'));
    await expect(
      resolvePrimerBindings(artifactWith([{ rel: 'seqs/target.gb' }]), '/w')
    ).resolves.toEqual([]);
  });

  it('(a) a present-but-unindexed target (sequenceId null) is SOFT-skipped', async () => {
    buildFileDnaSequenceRef.mockResolvedValue({ sequenceId: null });
    await expect(
      resolvePrimerBindings(artifactWith([{ rel: 'seqs/target.gb' }]), '/w')
    ).resolves.toEqual([]);
  });

  it('(b) a resolvable target with matching identity resolves normally', async () => {
    buildFileDnaSequenceRef.mockResolvedValue({
      sequenceId: 42,
      length: 10,
      topology: 'circular',
      fileContentHash: 'fch',
      normalizedSequenceHash: 'nsh',
    });
    const r = await resolvePrimerBindings(artifactWith([{ rel: 'seqs/target.gb' }]), '/w');
    expect(r).toHaveLength(1);
    expect(r[0].sequenceId).toBe(42);
  });

  it('(b) mixed: an unresolvable binding is skipped while a resolvable one is kept', async () => {
    buildFileDnaSequenceRef.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce({
      sequenceId: 7,
      length: 10,
      topology: 'circular',
      fileContentHash: 'fch',
      normalizedSequenceHash: 'nsh',
    });
    const r = await resolvePrimerBindings(
      artifactWith([{ rel: 'seqs/gone.gb' }, { rel: 'seqs/here.gb' }]),
      '/w'
    );
    expect(r.map((x) => x.sequenceId)).toEqual([7]);
  });

  it('(c) a genuine content mismatch STILL throws — identity enforcement is not relaxed', async () => {
    buildFileDnaSequenceRef.mockResolvedValue({
      sequenceId: 42,
      length: 999,
      topology: 'circular',
      fileContentHash: 'fch',
      normalizedSequenceHash: 'nsh',
    });
    await expect(
      resolvePrimerBindings(artifactWith([{ rel: 'seqs/target.gb', length: 10 }]), '/w')
    ).rejects.toThrow(/changed/i);
  });
});
