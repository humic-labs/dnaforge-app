import { getPrimerOutputSchema } from './design-output-schemas';
import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  addPrimerBindingOutputSchema,
  createPrimerOutputSchema,
  designPrimersOutputSchema,
  listOligoModificationsOutputSchema,
  saveDesignedPrimerOutputSchema,
  updatePrimerBindingOutputSchema,
  updatePrimerOutputSchema,
} from './design-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  assertTargetUnchanged,
  createAddPrimerBindingTool,
  clearPrimerDesignCacheForTests,
  createCreatePrimerTool,
  createDesignPrimersTool,
  createGetPrimerTool,
  createListOligoModificationsTool,
  createSaveDesignedPrimerTool,
  createUpdatePrimerTool,
  createUpdatePrimerBindingTool,
  designPrimersSchema,
  preparePrimerDesignTemplate,
  projectPrimer3Binding,
  type PrimerLifecycleDependencies,
} from './primer-lifecycle';
import { primerCandidateSearchResultSchema } from '../../primers/primer-services';
import {
  PrimerArtifactRevisionError,
  PrimerProjectionError,
  type FileAuthoritativePrimerInput,
  type UpdatePrimerArtifactContentInput,
} from '../../primers/primer-artifact-service';
import type { Primer } from '../../primers/types';
import type { LimsEntity } from '../../../shared/lims';
import { buildPrimerArtifact, serializePrimerArtifact } from '../../primers/public/primer-artifact';
import { configurePrimerTmSchema, configurePrimerTmTool } from './configure-primer-tm';

const targetValidation = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('../../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/public/sequence-document-repository')>()),
  resolveSequenceDocumentById: targetValidation.resolve,
}));
vi.mock('../../lims/public/dna-sequence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lims/public/dna-sequence')>()),
  buildFileDnaSequenceRef: targetValidation.read,
  buildFileDnaSequenceSnapshot: vi.fn(),
}));

const folders: WorkspaceFolder[] = [{ name: 'project', path: '/workspace/project', addedAt: 1 }];

const targetSnapshot = {
  documentId: 'sequence-puc19',
  workspaceRoot: '/workspace/project',
  absolutePath: '/workspace/project/pUC19.gb',
  workspaceRelativePath: 'pUC19.gb',
  sequenceId: 42,
  bases: 'ACGT'.repeat(700),
  length: 2800,
  topology: 'circular' as const,
  fileContentHash: 'file-hash',
  normalizedSequenceHash: 'sequence-hash',
};

const primer3Success = {
  success: true,
  message: 'Found 1 primer pair',
  application: 'pcr' as const,
  primer_pairs: [
    {
      forward: {
        sequence: 'ACGTACGTACGTACGTACGT',
        start: 1200,
        length: 20,
        tm: 60,
        gc_percent: 50,
        any_th: 0,
        end_th: 0,
        hairpin_th: 0,
      },
      reverse: {
        sequence: 'TGCATGCATGCATGCATGCA',
        start: 1569,
        length: 20,
        tm: 61,
        gc_percent: 50,
        any_th: 0,
        end_th: 0,
        hairpin_th: 0,
      },
      product_size: 370,
      pair_any_th: 0,
      pair_end_th: 0,
      penalty: 1.2,
    },
  ],
  warnings: [],
  sequence_length: 2800,
  target_region: [1250, 300] as [number, number],
  params_used: { primer_min_tm: 57, primer_max_tm: 65 },
};

function makeDependencies(
  overrides: Partial<PrimerLifecycleDependencies> = {}
): PrimerLifecycleDependencies {
  return {
    resolveTarget: vi.fn(async () => targetSnapshot),
    assertTargetUnchanged: vi.fn(async () => undefined),
    designPrimers: vi.fn(async () => primer3Success),
    calculateTm: vi.fn(async (sequence, context) => ({
      valueC: sequence.startsWith('A') ? 63.2 : 64.1,
      model: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      source: 'reaction',
      reason: `polymerase=${context.polymerase}`,
      status: 'verified',
      provider: {
        source: 'neb-api',
        tm: sequence.startsWith('A') ? 63.2 : 64.1,
        conc_nM: 500,
        verified: true,
      },
    })),
    savePrimer: vi.fn(),
    updatePrimerContent: vi.fn(),
    getPrimerById: vi.fn(),
    readPrimerArtifact: vi.fn(),
    matchPrimer: vi.fn(),
    attachBinding: vi.fn(),
    updateBinding: vi.fn(),
    getCatalogFile: vi.fn(),
    getLimsEntity: vi.fn(),
    notifyBindingsChanged: vi.fn(),
    listDesigns: vi.fn(() => []),
    ...overrides,
  };
}

