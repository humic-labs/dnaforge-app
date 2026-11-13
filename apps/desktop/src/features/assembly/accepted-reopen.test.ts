// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import {
  acceptedAssemblyRecordCandidates,
  acceptedAssemblySidecarPathForProduct,
  acceptedAssemblyVersionFromSidecar,
  parseAcceptedAssemblyRecord,
  parseAcceptedAssemblySidecar,
  sequenceDesignFromAcceptedAssemblyVersion,
} from './accepted-reopen';

describe('accepted assembly reopen contract', () => {
  it('restores saved primer rules and rejects malformed rules', () => {
    const original = createSidecar();
    const rules = { targetPcrTm: 65, overlapLength: 40 };
    const payload = {
      ...original,
      projectionInput: { ...original.projectionInput, primerDesignConstraints: rules },
    };
    const parsed = parseAcceptedAssemblySidecar(JSON.stringify(payload));
    const accepted = acceptedAssemblyVersionFromSidecar(parsed, {
      sidecarChecksum: 'sha256:sidecar',
    });
    expect(
      sequenceDesignFromAcceptedAssemblyVersion(accepted, { designId: 'reopened-rules' })
        .primerDesignConstraints
    ).toEqual(rules);
    payload.projectionInput.primerDesignConstraints.overlapLength = -1;
    expect(() => parseAcceptedAssemblySidecar(JSON.stringify(payload))).toThrow(
      /invalid primer rules/
    );
  });

  it('restores the accepted PCR polymerase instead of dropping reaction provenance', () => {
    const original = createSidecar();
    const sidecar = {
      ...original,
      projectionInput: { ...original.projectionInput, pcrPolymerase: 'q5-0' },
    };
    const parsed = parseAcceptedAssemblySidecar(JSON.stringify(sidecar));
    const accepted = acceptedAssemblyVersionFromSidecar(parsed, {
      sidecarChecksum: 'sha256:sidecar',
    });
    expect(
      sequenceDesignFromAcceptedAssemblyVersion(accepted, { designId: 'reopened-pcr' })
        .pcrPolymerase
    ).toBe('q5-0');
  });

  it('refuses malformed PCR reaction provenance in an accepted record', () => {
    const original = createSidecar();
    const sidecar = {
      ...original,
      projectionInput: { ...original.projectionInput, pcrPolymerase: { private: 'malformed' } },
    };
    expect(() => parseAcceptedAssemblySidecar(JSON.stringify(sidecar))).toThrow(/PCR polymerase/);
  });

  it('discovers sidecar paths from finalized GenBank paths', () => {
    expect(acceptedAssemblySidecarPathForProduct('/workspace/asm/final.gb')).toBe(
      '/workspace/asm/final.waypoint-assembly.json'
    );
    expect(acceptedAssemblySidecarPathForProduct('/workspace/asm/final.genbank')).toBe(
      '/workspace/asm/final.waypoint-assembly.json'
    );
    expect(acceptedAssemblySidecarPathForProduct('/workspace/asm/final.gbff')).toBe(
      '/workspace/asm/final.waypoint-assembly.json'
    );
    expect(acceptedAssemblySidecarPathForProduct('/workspace/asm/final')).toBe(
      '/workspace/asm/final.waypoint-assembly.json'
    );
  });

  it('parses a sidecar into an accepted version and recreates an editable design draft', () => {
    const sidecar = createSidecar();
    const parsed = parseAcceptedAssemblySidecar(JSON.stringify(sidecar));
    const acceptedVersion = acceptedAssemblyVersionFromSidecar(parsed, {
      sidecarChecksum: 'sha256:sidecar',
    });
    const design = sequenceDesignFromAcceptedAssemblyVersion(acceptedVersion, {
      designId: 'reopened-design',
      now: new Date('2026-05-17T04:00:00.000Z'),
    });

    expect(acceptedVersion.id).toBe('accepted-1');
    expect(acceptedVersion.lifecycleState).toBe('written');
    expect(acceptedVersion.artifacts).toMatchObject({
      sidecarChecksum: 'sha256:sidecar',
      productGenBankPath: '/workspace/assemblies/final.gb',
    });
    expect(design).toMatchObject({
      id: 'reopened-design',
      name: 'Accepted construct',
      assemblyMethod: 'gibson',
      assemblyState: 'ready',
      status: 'computed',
      activeAcceptedAssemblyVersionId: 'accepted-1',
    });
    expect(design.regions).toHaveLength(2);
    expect(design.regions[0].sourceAnnotations).toEqual([
      expect.objectContaining({
        name: 'source CDS',
        type: 'CDS',
        start: 0,
        end: 12,
        qualifiers: { codon_start: '1' },
      }),
    ]);
    expect(design.spacers).toEqual([{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }]);
    expect(design.acceptedAssemblyVersions?.map((version) => version.id)).toEqual(['accepted-1']);
  });

  it('re-derives live validation state on reopen instead of trusting stale clean snapshots', () => {
    const sidecar = createSidecar();
    const staleCleanGoldenGateSidecar: AcceptedAssemblySidecarPayload = {
      ...sidecar,
      construction: {
        ...sidecar.construction,
        method: 'goldengate',
      },
      projectionInput: {
        ...sidecar.projectionInput,
        assemblyMethod: 'goldengate',
        goldenGateConfig: { enzyme: 'BsaI' },
        regions: [
          {
            ...sidecar.projectionInput.regions[0],
            sourceType: 'rd',
            ggType: 'insert',
            rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
            rdSourceEnzyme: 'BsmBI',
            rdSourceEnzymeName: 'BsmBI',
          },
          sidecar.projectionInput.regions[1],
        ],
      },
      validationSnapshot: {
        ...sidecar.validationSnapshot,
        assemblyMethod: 'goldengate',
        clean: true,
        issues: [],
      },
    };
    const acceptedVersion = acceptedAssemblyVersionFromSidecar(staleCleanGoldenGateSidecar);

    const design = sequenceDesignFromAcceptedAssemblyVersion(acceptedVersion, {
      designId: 'reopened-design',
      now: new Date('2026-05-17T04:00:00.000Z'),
    });

    expect(design.assemblyState).toBe('drafting');
    expect(design.status).toBe('draft');
    expect(design.validationErrors).toContainEqual(
      expect.objectContaining({
        code: 'goldengate_rd_enzyme_mismatch',
        severity: 'error',
        field: 'regions[0]',
        fragmentIndex: 0,
      })
    );
  });

  it('keeps older sidecars reopenable when they used the short acceptedVersionId key', () => {
    const sidecar = createSidecar();
    const legacySidecar = {
      ...sidecar,
      acceptedAssemblyVersionId: undefined,
      acceptedVersionId: 'accepted-legacy',
    };

    expect(acceptedAssemblyVersionFromSidecar(legacySidecar).id).toBe('accepted-legacy');
  });

  it('rejects sidecars whose validation snapshot no longer matches the canonical projection', () => {
    const sidecar = createSidecar();
    const invalid = {
      ...sidecar,
      validationSnapshot: {
        ...sidecar.validationSnapshot,
        projectionInputChecksum: 'sha256:different',
      },
    };

    expect(() => parseAcceptedAssemblySidecar(JSON.stringify(invalid))).toThrow(
      /validation checksum/i
    );
  });
});

