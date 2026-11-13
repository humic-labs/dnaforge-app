import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrimerArtifactOwner } from './primer-artifact-owner';
import { buildPrimerArtifact, serializePrimerArtifact } from './primer-artifact';

const workspaceRoot = '/projects/review-project';
const artifactPath = `${workspaceRoot}/Attached primers/YHIM-EXT-F.primer.json`;

describe('opening an attached primer document', () => {
  const unused = () => {
    throw new Error('Opening a primer called an unrelated mutation dependency');
  };
  const resolveTarget = vi.fn();
  const buildTarget = vi.fn();
  const select = vi.fn();
  let content: string;
  const owner = createPrimerArtifactOwner({
    recovery: {
      findTrashedPrimerDocument: unused,
      readPrimerRegistryRelationships: unused,
      readPrimerRecoveryDocument: unused,
      getLatestPrimerRecoveryInventory: unused,
      refreshPrimerRecoveryInventory: unused,
      persistPrimerRecoveryReport: unused,
      primerRecoverySourceFingerprint: unused,
      primerRecoveryRelationshipsFingerprint: unused,
      recoverPrimerRecordsInWorkspace: unused,
    },
    io: () => ({
      fs: {
        validateWorkspacePath: async () => true,
        readTextFile: async () => content,
        stat: unused,
        readFile: unused,
        exists: unused,
        readDir: unused,
        writeWorkspaceTextFileAtomic: unused,
      },
      lims: {
        readPrimerArtifactRevisionState: async () => ({ state: 'not_enrolled' }),
        repairEntityProjectionFromAudit: unused,
        revisePrimerArtifact: unused,
        resumePrimerArtifactPublication: unused,
      },
      db: { select, execute: unused, replacePrimerProjection: unused },
    }),
    getCatalogFileForPath: async () => null,
    resolveSequenceDocumentById: resolveTarget,
    buildFileDnaSequenceRef: buildTarget,
    archiveLimsEntity: unused,
    buildInlineDnaSequenceRef: unused,
    queryLimsEntities: unused,
    registerLimsEntity: unused,
    restoreLimsEntity: unused,
    updateLimsEntity: unused,
    generateCatalogNumber: unused,
    gitCommitPaths: unused,
    gitStatus: unused,
    isGitRepo: unused,
    cooperateWithRendererInteraction: unused,
    bindCatalogEntityToFile: unused,
    getCatalogEntity: unused,
    markCatalogFileHistorical: unused,
    markCatalogFileMissing: unused,
    releaseMissingCatalogFilePath: unused,
    registerCatalogEntity: unused,
    primerTmCalculationService: {
      createCalculator: unused,
      estimate: unused,
      calculate: unused,
      estimateLegacyLocal: unused,
    },
    withRendererWorkspaceMutation: unused,
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    content = serializePrimerArtifact(
      await buildPrimerArtifact({
        id: 'primer-yhim-ext-f',
        name: 'YHIM-EXT-F',
        catalogNumber: 'CUMATE-EVAL-007',
        sequence: 'ACGTTGCAAGTCCTGATCGA',
        workspaceRoot,
        artifactPath,
        binding: {
          id: 'binding-yhim-genome',
          targetDocumentId: '20ea9012-69ce-4570-b874-21588c5d6cf1',
          targetFilePath: `${workspaceRoot}/Templates/MG1655/MG1655.gb`,
          targetLength: 4641652,
          targetTopology: 'circular',
          targetFileContentHash: `sha256:${'a'.repeat(64)}`,
          targetNormalizedSequenceHash: `sha256:${'b'.repeat(64)}`,
          start: 3000000,
          end: 3000020,
          strand: 1,
        },
        actor: 'fixture',
        source: 'manual',
        now: 1750000000000,
      })
    );
    select.mockResolvedValue([
      {
        id: 'binding-yhim-genome',
        sequence_id: 42,
        document_id: '20ea9012-69ce-4570-b874-21588c5d6cf1',
      },
    ]);
  });

  it('opens saved bases and cached binding identities while template resolution cannot finish', async () => {
    resolveTarget.mockReturnValue(new Promise(() => {}));
    const result = await Promise.race([
      owner.readPrimerArtifactAtPath(artifactPath, workspaceRoot, {
        bindingResolution: 'projected',
      }),
      new Promise((resolve) => setTimeout(() => resolve('blocked on template'), 100)),
    ]);
    expect(result).toMatchObject({
      artifact: { name: 'YHIM-EXT-F', sequence: { bases: 'ACGTTGCAAGTCCTGATCGA' } },
      resolvedBindings: [{ sequenceId: 42, binding: { id: 'binding-yhim-genome' } }],
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(buildTarget).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(expect.stringContaining('primer_bindings'), [
      'primer-yhim-ext-f',
    ]);
  });

  it('does not claim a cached binding attached to a different document', async () => {
    resolveTarget.mockRejectedValue(new Error('Template unavailable'));
    select.mockResolvedValue([
      { id: 'binding-yhim-genome', sequence_id: 42, document_id: 'another-document' },
    ]);
    const read = await owner.readPrimerArtifactAtPath(artifactPath, workspaceRoot, {
      bindingResolution: 'projected',
    });
    expect(read.artifact.bindings).toHaveLength(1);
    expect(read.resolvedBindings).toEqual([]);
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('retains target validation for the default mutation read', async () => {
    resolveTarget.mockRejectedValue(new Error('Template unavailable'));
    await expect(owner.readPrimerArtifactAtPath(artifactPath, workspaceRoot)).rejects.toThrow(
      'Template unavailable'
    );
    expect(resolveTarget).toHaveBeenCalledOnce();
  });

  it('borrows the existing project edit token when resolving an older attached package', async () => {
    resolveTarget.mockRejectedValue(new Error('Stop after target resolution'));
    await expect(
      owner.readPrimerArtifactAtPath(artifactPath, workspaceRoot, {
        mutationToken: 'held-project-edit',
      })
    ).rejects.toThrow('Stop after target resolution');
    expect(resolveTarget).toHaveBeenCalledWith(
      '20ea9012-69ce-4570-b874-21588c5d6cf1',
      [workspaceRoot],
      expect.objectContaining({ mutationToken: 'held-project-edit' })
    );
  });
});