describe('primer lifecycle tools', () => {
  beforeEach(() => {
    clearPrimerDesignCacheForTests();
  });

  it('reads a canonical native primer artifact with its detailed MCP contract', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-contract-read',
      catalogNumber: 'P0001',
      name: 'Contract read',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: '/workspace/project',
      artifactPath: '/workspace/project/primers/read.primer.json',
      now: 1,
    });
    const primer = {
      id: artifact.id,
      sequence: artifact.sequence.bases,
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: artifact.file.workspaceRelativePath,
      },
    } as Primer;
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/read.primer.json',
        content: serializePrimerArtifact(artifact),
        artifact,
        resolvedBindings: [],
      })),
      getCatalogFile: vi.fn(async () => null),
      getLimsEntity: vi.fn(async () => null),
    });
    const result = await execDesignContract(
      getPrimerOutputSchema,
      createGetPrimerTool(folders, dependencies),
      { primerId: artifact.id }
    );
    expect(result).toMatchObject({
      ok: true,
      found: true,
      primerId: artifact.id,
      sequence: { bases: artifact.sequence.bases, topology: 'linear', length: 20 },
      registry: { limsEntity: null, catalogFile: null },
    });
  });

  it('retains the owning project of a saved binding in its MCP readback', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-cross-project-contract',
      catalogNumber: 'P0002',
      name: 'Cross-project read',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: '/workspace/project',
      artifactPath: '/workspace/project/primers/cross-project.primer.json',
      now: 1,
    });
    const binding = {
      id: 'binding-cross-project',
      relation: 'binds_to_sequence' as const,
      target: {
        documentId: 'source-document',
        projectId: 'source-project',
        topology: 'linear' as const,
        length: 100,
        fileContentHash: 'source-file-hash',
        normalizedSequenceHash: 'source-sequence-hash',
      },
      coordinates: {
        system: 'zero_based_half_open' as const,
        start: 0,
        end: 20,
        strand: 1 as const,
      },
      source: 'manual' as const,
    };
    artifact.bindings.push(binding);
    const primer = {
      id: artifact.id,
      sequence: artifact.sequence.bases,
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: artifact.file.workspaceRelativePath,
      },
    } as Primer;
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/cross-project.primer.json',
        content: serializePrimerArtifact(artifact),
        artifact,
        resolvedBindings: [{ binding, sequenceId: 42 }],
      })),
      getCatalogFile: vi.fn(async () => null),
      getLimsEntity: vi.fn(async () => null),
    });
    const result = await execDesignContract(
      getPrimerOutputSchema,
      createGetPrimerTool(folders, dependencies),
      { primerId: artifact.id }
    );
    expect(result).toMatchObject({
      ok: true,
      bindings: [{ target: { documentId: 'source-document', projectId: 'source-project' } }],
    });
  });

  it('reports the assembly primers that use a saved oligo', async () => {
    const binding = 'atgagtttatggaaaaaaatcagcctcgg';
    const tail = 'agaggagaaatacta';
    const artifact = await buildPrimerArtifact({
      id: 'primer-assembly-use',
      catalogNumber: 'P0003',
      name: 'F1-fwd',
      sequence: `${tail}${binding}`.toUpperCase(),
      workspaceRoot: '/workspace/project',
      artifactPath: '/workspace/project/primers/assembly-use.primer.json',
      now: 1,
    });
    const primer = {
      id: artifact.id,
      sequence: artifact.sequence.bases,
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: artifact.file.workspaceRelativePath,
      },
    } as Primer;
    const designPrimer = (id: string, direction: 'forward' | 'reverse', sequence: string) => ({
      id,
      name: direction === 'forward' ? 'F1-fwd' : 'F1-rev',
      sequence,
      pbs: { start: 0, end: 29, sequence: sequence.slice(sequence.length - 29) },
      overhang: { length: 15, sequence: sequence.slice(0, sequence.length - 29) },
      direction,
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 58.2,
    });
    const design = {
      topology: 'circular',
      assemblyState: 'ready',
      validationErrors: [],
      proposedPlans: [],
      defaultHomologyLength: 30,
      homologyRegions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      spacers: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
      id: 'design-1',
      name: 'TamB Gibson',
      version: 11,
      assemblyMethod: 'gibson',
      pcrPolymerase: null,
      regions: [
        {
          id: 'insert',
          sourceSequenceId: 'doc-genome',
          sourceSequenceName: 'E. coli K-12',
          sourceStart: 518478,
          sourceEnd: 518558,
          sourceLength: 4641652,
          sourceIsCircular: true,
          sequence: `${binding.toUpperCase()}${'G'.repeat(51)}`,
          annotations: [],
        },
      ],
      designPrimers: [
        {
          fragmentIndex: 0,
          forward: designPrimer('p-f', 'forward', `${tail}${binding}`),
          reverse: designPrimer('p-r', 'reverse', `ttatttgatgcctgg${'c'.repeat(29)}`),
        },
      ],
      savedPrimerLinks: [
        {
          primerId: 'p-f',
          oligoId: artifact.id,
          artifactRevision: artifact.artifactRevision,
          sequenceContentHash: artifact.sequence.contentHash,
          linkedAtDesignVersion: 9,
          linkedAt: '2026-11-10T12:00:00.000Z',
          via: 'matched-existing',
        },
      ],
    } satisfies ReturnType<PrimerLifecycleDependencies['listDesigns']>[number];
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/assembly-use.primer.json',
        content: serializePrimerArtifact(artifact),
        artifact,
        resolvedBindings: [],
      })),
      getCatalogFile: vi.fn(async () => null),
      getLimsEntity: vi.fn(async () => null),
      listDesigns: vi.fn(() => [design]),
    });

    const result = await execDesignContract<{ assemblyUses: unknown[] }>(
      getPrimerOutputSchema,
      createGetPrimerTool(folders, dependencies),
      { primerId: artifact.id }
    );

    expect(result.assemblyUses).toEqual([
      {
        designId: 'design-1',
        designUri: 'waypoint://design/design-1',
        designName: 'TamB Gibson',
        designVersion: 11,
        primerId: 'p-f',
        primerName: 'F1-fwd',
        partNumber: 1,
        direction: 'forward',
        bindingSequence: binding,
        tailSequence: tail,
        tmC: 58.2,
        tm: {
          evaluates: 'binding-part',
          modelLabel: expect.any(String),
          primerConcNm: expect.any(Number),
        },
        sourceSite: {
          documentId: 'doc-genome',
          name: 'E. coli K-12',
          coordinateSystem: 'zero_based_half_open',
          start: 518478,
          end: 518507,
          strand: 1,
          wraps: false,
          sourceLength: 4641652,
          circular: true,
        },
        state: 'current',
        linkedAtDesignVersion: 9,
        linkedArtifactRevision: artifact.artifactRevision,
        sourceAttachment: 'none',
      },
    ]);
  });

  it('keeps candidate selection structurally separate from reported-Tm calculation', async () => {
    expect(configurePrimerTmSchema.safeParse({ model: 'owczarzy' }).success).toBe(true);
    expect(configurePrimerTmTool.description).toContain(
      'does not choose primer sequences or configure Primer3 candidate search'
    );

    const dependencies = makeDependencies();
    const tool = createDesignPrimersTool(folders, dependencies);
    expect(tool.description).toContain(
      'The Tm model changes only the separate calculation reported after Primer3 returns candidates'
    );

    await execDesignContract(
      designPrimersOutputSchema,
      tool,
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        tmModel: 'q5-0',
        numReturn: 1,
      },
      { toolCallId: 'separate-selection-from-tm', messages: [] }
    );

    const primer3Request = vi.mocked(dependencies.designPrimers).mock.calls[0]?.[0];
    expect(primer3Request).not.toHaveProperty('tmModel');
    expect(dependencies.calculateTm).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tmModel: 'q5-0' })
    );
  });

  it('pins reported-Tm provenance into the design identity without forwarding it to Primer3', async () => {
    const dependencies = makeDependencies({
      calculateTm: vi.fn(async (sequence, context) => {
        const local = context.tmModel === 'local';
        const valueC = local ? 58.1 : 72.4;
        return {
          valueC,
          model: local
            ? ({ kind: 'local', algorithm: 'santalucia98' } as const)
            : ({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' } as const),
          source: 'call-override' as const,
          reason: `tmModel=${context.tmModel}`,
          status: local ? ('local' as const) : ('verified' as const),
          provider: local
            ? { source: 'local' as const, tm: valueC, conc_nM: 500, verified: false }
            : {
                source: 'neb-api' as const,
                tm: valueC,
                conc_nM: 500,
                verified: true,
                prodcode: 'q5-0',
                polymerase: 'q5',
              },
        };
      }),
    });
    const tool = createDesignPrimersTool(folders, dependencies);
    const baseInput = {
      path: 'pUC19.gb',
      target: { start: 200, end: 500 },
      application: 'pcr' as const,
      numReturn: 1,
    };

    const local = await execDesignContract(
      designPrimersOutputSchema,
      tool,
      { ...baseInput, tmModel: 'local' },
      { toolCallId: 'local-pin', messages: [] }
    );
    const neb = await execDesignContract(
      designPrimersOutputSchema,
      tool,
      { ...baseInput, tmModel: 'q5-0' },
      { toolCallId: 'neb-pin', messages: [] }
    );

    expect(local.designId).not.toBe(neb.designId);
    expect(local.pairs[0].forward.candidateId).toContain(local.designId);
    expect(neb.pairs[0].forward.candidateId).toContain(neb.designId);
    for (const [request] of vi.mocked(dependencies.designPrimers).mock.calls) {
      expect(request).not.toHaveProperty('tmModel');
    }
  });

  it('normalizes Primer3 reverse coordinates and circular origin-spanning bindings', () => {
    expect(
      projectPrimer3Binding({ start: 219, length: 20 }, 'reverse', {
        topology: 'linear',
        sequenceLength: 1000,
        rotationOffset: 0,
      })
    ).toEqual({ start: 200, end: 220, strand: -1 });

    expect(
      projectPrimer3Binding({ start: 170, length: 20 }, 'forward', {
        topology: 'circular',
        sequenceLength: 2686,
        rotationOffset: 2500,
      })
    ).toEqual({ start: 2670, end: 4, strand: 1 });

    expect(
      projectPrimer3Binding({ start: 980, length: 20 }, 'forward', {
        topology: 'circular',
        sequenceLength: 1000,
        rotationOffset: 0,
      })
    ).toEqual({ start: 980, end: 1000, strand: 1 });
  });

  it('rejects contradictory Primer3 parameter bounds before calling the sidecar', () => {
    const parsed = designPrimersSchema.safeParse({
      path: 'pUC19.gb',
      target: { start: 100, end: 500 },
      parameters: {
        primerMinSize: 25,
        primerOptSize: 20,
        primerMaxSize: 18,
        primerMinTm: 65,
        primerOptTm: 60,
        primerMaxTm: 55,
        primerMinGc: 70,
        primerMaxGc: 40,
        productMinSize: 500,
        productMaxSize: 200,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'parameters.primerOptSize',
          'parameters.primerOptTm',
          'parameters.primerMaxGc',
          'parameters.productMaxSize',
        ])
      );
    }
  });

  it('linearizes an origin-spanning circular target while retaining an invertible coordinate map', () => {
    const bases = 'ACGT'.repeat(100);
    const prepared = preparePrimerDesignTemplate(bases, 'circular', { start: 350, end: 50 });

    expect(prepared.template).toHaveLength(400);
    expect(prepared.targetLength).toBe(100);
    expect(prepared.targetStart).toBeGreaterThan(0);
    expect((prepared.rotationOffset + prepared.targetStart) % bases.length).toBe(350);
    expect(prepared.wrapsOrigin).toBe(true);
  });

  it('centers an origin-adjacent target on a small circular template', () => {
    const bases = 'ACGT'.repeat(100);
    const prepared = preparePrimerDesignTemplate(bases, 'circular', { start: 350, end: 390 });

    expect(prepared).toMatchObject({
      targetStart: 180,
      targetLength: 40,
      rotationOffset: 170,
      wrapsOrigin: false,
    });
    expect(prepared.template).toBe(`${bases.slice(170)}${bases.slice(0, 170)}`);
    expect(
      projectPrimer3Binding({ start: 250, length: 20 }, 'reverse', {
        topology: 'circular',
        sequenceLength: bases.length,
        templateLength: prepared.template.length,
        rotationOffset: prepared.rotationOffset,
      })
    ).toEqual({ start: 1, end: 21, strand: -1 });
  });

  it('bounds a chromosome-scale template to an invertible 50 kb Primer3 window', () => {
    const bases = 'ACGT'.repeat(30_000);
    const prepared = preparePrimerDesignTemplate(bases, 'linear', {
      start: 60_000,
      end: 60_300,
    });

    expect(prepared.template).toHaveLength(50_000);
    expect(prepared.targetStart).toBe(24_850);
    expect(prepared.rotationOffset).toBe(35_150);
    expect(
      projectPrimer3Binding({ start: 100, length: 20 }, 'forward', {
        topology: 'linear',
        sequenceLength: bases.length,
        templateLength: prepared.template.length,
        rotationOffset: prepared.rotationOffset,
      })
    ).toEqual({ start: 35_250, end: 35_270, strand: 1 });
  });

  it('ignores ambiguity codes outside the bounded Primer3 template', () => {
    const bases = `R${'ACGT'.repeat(30_000).slice(1)}`;

    const prepared = preparePrimerDesignTemplate(bases, 'linear', {
      start: 60_000,
      end: 60_300,
    });

    expect(prepared.template).toHaveLength(50_000);
    expect(prepared.template).not.toContain('R');
  });

  it('builds a wrapped chromosome-scale circular window without changing its bases', () => {
    const bases = `${'A'.repeat(60_000)}${'C'.repeat(60_000)}`;
    const prepared = preparePrimerDesignTemplate(bases, 'circular', {
      start: 119_000,
      end: 119_300,
    });

    expect(prepared.template).toHaveLength(50_000);
    expect(prepared.template).toBe(
      bases.slice(prepared.rotationOffset) +
        bases.slice(0, 50_000 - (bases.length - prepared.rotationOffset))
    );
  });

  it('rejects a target too large for the bounded Primer3 window', () => {
    const bases = 'ACGT'.repeat(30_000);

    expect(() =>
      preparePrimerDesignTemplate(bases, 'linear', { start: 1_000, end: 60_000 })
    ).toThrow(/bounded 50000 bp Primer3 window/);
  });

  it('rejects target bases the existing Primer3 endpoint cannot accept', () => {
    const bases = `${'ACGT'.repeat(20)}R`;

    expect(() => preparePrimerDesignTemplate(bases, 'linear', { start: 10, end: 40 })).toThrow(
      /only A, C, G, T, and N template bases/
    );
  });

  it('rejects malformed sidecar design responses at the runtime boundary', () => {
    expect(
      primerCandidateSearchResultSchema.safeParse({
        ...primer3Success,
        primer_pairs: [
          {
            ...primer3Success.primer_pairs[0],
            forward: { ...primer3Success.primer_pairs[0].forward, start: -1 },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects a sidecar design response for a different target region', async () => {
    const dependencies = makeDependencies({
      designPrimers: vi.fn(async () => ({
        ...primer3Success,
        target_region: [201, 300],
      })),
    });

    const result = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, dependencies),
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        numReturn: 1,
      },
      { toolCallId: 'wrong-target', messages: [] }
    );

    expect(result).toMatchObject({
      changed: false,
      code: 'PRIMER_DESIGN_FAILED',
      message: 'Primer3 response target region did not match the bounded request.',
    });
  });

  it('designs through the existing sidecar and returns pinned, normalized candidates with Tm provenance', async () => {
    const dependencies = makeDependencies();
    const tool = createDesignPrimersTool(folders, dependencies);

    const result = await execDesignContract(
      designPrimersOutputSchema,
      tool,
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        polymerase: 'q5',
        numReturn: 1,
      },
      { toolCallId: 'call-1', messages: [] }
    );

    expect(dependencies.designPrimers).toHaveBeenCalledWith(
      expect.objectContaining({
        application: 'pcr',
        target_start: 1250,
        target_length: 300,
        num_return: 1,
      }),
      expect.anything()
    );
    expect(result).toMatchObject({
      designed: true,
      target: {
        sequenceId: 42,
        start: 200,
        end: 500,
        wrapsOrigin: false,
      },
      pairs: [
        {
          rank: 0,
          forward: {
            role: 'forward',
            pbsSequence: 'ACGTACGTACGTACGTACGT',
            overhangSequence: '',
            binding: { start: 150, end: 170, strand: 1 },
            tm: { valueC: 63.2, status: 'verified' },
          },
          reverse: {
            role: 'reverse',
            binding: { start: 500, end: 520, strand: -1 },
          },
        },
      ],
    });
    expect(result.designId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.pairs[0].forward.candidateId).toContain(result.designId);
  });

  it('pins only target identity instead of retaining the chromosome bases', async () => {
    const assertTargetUnchanged = vi.fn(async () => undefined);
    const savePrimer = vi.fn(async () => ({
      artifact: {
        id: 'primer-memory-bounded',
        artifactRevision: 1,
        file: { workspaceRelativePath: 'primers/memory-bounded.primer.json' },
        bindings: [],
      },
      limsEntity: { id: 'primer-memory-bounded' },
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['savePrimer'];
    const dependencies = makeDependencies({ assertTargetUnchanged, savePrimer });
    const design = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, dependencies),
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        numReturn: 1,
      },
      { toolCallId: 'bounded-cache-design', messages: [] }
    );

    await execDesignContract(
      saveDesignedPrimerOutputSchema,
      createSaveDesignedPrimerTool(folders, dependencies),
      {
        designId: design.designId,
        candidateId: design.pairs[0].forward.candidateId,
        name: 'bounded cache',
        artifactPath: 'primers/memory-bounded.primer.json',
      },
      { toolCallId: 'bounded-cache-save', messages: [] }
    );

    expect(assertTargetUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceId: 42, length: targetSnapshot.length })
    );
    expect(assertTargetUnchanged.mock.calls[0]?.[0]).not.toHaveProperty('bases');
  });

  it('keeps a refreshed design pin newer than untouched cache entries', async () => {
    const savePrimer = vi.fn(async () => ({
      artifact: {
        id: 'primer-refreshed-pin',
        artifactRevision: 1,
        file: { workspaceRelativePath: 'primers/refreshed-pin.primer.json' },
        bindings: [],
      },
      limsEntity: { id: 'primer-refreshed-pin' },
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['savePrimer'];
    const dependencies = makeDependencies({ savePrimer });
    const tool = createDesignPrimersTool(folders, dependencies);
    const input = {
      path: 'pUC19.gb',
      target: { start: 200, end: 500 },
      application: 'pcr' as const,
      numReturn: 1,
    };
    const first = await execDesignContract(
      designPrimersOutputSchema,
      tool,
      { ...input, polymerase: 'active-pin' },
      { toolCallId: 'cache-active-first', messages: [] }
    );
    for (let index = 0; index < 31; index++) {
      await execDesignContract(
        designPrimersOutputSchema,
        tool,
        { ...input, polymerase: `untouched-${index}` },
        { toolCallId: `cache-untouched-${index}`, messages: [] }
      );
    }
    const refreshed = await execDesignContract(
      designPrimersOutputSchema,
      tool,
      { ...input, polymerase: 'active-pin' },
      { toolCallId: 'cache-active-refresh', messages: [] }
    );
    expect(refreshed.designId).toBe(first.designId);
    await execDesignContract(
      designPrimersOutputSchema,
      tool,
      { ...input, polymerase: 'overflow-entry' },
      { toolCallId: 'cache-overflow', messages: [] }
    );

    const saved = await execDesignContract(
      saveDesignedPrimerOutputSchema,
      createSaveDesignedPrimerTool(folders, dependencies),
      {
        designId: first.designId,
        candidateId: first.pairs[0].forward.candidateId,
        name: 'refreshed pin',
        artifactPath: 'primers/refreshed-pin.primer.json',
        overhangSequence: '',
      },
      { toolCallId: 'save-refreshed-pin', messages: [] }
    );

    expect(saved).toMatchObject({ saved: true, primerId: 'primer-refreshed-pin' });
  });

  it("stores a 5' tail while keeping annealing Tm pinned to the candidate PBS", async () => {
    const savePrimer = vi.fn(async () => ({
      artifact: {
        id: 'primer-tailed',
        artifactRevision: 1,
        file: { workspaceRelativePath: 'primers/tailed.primer.json' },
        bindings: [],
      },
      limsEntity: { id: 'primer-tailed' },
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['savePrimer'];
    const dependencies = makeDependencies({ savePrimer });
    const design = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, dependencies),
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        numReturn: 1,
      },
      { toolCallId: 'design-tailed-primer', messages: [] }
    );
    const candidate = design.pairs[0].forward;

    await execDesignContract(
      saveDesignedPrimerOutputSchema,
      createSaveDesignedPrimerTool(folders, dependencies),
      {
        designId: design.designId,
        candidateId: candidate.candidateId,
        name: 'tailed primer',
        artifactPath: 'primers/tailed.primer.json',
        overhangSequence: 'GGGG',
      },
      { toolCallId: 'save-tailed-primer', messages: [] }
    );

    expect(savePrimer).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: `GGGG${candidate.pbsSequence}`,
        annealing: { pbsSequence: candidate.pbsSequence, overhangSequence: 'GGGG' },
        designProvenance: expect.objectContaining({
          pbsSequence: candidate.pbsSequence,
          overhangSequence: 'GGGG',
          tm: candidate.tm,
        }),
      })
    );
  });

  it('returns structured no-result and sidecar-failure outcomes', async () => {
    const noResultDependencies = makeDependencies({
      designPrimers: vi.fn(async () => ({
        ...primer3Success,
        success: false,
        message: 'No valid primer pairs',
        primer_pairs: [],
        warnings: ['target too constrained'],
      })),
    });
    const noResult = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, noResultDependencies),
      { path: 'pUC19.gb', target: { start: 200, end: 500 }, numReturn: 1 },
      { toolCallId: 'no-result', messages: [] }
    );
    expect(noResult).toMatchObject({
      designed: false,
      code: 'PRIMER3_NO_RESULT',
      warnings: ['target too constrained'],
    });

    const failedDependencies = makeDependencies({
      designPrimers: vi.fn(async () => {
        throw new Error('sidecar unavailable');
      }),
    });
    const failed = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, failedDependencies),
      { path: 'pUC19.gb', target: { start: 200, end: 500 }, numReturn: 1 },
      { toolCallId: 'sidecar-failure', messages: [] }
    );
    expect(failed).toMatchObject({
      changed: false,
      code: 'PRIMER_DESIGN_FAILED',
      message: 'sidecar unavailable',
    });
  });

  it('propagates cancellation instead of reporting a design failure', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const dependencies = makeDependencies({
      designPrimers: vi.fn(async () => {
        throw abortError;
      }),
    });

    await expect(
      execDesignContract(
        designPrimersOutputSchema,
        createDesignPrimersTool(folders, dependencies),
        { path: 'pUC19.gb', target: { start: 200, end: 500 }, numReturn: 1 },
        { toolCallId: 'cancel-design', messages: [] }
      )
    ).rejects.toBe(abortError);
  });

  it('does not conflate identical sequence files in different workspaces', async () => {
    const first = makeDependencies();
    const second = makeDependencies({
      resolveTarget: vi.fn(async () => ({
        ...targetSnapshot,
        workspaceRoot: '/workspace/other',
        absolutePath: '/workspace/other/pUC19.gb',
      })),
    });
    const input = {
      path: 'pUC19.gb',
      target: { start: 200, end: 500 },
      application: 'pcr' as const,
      numReturn: 1,
    };
    const firstResult = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, first),
      input,
      {
        toolCallId: 'workspace-one',
        messages: [],
      }
    );
    const secondResult = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, second),
      input,
      {
        toolCallId: 'workspace-two',
        messages: [],
      }
    );

    expect(firstResult.designId).not.toBe(secondResult.designId);
  });

  it('returns a structured artifact-write failure for a pinned candidate', async () => {
    const dependencies = makeDependencies({
      savePrimer: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const design = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, dependencies),
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        numReturn: 1,
      },
      { toolCallId: 'design-for-save', messages: [] }
    );
    const candidateId = design.pairs[0].forward.candidateId;

    const saved = await execDesignContract(
      saveDesignedPrimerOutputSchema,
      createSaveDesignedPrimerTool(folders, dependencies),
      {
        designId: design.designId,
        candidateId,
        name: 'pUC19 F',
        artifactPath: 'primers/pUC19-f.primer.json',
        overhangSequence: '',
      },
      { toolCallId: 'save-failure', messages: [] }
    );

    expect(saved).toMatchObject({
      changed: false,
      code: 'PRIMER_MUTATION_FAILED',
      message: 'disk full',
    });
  });

  it('refuses to save a pin after its owning workspace is no longer open', async () => {
    const dependencies = makeDependencies();
    const design = await execDesignContract(
      designPrimersOutputSchema,
      createDesignPrimersTool(folders, dependencies),
      {
        path: 'pUC19.gb',
        target: { start: 200, end: 500 },
        application: 'pcr',
        numReturn: 1,
      },
      { toolCallId: 'design-before-close', messages: [] }
    );

    const saved = await execDesignContract(
      saveDesignedPrimerOutputSchema,
      createSaveDesignedPrimerTool([], dependencies),
      {
        designId: design.designId,
        candidateId: design.pairs[0].forward.candidateId,
        name: 'pUC19 F',
        artifactPath: 'primers/pUC19-f.primer.json',
        overhangSequence: '',
      },
      { toolCallId: 'save-after-close', messages: [] }
    );

    expect(saved).toMatchObject({
      changed: false,
      code: 'PRIMER_DESIGN_WORKSPACE_CLOSED',
    });
    expect(dependencies.savePrimer).not.toHaveBeenCalled();
  });

  it('returns matcher alternatives without mutating an unconfirmed binding site', async () => {
    const primer = {
      id: 'primer-1',
      sequence: 'ACGTACGTACGTACGTACGT',
      originDetails: { authority: 'primer_artifact', artifactPath: 'primers/p.primer.json' },
    } as Primer;
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/p.primer.json',
        content: '{}',
        artifact: {
          sequence: { bases: primer.sequence },
          bindings: [],
        },
        resolvedBindings: [],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: vi.fn(async () => [
        {
          start: 120,
          end: 140,
          strand: 1,
          identity: 0.95,
          edit_distance: 1,
          mismatch_positions: [5],
          three_prime_match_length: 14,
          effective_tm: 51.2,
        },
      ]),
    });

    const result = await execDesignContract(
      addPrimerBindingOutputSchema,
      createAddPrimerBindingTool(folders, dependencies),
      {
        primerId: primer.id,
        targetDocumentId: 'plasmid-document',
        start: 121,
        end: 140,
        strand: 1,
        expectedArtifactRevision: 1,
        maxMismatches: 3,
        validationMode: 'confirmed',
      },
      { toolCallId: 'unconfirmed-site', messages: [] }
    );

    expect(result).toMatchObject({
      changed: false,
      code: 'PRIMER_BINDING_SITE_NOT_FOUND',
      coordinateSystem: 'zero_based_half_open',
      availableHits: [{ start: 120, end: 140, editDistance: 1 }],
    });
    expect(dependencies.attachBinding).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 44, false, true],
    [
      { pbsSequence: 'ATGAGTTTATGGAAAAAAATCAGCCTCGG', overhangSequence: 'AGAGGAGAAATACTA' },
      29,
      true,
      false,
    ],
  ])(
    'says how much of a tailed oligo was searched when a confirmed site is refused',
    async (annealing, searchedSequenceLength, bindingSplitRecorded, hinted) => {
      const primer = {
        id: 'primer-tailed',
        sequence: 'AGAGGAGAAATACTAATGAGTTTATGGAAAAAAATCAGCCTCGG',
        originDetails: { authority: 'primer_artifact', artifactPath: 'primers/t.primer.json' },
      } as Primer;
      const dependencies = makeDependencies({
        getPrimerById: vi.fn(async () => primer),
        readPrimerArtifact: vi.fn(async () => ({
          path: '/workspace/project/primers/t.primer.json',
          content: '{}',
          artifact: { sequence: { bases: primer.sequence }, annealing, bindings: [] },
          resolvedBindings: [],
        })) as PrimerLifecycleDependencies['readPrimerArtifact'],
        matchPrimer: vi.fn(async () => []),
      });

      const result = await execDesignContract<{ hint?: string }>(
        addPrimerBindingOutputSchema,
        createAddPrimerBindingTool(folders, dependencies),
        {
          primerId: primer.id,
          targetDocumentId: 'plasmid-document',
          start: 100,
          end: 129,
          strand: 1,
          expectedArtifactRevision: 1,
          maxMismatches: 0,
          validationMode: 'confirmed',
        },
        { toolCallId: 'tailed-site', messages: [] }
      );

      expect(result).toMatchObject({
        ok: false,
        code: 'PRIMER_BINDING_SITE_NOT_FOUND',
        stateChanged: false,
        searchedSequenceLength,
        bindingSplitRecorded,
        details: { searchedSequenceLength, bindingSplitRecorded },
      });
      expect(dependencies.matchPrimer).toHaveBeenCalledWith(
        primer.sequence.slice(primer.sequence.length - searchedSequenceLength),
        expect.anything(),
        0,
        expect.anything()
      );
      if (hinted) {
        expect(result.hint).toContain('whole oligo');
        expect(result.hint).toContain('update_primer annealingLength');
        expect(result.hint).toContain('save_design_primers');
      } else expect(result.hint).toBeUndefined();
      expect(dependencies.attachBinding).not.toHaveBeenCalled();
    }
  );

  it('validates a chromosome-scale linear binding through a bounded coordinate-mapped window', async () => {
    const primer = {
      id: 'primer-linear-large',
      sequence: 'A'.repeat(20),
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: 'primers/linear-large.primer.json',
      },
    } as Primer;
    const length = 3_000_000;
    const start = 1_500_000;
    const matchPrimer = vi.fn(async (_primer: string, target: typeof targetSnapshot) => {
      expect(target.bases).toHaveLength(50_000);
      expect(target.length).toBe(50_000);
      expect(target.topology).toBe('linear');
      return [
        {
          start: 24_990,
          end: 25_010,
          strand: 1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [],
          three_prime_match_length: 20,
          effective_tm: 60,
        },
      ];
    });
    const attachBinding = vi.fn(
      async (input: Parameters<PrimerLifecycleDependencies['attachBinding']>[0]) => ({
        artifact: {
          id: primer.id,
          artifactRevision: 2,
          bindings: [
            {
              id: 'binding-linear-large',
              relation: 'binds_to_sequence' as const,
              target: {
                documentId: input.targetDocumentId,
                topology: 'linear' as const,
                length,
                fileContentHash: targetSnapshot.fileContentHash,
                normalizedSequenceHash: targetSnapshot.normalizedSequenceHash,
              },
              coordinates: {
                system: 'zero_based_half_open' as const,
                start,
                end: start + 20,
                strand: 1 as const,
              },
              source: input.source,
              alignment: input.alignment,
            },
          ],
        },
        bindingMutation: 'added' as const,
        bindingId: 'binding-linear-large',
        gitCommitted: true,
      })
    );
    const dependencies = makeDependencies({
      resolveTarget: vi.fn(async () => ({
        ...targetSnapshot,
        bases: 'A'.repeat(length),
        length,
        topology: 'linear' as const,
      })),
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/linear-large.primer.json',
        content: '{}',
        artifact: { sequence: { bases: primer.sequence }, bindings: [] },
        resolvedBindings: [],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: matchPrimer as PrimerLifecycleDependencies['matchPrimer'],
      attachBinding: attachBinding as PrimerLifecycleDependencies['attachBinding'],
    });

    const result = await execDesignContract(
      addPrimerBindingOutputSchema,
      createAddPrimerBindingTool(folders, dependencies),
      {
        primerId: primer.id,
        targetDocumentId: 'sequence-linear-chromosome',
        start,
        end: start + 20,
        strand: 1,
        expectedArtifactRevision: 1,
        maxMismatches: 0,
      },
      { toolCallId: 'bounded-linear-binding', messages: [] }
    );

    expect(result).toMatchObject({ changed: true, bindingId: 'binding-linear-large' });
    expect(attachBinding).toHaveBeenCalledWith(
      expect.objectContaining({ bindingStart: start, bindingEnd: start + 20, bindingStrand: 1 })
    );
  });

  it('maps an origin-spanning circular binding out of a bounded linear matcher window', async () => {
    const primer = {
      id: 'primer-circular-large',
      sequence: 'A'.repeat(20),
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: 'primers/circular-large.primer.json',
      },
    } as Primer;
    const length = 3_000_000;
    const start = length - 10;
    const matchPrimer = vi.fn(async (_primer: string, target: typeof targetSnapshot) => {
      expect(target.bases).toHaveLength(50_000);
      expect(target.length).toBe(50_000);
      expect(target.topology).toBe('linear');
      return [
        {
          start: 24_990,
          end: 25_010,
          strand: -1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [],
          three_prime_match_length: 20,
          effective_tm: 60,
        },
      ];
    });
    const attachBinding = vi.fn(
      async (input: Parameters<PrimerLifecycleDependencies['attachBinding']>[0]) => ({
        artifact: {
          id: primer.id,
          artifactRevision: 2,
          bindings: [
            {
              id: 'binding-circular-large',
              relation: 'binds_to_sequence' as const,
              target: {
                documentId: input.targetDocumentId,
                topology: 'circular' as const,
                length,
                fileContentHash: targetSnapshot.fileContentHash,
                normalizedSequenceHash: targetSnapshot.normalizedSequenceHash,
              },
              coordinates: {
                system: 'zero_based_half_open' as const,
                start,
                end: 10,
                strand: -1 as const,
              },
              source: input.source,
              alignment: input.alignment,
            },
          ],
        },
        bindingMutation: 'added' as const,
        bindingId: 'binding-circular-large',
        gitCommitted: true,
      })
    );
    const dependencies = makeDependencies({
      resolveTarget: vi.fn(async () => ({
        ...targetSnapshot,
        bases: 'A'.repeat(length),
        length,
        topology: 'circular' as const,
      })),
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/circular-large.primer.json',
        content: '{}',
        artifact: { sequence: { bases: primer.sequence }, bindings: [] },
        resolvedBindings: [],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: matchPrimer as PrimerLifecycleDependencies['matchPrimer'],
      attachBinding: attachBinding as PrimerLifecycleDependencies['attachBinding'],
    });

    const result = await execDesignContract(
      addPrimerBindingOutputSchema,
      createAddPrimerBindingTool(folders, dependencies),
      {
        primerId: primer.id,
        targetDocumentId: 'sequence-circular-chromosome',
        start,
        end: 10,
        strand: -1,
        expectedArtifactRevision: 1,
        maxMismatches: 0,
      },
      { toolCallId: 'bounded-circular-binding', messages: [] }
    );

    expect(result).toMatchObject({ changed: true, bindingId: 'binding-circular-large' });
    expect(attachBinding).toHaveBeenCalledWith(
      expect.objectContaining({ bindingStart: start, bindingEnd: 10, bindingStrand: -1 })
    );
  });

  it('preserves stale-revision detail and registry-recovery instructions', async () => {
    const primer = {
      id: 'primer-1',
      sequence: 'ACGTACGTACGTACGTACGT',
      originDetails: { authority: 'primer_artifact', artifactPath: 'primers/p.primer.json' },
    } as Primer;
    const base = {
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/p.primer.json',
        content: '{}',
        artifact: { sequence: { bases: primer.sequence }, bindings: [] },
        resolvedBindings: [],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: vi.fn(async () => [
        {
          start: 100,
          end: 120,
          strand: 1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [],
          three_prime_match_length: 20,
          effective_tm: 60,
        },
      ]),
    };
    const input = {
      primerId: primer.id,
      bindingId: 'binding-1',
      targetPath: 'pUC19.gb',
      start: 100,
      end: 120,
      strand: 1 as const,
      expectedArtifactRevision: 1,
      maxMismatches: 3,
    };
    const staleDependencies = makeDependencies({
      ...base,
      updateBinding: vi.fn(async () => {
        throw new PrimerArtifactRevisionError(1, 2);
      }),
    });
    const stale = await execDesignContract(
      updatePrimerBindingOutputSchema,
      createUpdatePrimerBindingTool(folders, staleDependencies),
      input,
      {
        toolCallId: 'stale-update',
        messages: [],
      }
    );
    expect(stale).toMatchObject({
      changed: false,
      code: 'PRIMER_ARTIFACT_REVISION_STALE',
      expectedArtifactRevision: 1,
      actualArtifactRevision: 2,
    });

    const projectionDependencies = makeDependencies({
      ...base,
      updateBinding: vi.fn(async () => {
        throw new PrimerProjectionError('/workspace/project/primers/p.primer.json', 'db down');
      }),
    });
    const projection = await execDesignContract(
      updatePrimerBindingOutputSchema,
      createUpdatePrimerBindingTool(folders, projectionDependencies),
      input,
      { toolCallId: 'projection-failure', messages: [] }
    );
    expect(projection).toMatchObject({
      changed: false,
      code: 'PRIMER_REGISTRY_RECONCILIATION_REQUIRED',
      recoveryRequired: true,
      artifactPath: '/workspace/project/primers/p.primer.json',
    });
  });

  it('refreshes both sequence drawers when a binding moves between targets', async () => {
    const primer = {
      id: 'primer-1',
      sequence: 'ACGTACGTACGTACGTACGT',
      originDetails: { authority: 'primer_artifact', artifactPath: 'primers/p.primer.json' },
    } as Primer;
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/p.primer.json',
        content: '{}',
        artifact: {
          sequence: { bases: primer.sequence },
          bindings: [{ id: 'binding-1' }],
        },
        resolvedBindings: [{ binding: { id: 'binding-1' }, sequenceId: 7 }],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: vi.fn(async () => [
        {
          start: 100,
          end: 120,
          strand: 1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [],
          three_prime_match_length: 20,
          effective_tm: 60,
        },
      ]),
      updateBinding: vi.fn(async () => ({
        artifact: {
          id: primer.id,
          artifactRevision: 2,
          bindings: [{ id: 'binding-1' }],
        },
        bindingMutation: 'updated',
        bindingId: 'binding-1',
        gitCommitted: true,
      })) as PrimerLifecycleDependencies['updateBinding'],
    });

    await execDesignContract(
      updatePrimerBindingOutputSchema,
      createUpdatePrimerBindingTool(folders, dependencies),
      {
        primerId: primer.id,
        bindingId: 'binding-1',
        targetPath: 'pUC19.gb',
        start: 100,
        end: 120,
        strand: 1,
        expectedArtifactRevision: 1,
        maxMismatches: 0,
      },
      { toolCallId: 'move-binding', messages: [] }
    );

    expect(dependencies.notifyBindingsChanged).toHaveBeenNthCalledWith(1, 42);
    expect(dependencies.notifyBindingsChanged).toHaveBeenNthCalledWith(2, 7);
  });

  it('rejects malformed matcher evidence before artifact mutation', async () => {
    const primer = {
      id: 'primer-1',
      sequence: 'ACGTACGTACGTACGTACGT',
      originDetails: { authority: 'primer_artifact', artifactPath: 'primers/p.primer.json' },
    } as Primer;
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact: vi.fn(async () => ({
        path: '/workspace/project/primers/p.primer.json',
        content: '{}',
        artifact: { sequence: { bases: primer.sequence }, bindings: [] },
        resolvedBindings: [],
      })) as PrimerLifecycleDependencies['readPrimerArtifact'],
      matchPrimer: vi.fn(async () => [
        {
          start: 100,
          end: 120,
          strand: 1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [25],
          three_prime_match_length: 21,
          effective_tm: 60,
        },
      ]),
    });

    const result = await execDesignContract(
      addPrimerBindingOutputSchema,
      createAddPrimerBindingTool(folders, dependencies),
      {
        primerId: primer.id,
        targetPath: 'pUC19.gb',
        start: 100,
        end: 120,
        strand: 1,
        expectedArtifactRevision: 1,
        maxMismatches: 3,
      },
      { toolCallId: 'malformed-matcher', messages: [] }
    );

    expect(result).toMatchObject({
      changed: false,
      code: 'PRIMER_MUTATION_FAILED',
    });
    expect(String(result.message)).toMatch(/invalid mismatch evidence/);
    expect(dependencies.attachBinding).not.toHaveBeenCalled();
  });

  it('lets agents discover only placement-valid vendor modification definitions', async () => {
    const result = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', orderType: 'dna', placement: 'three-prime', query: 'spacer' },
      { toolCallId: 'list-three-prime-spacers', messages: [] }
    );

    expect(result).toMatchObject({
      vendor: 'idt',
      orderType: 'dna',
      count: 5,
      catalogEntryCount: 260,
      catalogRetrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      catalogSourceUrl: expect.stringContaining('GetAllMods'),
      constraints: expect.arrayContaining([
        expect.objectContaining({
          id: 'idt-dtpa-documented-adjacent-series',
          enforcement: 'informational',
          maximumDocumented: 3,
          sourceUrl: expect.stringContaining('idtdna.com'),
        }),
        expect.objectContaining({
          id: 'idt-terminal-biotin-spacer18-max-consecutive',
          enforcement: 'hard',
          maximum: 3,
          sourceUrl: expect.stringContaining('idtdna.com'),
        }),
      ]),
    });
    expect(result.modifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: '3Sp18',
          placement: 'three-prime',
          productUrl: expect.stringContaining('/1170'),
        }),
        expect.objectContaining({ code: '3SpC3', placement: 'three-prime' }),
      ])
    );
    for (const modification of result.modifications) {
      expect(Object.keys(modification)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(?:description|structure)/)])
      );
    }
    expect(result.modifications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'iSp18' })])
    );

    const dnaOnly = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', orderType: 'dna', query: '55HydMe-dC' },
      { toolCallId: 'list-dna-only-modification', messages: [] }
    );
    const excludedFromRna = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', orderType: 'rna', query: '55HydMe-dC' },
      { toolCallId: 'exclude-dna-only-modification', messages: [] }
    );
    expect(dnaOnly.modifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: '55HydMe-dC', supportedOrderTypes: ['dna'] }),
      ])
    );
    expect(excludedFromRna).toMatchObject({ orderType: 'rna', count: 0, modifications: [] });

    const dnaFluoroU = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', orderType: 'dna', query: 'i2FU' },
      { toolCallId: 'list-dna-fluoro-u', messages: [] }
    );
    const rnaFluoroU = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', orderType: 'rna', query: 'i2FU' },
      { toolCallId: 'list-rna-fluoro-u', messages: [] }
    );
    expect(dnaFluoroU.modifications).toEqual([
      expect.objectContaining({ code: 'i2FU', naturalBase: 'T' }),
    ]);
    expect(rnaFluoroU.modifications).toEqual([
      expect.objectContaining({ code: 'i2FU', naturalBase: 'U' }),
    ]);

    const uncommon = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', query: 'iSuper-dG' },
      { toolCallId: 'list-uncommon-idt-modification', messages: [] }
    );
    expect(uncommon).toMatchObject({
      count: 1,
      modifications: [
        expect.objectContaining({
          code: 'iSuper-dG',
          naturalBase: 'G',
        }),
      ],
    });

    const affinityPlus = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', placement: 'five-prime', query: 'Affinity Plus' },
      { toolCallId: 'list-affinity-plus', messages: [] }
    );
    expect(affinityPlus).toMatchObject({
      count: 4,
      modifications: expect.arrayContaining([
        expect.objectContaining({
          code: '+A',
          token: '+A',
          categoryLabel: 'Modified Bases',
          categoryLabels: ['Modified Bases'],
          allowedPlacements: ['five-prime', 'internal', 'three-prime'],
        }),
      ]),
    });

    const clickChemistry = await execDesignContract(
      listOligoModificationsOutputSchema,
      createListOligoModificationsTool(),
      { vendor: 'idt', query: '5Hexynyl' },
      { toolCallId: 'list-click-chemistry', messages: [] }
    );
    expect(clickChemistry).toMatchObject({
      count: 1,
      modifications: [
        expect.objectContaining({
          code: '5Hexynyl',
          categoryLabel: 'Attachment Chemistry / Linkers',
          categoryLabels: ['Attachment Chemistry / Linkers', 'Click Chemistry'],
        }),
      ],
    });
  });

  it('creates a primer from exact IDT notation through the authoritative artifact service', async () => {
    const notation = '/5Phos/aC/iBiodT/g/3SpC3/';
    const savePrimer = vi.fn(async (input: FileAuthoritativePrimerInput) => ({
      artifactPath: input.artifactPath,
      artifact: {
        id: 'primer-agent-created',
        artifactRevision: 1,
        name: input.name,
        sequence: {
          bases: input.sequence,
          topology: 'linear',
          length: input.sequence.length,
          contentHash: 'test-sequence-hash',
        },
        oligo: input.oligo,
        file: { workspaceRelativePath: 'primers/agent-created.primer.json' },
        bindings: [],
      },
      limsEntity: { id: 'primer-agent-created' },
      primer: { id: 'primer-agent-created' },
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['savePrimer'];
    const dependencies = makeDependencies({ savePrimer });

    const result = await execDesignContract(
      createPrimerOutputSchema,
      createCreatePrimerTool(folders, dependencies),
      {
        name: 'agent created',
        artifactPath: 'primers/agent-created.primer.json',
        oligo: { vendor: 'idt', notation },
      },
      { toolCallId: 'create-modified-primer', messages: [] }
    );

    expect(savePrimer).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: 'aCTg',
        actor: 'agent',
        oligo: expect.objectContaining({ vendor: 'idt', notation }),
      })
    );
    expect(result).toMatchObject({
      changed: true,
      primerId: 'primer-agent-created',
      idtNotation: notation,
    });
  });

  it('creates an RNA oligo from exact IDT notation and preserves its order type', async () => {
    const notation = '/5Phos/rArCmGrU/3SpC3/';
    const savePrimer = vi.fn(async (input: FileAuthoritativePrimerInput) => ({
      artifactPath: input.artifactPath,
      artifact: {
        id: 'rna-oligo-agent-created',
        artifactRevision: 1,
        name: input.name,
        sequence: {
          bases: input.sequence,
          topology: 'linear',
          length: input.sequence.length,
          contentHash: 'test-sequence-hash',
        },
        oligo: input.oligo,
        file: { workspaceRelativePath: 'primers/rna-agent-created.primer.json' },
        bindings: [],
      },
      limsEntity: { id: 'rna-oligo-agent-created' },
      primer: { id: 'rna-oligo-agent-created' },
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['savePrimer'];
    const dependencies = makeDependencies({ savePrimer });

    const result = await execDesignContract(
      createPrimerOutputSchema,
      createCreatePrimerTool(folders, dependencies),
      {
        name: 'agent RNA oligo',
        artifactPath: 'primers/rna-agent-created.primer.json',
        oligo: { vendor: 'idt', orderType: 'rna', notation },
      },
      { toolCallId: 'create-rna-oligo', messages: [] }
    );

    expect(savePrimer).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: 'ACGU',
        actor: 'agent',
        oligo: expect.objectContaining({ vendor: 'idt', orderType: 'rna', notation }),
      })
    );
    expect(result).toMatchObject({
      changed: true,
      primerId: 'rna-oligo-agent-created',
      idtNotation: notation,
      oligo: expect.objectContaining({ orderType: 'rna' }),
    });
  });

  it('defaults agent oligos to DNA and rejects RNA notation without an RNA order type', async () => {
    const dependencies = makeDependencies();

    const result = await execDesignContract(
      createPrimerOutputSchema,
      createCreatePrimerTool(folders, dependencies),
      {
        name: 'ambiguous oligo',
        artifactPath: 'primers/ambiguous.primer.json',
        oligo: { vendor: 'idt', notation: 'rArCrGrU' },
      },
      { toolCallId: 'reject-rna-without-order-type', messages: [] }
    );

    expect(result).toMatchObject({ changed: false, code: 'PRIMER_MUTATION_FAILED' });
    expect(dependencies.savePrimer).not.toHaveBeenCalled();
  });

  it('removes meaningless workspace arguments when exactly one workspace is open', () => {
    const oneWorkspaceSchemas = [
      {
        schema: createCreatePrimerTool(folders).inputSchema as z.ZodType<unknown>,
        input: {
          name: 'agent created',
          artifactPath: 'primers/agent-created.primer.json',
          workspace: 'invented',
          oligo: { vendor: 'idt', notation: '/5Phos/ACGT/3SpC3/' },
        },
      },
      {
        schema: createGetPrimerTool(folders).inputSchema as z.ZodType<unknown>,
        input: { primerId: 'primer-1', workspace: 'invented' },
      },
      {
        schema: createUpdatePrimerTool(folders).inputSchema as z.ZodType<unknown>,
        input: {
          primerId: 'primer-1',
          expectedArtifactRevision: 1,
          workspace: 'invented',
          name: 'renamed',
        },
      },
    ];
    for (const { schema, input } of oneWorkspaceSchemas) {
      expect(schema.safeParse(input).success).toBe(false);
    }

    const multipleFolders = [...folders, { name: 'other', path: '/workspace/other', addedAt: 2 }];
    const multiWorkspaceSchema = createCreatePrimerTool(multipleFolders)
      .inputSchema as z.ZodType<unknown>;
    expect(
      multiWorkspaceSchema.safeParse({
        name: 'agent created',
        artifactPath: 'primers/agent-created.primer.json',
        workspace: 'other',
        oligo: { vendor: 'idt', notation: '/5Phos/ACGT/3SpC3/' },
      }).success
    ).toBe(true);
  });

  it('rejects an agent-authored IDT token in the wrong position before any write', async () => {
    const dependencies = makeDependencies();

    const result = await execDesignContract(
      createPrimerOutputSchema,
      createCreatePrimerTool(folders, dependencies),
      {
        name: 'invalid placement',
        artifactPath: 'primers/invalid.primer.json',
        oligo: { vendor: 'idt', notation: 'ACGT/5Phos/' },
      },
      { toolCallId: 'reject-invalid-modification', messages: [] }
    );

    expect(result).toMatchObject({
      changed: false,
      code: 'PRIMER_MUTATION_FAILED',
    });
    expect(String(result.message)).toContain('can only be used at the 5′ end');
    expect(dependencies.savePrimer).not.toHaveBeenCalled();
  });

  it('updates attached primer chemistry without repeated binding-impact confirmation', async () => {
    const primer = {
      id: 'primer-agent-update',
      sequence: 'ACGT',
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: 'primers/agent-update.primer.json',
      },
    } as Primer;
    const binding = {
      id: 'binding-1',
      relation: 'binds_to_sequence' as const,
      target: {
        documentId: 'sequence-template',
        topology: 'linear' as const,
        length: 2_800,
        fileContentHash: 'template-file-hash',
        normalizedSequenceHash: 'template-sequence-hash',
      },
      coordinates: {
        system: 'zero_based_half_open' as const,
        start: 100,
        end: 120,
        strand: 1 as const,
      },
      source: 'manual' as const,
    };
    const artifact = {
      id: primer.id,
      artifactRevision: 4,
      name: 'agent update',
      sequence: { bases: 'ACGT' },
      metadata: { notes: 'keep me' },
      file: { workspaceRelativePath: 'primers/agent-update.primer.json' },
      bindings: [binding],
    };
    const readPrimerArtifact = vi.fn(async () => ({
      path: '/workspace/project/primers/agent-update.primer.json',
      content: '{}',
      artifact,
      resolvedBindings: [{ binding, sequenceId: 42 }],
    })) as unknown as PrimerLifecycleDependencies['readPrimerArtifact'];
    const updatedNotation = '/5Phos/ACGT/3SpC3/';
    const updatePrimerContent = vi.fn(async (input: UpdatePrimerArtifactContentInput) => ({
      artifactPath: input.artifactPath,
      artifact: {
        ...artifact,
        artifactRevision: 5,
        sequence: {
          bases: input.sequence,
          topology: 'linear',
          length: input.sequence.length,
          contentHash: 'test-sequence-hash',
        },
        oligo: input.oligo ?? undefined,
      },
      limsEntity: { id: primer.id },
      primer,
      gitCommitted: true,
    })) as unknown as PrimerLifecycleDependencies['updatePrimerContent'];
    const dependencies = makeDependencies({
      getPrimerById: vi.fn(async () => primer),
      readPrimerArtifact,
      updatePrimerContent,
    });
    const tool = createUpdatePrimerTool(folders, dependencies);
    const baseInput = {
      primerId: primer.id,
      expectedArtifactRevision: 4,
      oligo: { vendor: 'idt' as const, notation: updatedNotation },
    };

    const updated = await execDesignContract(updatePrimerOutputSchema, tool, baseInput, {
      toolCallId: 'update-without-impact-confirmation',
      messages: [],
    });
    expect(updatePrimerContent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedArtifactRevision: 4,
        actor: 'agent',
        sequence: 'ACGT',
        oligo: expect.objectContaining({ notation: updatedNotation }),
      })
    );
    expect(updated).toMatchObject({
      changed: true,
      artifactRevision: 5,
      idtNotation: updatedNotation,
    });
  });

  it.each([false, true])(
    'saves exact notation and truthful provenance when a candidate is edited: %s',
    async (edited) => {
      const savePrimer = vi.fn(async (input: FileAuthoritativePrimerInput) => ({
        artifactPath: input.artifactPath,
        artifact: {
          id: 'primer-designed-modified',
          artifactRevision: 1,
          name: input.name,
          sequence: { bases: input.sequence },
          oligo: input.oligo,
          file: { workspaceRelativePath: 'primers/designed-modified.primer.json' },
          bindings: [],
        },
        limsEntity: { id: 'primer-designed-modified' },
        primer: { id: 'primer-designed-modified' },
        gitCommitted: true,
      })) as unknown as PrimerLifecycleDependencies['savePrimer'];
      const dependencies = makeDependencies({ savePrimer });
      const design = await createDesignPrimersTool(folders, dependencies).execute?.(
        {
          path: 'pUC19.gb',
          target: { start: 200, end: 500 },
          application: 'pcr',
          numReturn: 1,
        },
        { toolCallId: 'design-before-modified-save', messages: [] }
      );
      const candidate = design.pairs[0].forward;
      const sequence = edited ? 'TTTTTTT' : candidate.pbsSequence;
      const notation = `/5Phos/${sequence}/3SpC3/`;

      const saved = await createSaveDesignedPrimerTool(folders, dependencies).execute?.(
        {
          designId: design.designId,
          candidateId: candidate.candidateId,
          name: 'designed modified',
          artifactPath: 'primers/designed-modified.primer.json',
          oligo: { vendor: 'idt', notation },
        },
        { toolCallId: 'save-designed-modified', messages: [] }
      );

      expect(savePrimer).toHaveBeenCalledWith(
        expect.objectContaining({
          sequence,
          oligo: expect.objectContaining({ notation }),
          artifactSource: edited ? 'manual' : 'agent-design',
          designProvenance: edited
            ? undefined
            : expect.objectContaining({ candidateId: candidate.candidateId }),
        })
      );
      expect(saved).toMatchObject({ idtNotation: notation, candidateEdited: edited });
    }
  );

  it.each(['auto', 'manual'] as const)(
    'saves an intentional unconfirmed binding with %s validation',
    async (validationMode) => {
      const primer: Primer = {
        id: 'manual-primer',
        catalogNumber: 'PR-000001',
        name: 'Manual',
        sequence: 'TTTTTTT',
        length: 7,
        tm: null,
        gcPercent: 0,
        origin: 'manual',
        originDetails: null,
        status: 'designed',
        vendor: null,
        orderDate: null,
        application: null,
        scale: null,
        purification: null,
        modifications: null,
        stockLocation: null,
        concentration: null,
        notes: null,
        workspaceId: null,
        createdAt: 1,
        updatedAt: 1,
      };
      const artifactPath = '/workspace/project/primers/manual.primer.json';
      const artifact = await buildPrimerArtifact({
        id: primer.id,
        catalogNumber: primer.catalogNumber,
        name: primer.name,
        sequence: primer.sequence,
        workspaceRoot: targetSnapshot.workspaceRoot,
        artifactPath,
        source: 'manual',
      });
      const limsEntity: LimsEntity = {
        id: primer.id,
        kind: 'oligo',
        schemaId: null,
        schemaRevisionId: 'primer-schema',
        name: primer.name,
        registryId: primer.catalogNumber,
        fields: {},
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: null,
        actor: 'agent',
        eventSeq: null,
        tombstone: false,
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      };
      const dependencies = makeDependencies({
        getPrimerById: vi.fn(async () => primer),
        readPrimerArtifact: vi.fn<PrimerLifecycleDependencies['readPrimerArtifact']>(async () => ({
          path: artifactPath,
          content: serializePrimerArtifact(artifact),
          artifact,
          resolvedBindings: [],
        })),
        matchPrimer: vi.fn(async () => []),
        attachBinding: vi.fn<PrimerLifecycleDependencies['attachBinding']>(async (input) => ({
          created: false,
          artifactPath,
          primer,
          limsEntity,
          artifact: {
            ...artifact,
            artifactRevision: 2,
            bindings: [
              {
                id: 'manual-binding',
                relation: 'binds_to_sequence',
                source: input.source ?? 'manual',
                target: {
                  documentId: targetSnapshot.documentId,
                  topology: targetSnapshot.topology,
                  length: targetSnapshot.length,
                  fileContentHash: targetSnapshot.fileContentHash,
                  normalizedSequenceHash: targetSnapshot.normalizedSequenceHash,
                },
                coordinates: {
                  system: 'zero_based_half_open',
                  start: input.bindingStart,
                  end: input.bindingEnd,
                  strand: input.bindingStrand,
                },
                alignment: input.alignment,
              },
            ],
          },
          bindingMutation: 'created',
          bindingId: 'manual-binding',
          gitCommitted: true,
        })),
      });
      const result = await execDesignContract(
        addPrimerBindingOutputSchema,
        createAddPrimerBindingTool(folders, dependencies),
        {
          primerId: primer.id,
          targetDocumentId: targetSnapshot.documentId,
          start: 100,
          end: 107,
          strand: -1,
          maxMismatches: 3,
          expectedArtifactRevision: 1,
          validationMode,
        },
        { toolCallId: 'intentional-binding', messages: [] }
      );
      expect(result).toMatchObject({
        changed: true,
        bindingId: 'manual-binding',
        binding: { source: 'manual', alignment: null },
        bindingConfirmed: false,
      });
      expect(dependencies.attachBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'manual',
          alignment: undefined,
          expectedArtifactRevision: 1,
        })
      );
      if (validationMode === 'manual') expect(dependencies.matchPrimer).not.toHaveBeenCalled();
    }
  );
});