describe('accepted saved oligo record', () => {
  it('reads the oligo and revision each primer used back from the sidecar', () => {
    const sidecar: AcceptedAssemblySidecarPayload = {
      ...createSidecar(),
      savedPrimerOligos: [
        {
          primerId: 'primer:design-1:r1:forward',
          oligoId: 'oligo-380',
          artifactRevision: 4,
          sequenceContentHash: 'sha256:bases-380',
        },
      ],
    };

    const accepted = acceptedAssemblyVersionFromSidecar(
      parseAcceptedAssemblySidecar(JSON.stringify(sidecar)),
      { sidecarChecksum: 'sha256:sidecar' }
    );

    expect(accepted.savedPrimerOligos).toEqual([
      {
        primerId: 'primer:design-1:r1:forward',
        oligoId: 'oligo-380',
        artifactRevision: 4,
        sequenceContentHash: 'sha256:bases-380',
      },
    ]);
  });

  it('reads an assembly accepted before the record existed', () => {
    const sidecar = createSidecar();
    expect('savedPrimerOligos' in sidecar).toBe(false);

    const accepted = acceptedAssemblyVersionFromSidecar(
      parseAcceptedAssemblySidecar(JSON.stringify(sidecar)),
      { sidecarChecksum: 'sha256:sidecar' }
    );

    expect(accepted.savedPrimerOligos).toBeUndefined();
    expect(accepted.canonicalDraftChecksum).toBe(sidecar.projectionInput.canonicalDraftChecksum);
  });
});

