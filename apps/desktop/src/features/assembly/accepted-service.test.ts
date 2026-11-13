import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/types';
import {
  acceptedAssemblyProductPathInDirectory,
  acceptedAssemblyWriteTargetFromProductPath,
  defaultAcceptedAssemblyProductPath,
  buildAcceptedAssemblySourceProvenance,
  defaultAcceptedAssemblyWriteTarget,
  finalizeAcceptedAssemblyDraft,
  mergeLoadedSourceSequencesForAcceptedProvenance,
  sanitizeAcceptedAssemblyDefaultBasename,
  workspaceFoldersToAcceptedAssemblyMap,
} from './accepted-service';
import {
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  realAssemblyPipelineAppScenario,
} from '../../test/scenarios/assembly-real-pipeline';

describe('accepted assembly service', () => {
  it('sanitizes user-facing design names before using them as accepted assembly filenames', () => {
    expect(sanitizeAcceptedAssemblyDefaultBasename('Level 1 / GFP \\ draft accepted')).toBe(
      'Level-1-GFP-draft-accepted'
    );
    expect(
      defaultAcceptedAssemblyWriteTarget({ name: 'Level 1 / GFP' }, '/workspace/project')
    ).toEqual({
      workspaceFolderId: '/workspace/project',
      relativeDirectory: 'assemblies',
      basename: 'Level-1-GFP-accepted',
    });
    expect(
      defaultAcceptedAssemblyProductPath({ name: 'Level 1 / GFP' }, '/workspace/project/')
    ).toBe('/workspace/project/assemblies/Level-1-GFP-accepted.gb');
    expect(
      acceptedAssemblyWriteTargetFromProductPath('/tmp/final.gb', { overwrite: true })
    ).toEqual({
      absoluteProductPath: '/tmp/final.gb',
      overwrite: true,
      parentIsExistingPackage: false,
    });
  });

  it('composes the canonical product filename inside a DNAForge-picked folder', () => {
    expect(
      acceptedAssemblyProductPathInDirectory(
        { name: 'Level 1 / GFP' },
        '/workspace/project/final constructs/'
      )
    ).toBe('/workspace/project/final constructs/Level-1-GFP-accepted.gb');
    expect(
      acceptedAssemblyProductPathInDirectory({ name: 'Level 1 / GFP' }, 'C:\\Lab\\Final')
    ).toBe('C:\\Lab\\Final\\Level-1-GFP-accepted.gb');
  });

  it('finalizes a ready design into written artifacts, next design state, and cached product sequence', async () => {
    const design = { ...createDesign(), name: 'Accepted/design' };
    const written = new Map<string, string>();
    const renamed = new Map<string, string>();

    const result = await finalizeAcceptedAssemblyDraft({
      design,
      writeTarget: defaultAcceptedAssemblyWriteTarget(design, '/workspace/project'),
      workspaceFolders: workspaceFoldersToAcceptedAssemblyMap([
        { path: '/workspace/project', name: 'Project' },
      ]),
      sequenceCache: {
        'source-left': {
          id: 'source-left',
          name: 'Source left',
          sequence: 'TTTTATGCATGCATGCGGGG',
          length: 20,
          annotations: [],
          circular: true,
        },
      },
      fs: {
        exists: async () => false,
        mkdir: async () => {},
        writeTextFile: async (path, content) => written.set(path, content),
        rename: async (from, to) => renamed.set(from, to),
      },
      acceptedAt: '2026-05-17T03:00:00.000Z',
      createId: () => 'accepted-1',
    });

    const pkgRoot = '/workspace/project/assemblies/Accepted-design-accepted';
    expect(result.files.packageRoot).toBe(pkgRoot);
    expect(result.files.productGenBankPath).toBe(`${pkgRoot}/Accepted-design-accepted.gb`);
    expect(result.files.metaPath).toBe(`${pkgRoot}/.forge/plasmid.json`);
    expect(result.files.primerCsvPath).toBe(
      `${pkgRoot}/contents/Accepted-design-accepted.accepted-1.primers.csv`
    );
    expect(result.files.primerFastaPath).toBe(
      `${pkgRoot}/contents/Accepted-design-accepted.accepted-1.primers.fasta`
    );
    expect(result.acceptedVersion.lifecycleState).toBe('written');
    expect(result.acceptedVersion.artifacts).toMatchObject({
      productGenBankPath: result.files.productGenBankPath,
      sidecarJsonPath: result.files.metaPath,
      primerCsvPath: result.files.primerCsvPath,
      primerFastaPath: result.files.primerFastaPath,
      productGenBankChecksum: result.files.productGenBankChecksum,
    });
    expect(result.nextDesign.assemblyState).toBe('assembled');
    expect(result.nextDesign.activeAcceptedAssemblyVersionId).toBe('accepted-1');
    expect(result.nextDesign.acceptedAssemblyVersions).toHaveLength(1);
    expect(result.productSequence.id).toBe(result.files.productGenBankPath);
    expect(result.productSequence.sequence).toBe('ATGCATGCGCTAGCTA');
    expect(written.size).toBe(5);
    expect(result.files.snapshotFiles).toHaveLength(1);
    expect([...renamed.values()]).toEqual([result.files.packageRoot]);
    expect([...renamed.keys()][0]).toContain('.staging-');
    expect([...written.keys()].every((path) => path.includes('.staging-'))).toBe(true);
    expect(
      result.acceptedVersion.projectionInput.sourceProvenance[0].sourceSequenceChecksum
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    const sidecarTmpPath = [...written.keys()].find((path) =>
      path.endsWith('/.forge/plasmid.json')
    );
    expect(JSON.parse(written.get(sidecarTmpPath ?? '') ?? '{}')).toMatchObject({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      product: { file: 'Accepted-design-accepted.gb' },
      assembly: {
        accepted: {
          acceptedAssemblyVersionId: 'accepted-1',
          lifecycleState: 'written',
          artifacts: {
            primerCsvPath: 'contents/Accepted-design-accepted.accepted-1.primers.csv',
            primerFastaPath: 'contents/Accepted-design-accepted.accepted-1.primers.fasta',
            productGenBankChecksum: result.files.productGenBankChecksum,
          },
        },
      },
    });
  });

  it('rejects non-ready and error-containing designs before touching the filesystem', async () => {
    let writeCount = 0;
    const fs = {
      exists: async () => false,
      mkdir: async () => {},
      writeTextFile: async () => {
        writeCount += 1;
      },
      rename: async () => {},
    };
    const base = {
      writeTarget: defaultAcceptedAssemblyWriteTarget(createDesign(), '/workspace/project'),
      workspaceFolders: workspaceFoldersToAcceptedAssemblyMap([
        { path: '/workspace/project', name: 'Project' },
      ]),
      fs,
    };

    await expect(
      finalizeAcceptedAssemblyDraft({
        ...base,
        design: { ...createDesign(), assemblyState: 'drafting' },
      })
    ).rejects.toThrow(/validate this assembly/i);
    await expect(
      finalizeAcceptedAssemblyDraft({
        ...base,
        design: {
          ...createDesign(),
          assemblyMethod: 'goldengate',
          goldenGateConfig: { enzyme: 'BsaI' },
          validationErrors: [],
          regions: [
            {
              ...createDesign().regions[0],
              sourceType: 'rd',
              ggType: 'insert',
              rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
              rdSourceEnzyme: 'BsmBI',
              rdSourceEnzymeName: 'BsmBI',
            },
            createDesign().regions[1],
          ],
        },
      })
    ).rejects.toThrow(/incompatible RD enzyme/i);
    expect(writeCount).toBe(0);
  });

  it('builds explicit provenance for every source region using the loaded source sequence cache', async () => {
    const snapshots = await buildAcceptedAssemblySourceProvenance(createDesign(), {
      'source-left': {
        id: 'source-left',
        name: 'Source left',
        sequence: 'TTTTATGCATGCATGCGGGG',
        length: 20,
        annotations: [
          {
            name: 'source-cache CDS',
            type: 'CDS',
            start: 6,
            end: 18,
            direction: 1,
            color: '#16a34a',
            qualifiers: { codon_start: ['2'], product: ['cached protein'] },
          },
        ],
        circular: true,
      },
    });

    expect(snapshots.map((snapshot) => snapshot.regionId)).toEqual(['left', 'right']);
    expect(snapshots[0]).toMatchObject({
      regionId: 'left',
      sourceSequenceChecksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sourceLength: 20,
      sourceIsCircular: true,
    });
    expect(snapshots[0].sourceAnnotations).toContainEqual({
      name: 'source-cache CDS',
      type: 'CDS',
      start: 5,
      end: 18,
      strand: 'forward',
      color: '#16a34a',
      qualifiers: { codon_start: ['2'], product: ['cached protein'] },
    });
    expect(snapshots[1].sourceSequenceChecksum).toBeUndefined();
  });

  it('keeps frozen part source annotations when the live cache has none', async () => {
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      sourceAnnotations: [
        {
          name: 'copied CDS',
          type: 'CDS',
          start: 4,
          end: 12,
          strand: 'forward',
        },
      ],
    };

    const snapshots = await buildAcceptedAssemblySourceProvenance(design, {
      'source-left': {
        id: 'source-left',
        name: 'Source left',
        sequence: 'TTTTATGCATGCATGCGGGG',
        length: 20,
        annotations: [],
        circular: true,
      },
    });

    expect(snapshots[0].sourceAnnotations).toEqual([
      expect.objectContaining({ name: 'copied CDS', type: 'CDS', start: 4, end: 12 }),
    ]);
  });

  it('loads a document-backed source only when the part has no frozen annotations', async () => {
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      sourceSequenceId: 'sequence-document-left',
    };
    const loaded = await mergeLoadedSourceSequencesForAcceptedProvenance(design, {}, async (id) =>
      id === 'sequence-document-left'
        ? {
            id,
            name: 'Source left',
            sequence: 'ATGC',
            length: 4,
            annotations: [{ name: 'ori', type: 'rep_origin', start: 1, end: 4, direction: 1 }],
            circular: false,
          }
        : null
    );

    expect(loaded['sequence-document-left']?.annotations).toEqual([
      expect.objectContaining({ name: 'ori' }),
    ]);

    design.regions[0] = {
      ...design.regions[0],
      sourceAnnotations: [
        { name: 'already frozen', type: 'CDS', start: 0, end: 4, strand: 'forward' },
      ],
    };
    const skipped = await mergeLoadedSourceSequencesForAcceptedProvenance(
      design,
      {},
      async (id) => {
        if (id === 'sequence-document-left') {
          throw new Error('must not load when the part already has a snapshot');
        }
        return null;
      }
    );
    expect(skipped['sequence-document-left']).toBeUndefined();
  });

  it('projects frozen part annotations onto the finalized product sequence', async () => {
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      sourceAnnotations: [
        {
          name: 'left source CDS',
          type: 'CDS',
          start: 4,
          end: 12,
          strand: 'forward',
        },
      ],
    };
    const result = await finalizeAcceptedAssemblyDraft({
      design,
      writeTarget: defaultAcceptedAssemblyWriteTarget(design, '/workspace/project'),
      workspaceFolders: workspaceFoldersToAcceptedAssemblyMap([
        { path: '/workspace/project', name: 'Project' },
      ]),
      sequenceCache: {},
      fs: {
        exists: async () => false,
        mkdir: async () => {},
        writeTextFile: async () => {},
        rename: async () => {},
      },
      acceptedAt: '2026-05-17T03:00:00.000Z',
      createId: () => 'accepted-annotated',
    });

    expect(result.productSequence.annotations).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'left source CDS', type: 'CDS' })])
    );
  });

  it('carries real source-cache annotations into accepted provenance for pUC19-derived assembly parts', async () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-rd-pcr-two-spacers');
    const design = scenario.designs.designs[scenario.designs.activeDesignId!];
    const source = scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID];

    const snapshots = await buildAcceptedAssemblySourceProvenance(design, {
      [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: source,
    });

    const rightPcr = snapshots.find((snapshot) => snapshot.regionId === 'puc19-pcr-right');
    expect(rightPcr).toBeDefined();
    expect(rightPcr?.sourceAnnotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'AmpR',
          type: 'CDS',
          start: 1625,
          end: 2486,
          strand: 'reverse',
        }),
      ])
    );
  });
});

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    constructId: 'construct-1',
    name: 'Accepted design',
    topology: 'circular',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 4,
        sourceEnd: 12,
        sequence: 'ATGCATGC',
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: 8,
        sequence: 'GCTAGCTA',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 5,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}