describe('feature-to-primer coordinates', () => {
  it('preserves the exact RAD51 CDS when given its one-based inclusive feature interval', () => {
    const sequence = parseGenBankFull(
      readFileSync(
        resolve(
          __dirname,
          '../../../../../../test-fixtures/genomes/yeast-S288C/NC_001137.3-annotated.gb'
        ),
        'utf8'
      )
    );
    const input = designPrimersSchema.parse({
      documentId: 'chrV',
      target: { start: 349980, end: 351182, coordinateSystem: 'one_based_inclusive' },
    });
    const prepared = preparePrimerDesignTemplate(sequence.sequence, 'linear', input.target);
    expect(prepared.targetLength).toBe(1203);
    expect(
      prepared.template.slice(prepared.targetStart, prepared.targetStart + prepared.targetLength)
    ).toBe(sequence.sequence.slice(349979, 351182));
    const legacy = preparePrimerDesignTemplate(sequence.sequence, 'linear', {
      start: 349979,
      end: 351182,
    });
    expect(prepared).toEqual(legacy);
  });
});

it('validates a pinned managed target by its exact document ID and current owned location', async () => {
  const pinned = { ...targetSnapshot, start: 200, end: 500, wrapsOrigin: false };
  targetValidation.resolve.mockResolvedValue({
    sourcePath: '/workspace/project/moved/contents/sequence.gb',
  });
  targetValidation.read.mockImplementation(async (_path, options) => ({
    sequenceId: options.documentId === pinned.documentId ? pinned.sequenceId : 999,
    length: pinned.length,
    topology: pinned.topology,
    fileContentHash: pinned.fileContentHash,
    normalizedSequenceHash: pinned.normalizedSequenceHash,
  }));
  await expect(assertTargetUnchanged(pinned)).resolves.toBeUndefined();
  expect(targetValidation.resolve).toHaveBeenCalledWith(pinned.documentId, [pinned.workspaceRoot]);
  expect(targetValidation.read).toHaveBeenCalledWith(
    '/workspace/project/moved/contents/sequence.gb',
    { workspaceRoot: pinned.workspaceRoot, documentId: pinned.documentId }
  );
  targetValidation.read.mockResolvedValue({
    sequenceId: pinned.sequenceId,
    length: pinned.length,
    topology: pinned.topology,
    fileContentHash: 'changed-file',
    normalizedSequenceHash: pinned.normalizedSequenceHash,
  });
  await expect(assertTargetUnchanged(pinned)).rejects.toThrow('Primer target changed after design');
});
