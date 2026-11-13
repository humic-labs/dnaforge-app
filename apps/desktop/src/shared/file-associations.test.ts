// @vitest-environment node

import {
  FILE_ASSOCIATION_FAMILIES,
  associationFamilyForPath,
  associationPromptReady,
} from './file-associations';

describe(' file association registry', () => {
  it('owns the exact supported family metadata', () => {
    expect(FILE_ASSOCIATION_FAMILIES).toEqual([
      expect.objectContaining({
        id: 'genbank',
        displayName: 'GenBank',
        extensions: ['gb', 'gbk', 'gbff', 'genbank'],
        capability: 'editor',
        promptReady: true,
        macos: expect.objectContaining({ role: 'Editor', rank: 'Alternate' }),
        windows: expect.objectContaining({ progId: 'DNAForge.GenBank' }),
      }),
      expect.objectContaining({
        id: 'snapgene',
        displayName: 'SnapGene DNA',
        extensions: ['dna'],
        capability: 'viewer',
        promptReady: false,
        readinessBlocker: 'format-validation-pending',
        macos: expect.objectContaining({ role: 'Viewer', rank: 'Alternate' }),
        windows: expect.objectContaining({ progId: 'DNAForge.SnapGene' }),
      }),
    ]);
  });

  it('looks up case-insensitive paths and rejects unrelated extensions', () => {
    expect(associationFamilyForPath('/tmp/design.GB')?.id).toBe('genbank');
    expect(associationFamilyForPath('C:\\data\\construct.DNA')?.id).toBe('snapgene');
    expect(associationFamilyForPath('/tmp/design.fasta')).toBeNull();
    expect(associationFamilyForPath('/tmp/.gb')).toBeNull();
  });

  it('keeps automatic prompting behind the checked-in readiness gate', () => {
    expect(associationPromptReady('genbank')).toBe(true);
    expect(associationPromptReady('snapgene')).toBe(false);
  });
});