function createSidecar(): AcceptedAssemblySidecarPayload {
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-05-17T04:00:00.000Z',
    designId: 'design-1',
    designName: 'Accepted construct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:canonical',
      regionCount: 2,
      spacerCount: 1,
    },
    projectionInput: {
      schemaVersion: 1,
      designId: 'design-1',
      designName: 'Accepted construct',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: 'ATGCAAAGCTA',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'ATGC',
          annotations: [],
        },
        {
          id: 'right',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'GCTA',
          annotations: [],
        },
      ],
      spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [
        {
          regionId: 'left',
          sourceType: 'pcr',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [
            {
              name: 'source CDS',
              type: 'CDS',
              start: 0,
              end: 12,
              strand: 'forward',
              qualifiers: { codon_start: '1' },
            },
          ],
          copiedAnnotations: [],
        },
        {
          regionId: 'right',
          sourceType: 'pcr',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      ],
      canonicalDraftChecksum: 'sha256:canonical',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'design-1',
      designVersion: 3,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:canonical',
      validatedAt: '2026-05-17T04:00:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: '/workspace/assemblies/final.gb',
      sidecarJsonPath: '/workspace/assemblies/final.waypoint-assembly.json',
      primerCsvPath: '/workspace/assemblies/final.primers.csv',
      primerFastaPath: '/workspace/assemblies/final.primers.fasta',
      productSequenceChecksum: 'sha256:product',
      productGenBankChecksum: 'sha256:gb',
      primerCsvChecksum: 'sha256:primers-csv',
      primerFastaChecksum: 'sha256:primers-fasta',
      canonicalDraftChecksum: 'sha256:canonical',
    },
  };
}

describe('accepted assembly record resolution ', () => {
  describe('acceptedAssemblyRecordCandidates', () => {
    it('offers the package meta and the legacy sibling, package first', () => {
      expect(acceptedAssemblyRecordCandidates('/ws/pMyConstruct/pMyConstruct.gb')).toEqual({
        packageRoot: '/ws/pMyConstruct',

        productFile: 'pMyConstruct.gb',
        packageMetaPath: '/ws/pMyConstruct/.forge/plasmid.json',
        legacySidecarPath: '/ws/pMyConstruct/pMyConstruct.waypoint-assembly.json',
      });
    });

    it('handles a flat legacy product with no package around it', () => {
      const candidates = acceptedAssemblyRecordCandidates('/ws/assemblies/final.gbk');
      expect(candidates.legacySidecarPath).toBe('/ws/assemblies/final.waypoint-assembly.json');

      expect(candidates.packageMetaPath).toBe('/ws/assemblies/.forge/plasmid.json');
    });

    it.each([
      ['/ws/sequences/sample-f.dna', 'sample-f.dna'],
      ['/ws/sequences/reference.fa', 'reference.fa'],
    ])(
      'does not impose the GenBank package-product invariant on loose sequence %s',
      (productPath, productFile) => {
        expect(acceptedAssemblyRecordCandidates(productPath)).toEqual({
          packageRoot: '/ws/sequences',
          productFile,
          packageMetaPath: '/ws/sequences/.forge/plasmid.json',
          legacySidecarPath: `${productPath}.waypoint-assembly.json`,
        });
      }
    );
  });

  describe('parseAcceptedAssemblyRecord', () => {
    const packageRoot = '/ws/pMyConstruct';
    const relativeArtifacts = {
      productGenBankPath: 'pMyConstruct.gb',
      sidecarJsonPath: '.forge/plasmid.json',
      primerCsvPath: 'contents/pMyConstruct.primers.csv',
      primerFastaPath: 'contents/pMyConstruct.primers.fasta',
      productSequenceChecksum: 'sha256:seq',
      productGenBankChecksum: 'sha256:gb',
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum: 'sha256:draft',
    };

    function packageDocument(): string {
      return JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'plasmid-1',
        name: 'pMyConstruct',
        updatedAt: '2026-07-25T00:00:00.000Z',
        product: { file: 'pMyConstruct.gb', topology: 'circular' },
        assembly: {
          accepted: { ...buildSidecarPayload(), artifacts: relativeArtifacts },
        },
      });
    }

    it('unwraps the package document and ABSOLUTIZES its artifact paths', () => {
      const record = parseAcceptedAssemblyRecord(packageDocument(), { packageRoot });
      expect(record.artifacts.productGenBankPath).toBe(`${packageRoot}/pMyConstruct.gb`);
      expect(record.artifacts.primerCsvPath).toBe(
        `${packageRoot}/contents/pMyConstruct.primers.csv`
      );
      expect(record.type).toBe('accepted_assembly');
    });

    it('resolves against wherever the package is NOW — the move-survival property', () => {
      const record = parseAcceptedAssemblyRecord(packageDocument(), {
        packageRoot: '/somewhere/else/Renamed',
      });
      expect(record.artifacts.productGenBankPath).toBe('/somewhere/else/Renamed/pMyConstruct.gb');
    });

    it('still reads a LEGACY flat sidecar unchanged (AC7)', () => {
      const legacy = JSON.stringify(buildSidecarPayload());
      const record = parseAcceptedAssemblyRecord(legacy, { packageRoot: null });
      expect(record.type).toBe('accepted_assembly');

      expect(record.artifacts.productGenBankPath).toBe('/workspace/asm/final.gb');
    });

    it('rejects a package document whose embedded payload is not an accepted assembly', () => {
      const broken = JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'p',
        name: 'p',
        product: { file: 'p.gb', topology: 'circular' },
        assembly: { accepted: { type: 'nonsense' } },
      });
      expect(() => parseAcceptedAssemblyRecord(broken, { packageRoot })).toThrow();
    });

    it('refuses to hand back a record for a DIFFERENT plasmid', () => {
      expect(() =>
        parseAcceptedAssemblyRecord(packageDocument(), {
          packageRoot,

          productFile: 'some-other-sequence.gb',
        })
      ).toThrow(/not the product/i);
    });

    it('accepts the record when the clicked file IS the product', () => {
      expect(() =>
        parseAcceptedAssemblyRecord(packageDocument(), {
          packageRoot,
          productFile: 'pMyConstruct.gb',
        })
      ).not.toThrow();
    });

    it('rejects a plasmid package that carries NO build record', () => {
      const imported = JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'p',
        name: 'pUC19',
        product: { file: 'pUC19.gb', topology: 'circular' },
      });
      expect(() => parseAcceptedAssemblyRecord(imported, { packageRoot })).toThrow(/no assembly/i);
    });
  });
});

function buildSidecarPayload(): AcceptedAssemblySidecarPayload {
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-07-25T00:00:00.000Z',
    designId: 'design-1',
    designName: 'pMyConstruct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:draft',
      regionCount: 2,
      spacerCount: 0,
    },
    projectionInput: {
      canonicalDraftChecksum: 'sha256:draft',
      regions: [],
      spacers: [],
      sourceProvenance: [],
    },
    validationSnapshot: { projectionInputChecksum: 'sha256:draft' },
    artifacts: {
      productGenBankPath: '/workspace/asm/final.gb',
      sidecarJsonPath: '/workspace/asm/final.waypoint-assembly.json',
      primerCsvPath: '/workspace/asm/final.primers.csv',
      primerFastaPath: '/workspace/asm/final.primers.fasta',
      productSequenceChecksum: 'sha256:seq',
      canonicalDraftChecksum: 'sha256:draft',
    },
  } as unknown as AcceptedAssemblySidecarPayload;
}
