import { describe, expect, it } from 'vitest';
import {
  addPrimerArtifactBinding,
  buildPrimerArtifact,
  defaultPrimerArtifactPath,
  normalizePrimerArtifactPath,
  parsePrimerArtifact,
  primerArtifactMetadataFields,
  primerArtifactNotes,
  removePrimerArtifactBinding,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
  updatePrimerArtifactBinding,
  validatePrimerArtifactPath,
} from './primer-artifact';
import { parseIdtOligoNotation } from './oligo-modifications';
import { parsePrimerArtifact as parseSharedPrimerArtifact } from '../../shared/primers/primer-artifact';
import { primerArtifactRegistryFields } from './primer-artifact-projection';

const WORKSPACE_ROOT = '/workspace/project';
const TARGET_PATH = '/workspace/project/sequences/pUC19.gb';
const TARGET_DOCUMENT_ID = 'sequence-document-puc19';
const AGENT_DESIGN_ID = `sha256:${'a'.repeat(64)}`;

describe('primer artifact v2', () => {
  it('records an authored annealing segment without inventing design evidence', async () => {
    const pbs = 'ACGTACGTACGTACGTACGT';
    const overhang = 'G'.repeat(30);
    const tailed = await buildPrimerArtifact({
      id: 'authored-primer',
      catalogNumber: 'PR-000998',
      name: 'Authored',
      sequence: overhang + pbs,
      annealing: { pbsSequence: pbs, overhangSequence: overhang },
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: `${WORKSPACE_ROOT}/primers/authored.primer.json`,
      source: 'manual',
    });
    const plain = await buildPrimerArtifact({
      id: 'plain-primer',
      catalogNumber: 'PR-000999',
      name: 'Plain',
      sequence: pbs,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: `${WORKSPACE_ROOT}/primers/plain.primer.json`,
      source: 'manual',
    });
    expect(tailed.computed.tmC).toBe(plain.computed.tmC);
    expect(tailed.designProvenance).toBeUndefined();
    expect(parsePrimerArtifact(serializePrimerArtifact(tailed)).annealing).toEqual({
      pbsSequence: pbs,
      overhangSequence: overhang,
    });
    expect(() =>
      parsePrimerArtifact(
        JSON.stringify({
          ...tailed,
          annealing: { pbsSequence: 'AAAA', overhangSequence: overhang },
        })
      )
    ).toThrow('reconstruct');
  });
  it('retains mixed base case through modified artifact creation, revision and reload', async () => {
    const bases = 'acgtACGTacgtACGTacgt';
    const parsed = parseIdtOligoNotation(`/5Phos/${bases}/3SpC3/`);
    const artifact = await buildPrimerArtifact({
      id: 'primer-case-v1',
      catalogNumber: 'PR-000097',
      name: 'Case_F1',
      sequence: parsed.bases,
      oligo: parsed.composition ?? undefined,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Case_F1.primer.json',
      source: 'manual',
    });
    expect(artifact.sequence.bases).toBe(bases);
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact)).sequence.bases).toBe(bases);
    const extended = parseIdtOligoNotation(`/5Phos/${bases}tC/3SpC3/`);
    const revised = await revisePrimerArtifactContent(artifact, {
      name: artifact.name,
      sequence: extended.bases,
      oligo: extended.composition ?? undefined,
    });
    expect(revised.sequence.bases).toBe(`${bases}tC`);
    expect(parsePrimerArtifact(serializePrimerArtifact(revised)).oligo?.notation).toBe(
      `/5Phos/${bases}tC/3SpC3/`
    );
  });

  it('stores additive vendor composition without breaking pre-composition v1 artifacts', async () => {
    const parsedOligo = parseIdtOligoNotation('/5Phos/ATCGATCGATCGATCGATCG/3InvdT/');
    expect(parsedOligo.errors).toEqual([]);
    const artifact = await buildPrimerArtifact({
      id: 'primer-modified-v1',
      catalogNumber: 'PR-000098',
      name: 'Modified_F1',
      sequence: parsedOligo.bases,
      oligo: parsedOligo.composition ?? undefined,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Modified_F1.primer.json',
      source: 'manual',
    });

    expect(artifact.schemaVersion).toBe(3);
    expect(artifact.oligo).toEqual(parsedOligo.composition);
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact)).oligo).toEqual(
      parsedOligo.composition
    );

    const legacy = { ...artifact };
    delete legacy.oligo;
    expect(parsePrimerArtifact(JSON.stringify(legacy)).oligo).toBeUndefined();
  });

  it('round-trips an RNA order type and exact notation without inventing a DNA Tm', async () => {
    const notation = '/5Phos/rArCrG/i2FU/rArCrGrUrArCrGrU/3SpC3/';
    const parsedOligo = parseIdtOligoNotation(notation, { orderType: 'rna' });
    expect(parsedOligo.errors).toEqual([]);

    const artifact = await buildPrimerArtifact({
      id: 'primer-rna-v1',
      catalogNumber: 'PR-000091',
      name: 'RNA_oligo_1',
      sequence: parsedOligo.bases,
      oligo: parsedOligo.composition ?? undefined,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/RNA_oligo_1.primer.json',
      source: 'manual',
    });

    expect(artifact.sequence.bases).toBe('ACGUACGUACGU');
    expect(artifact.oligo).toMatchObject({
      orderType: 'rna',
      notation,
      modifications: [
        expect.objectContaining({ vendorCode: '5Phos' }),
        expect.objectContaining({ vendorCode: 'i2FU', naturalBase: 'U' }),
        expect.objectContaining({ vendorCode: '3SpC3' }),
      ],
    });
    expect(artifact.registry.kind).toBe('rna_oligo');
    expect(artifact.entity?.schema).toMatchObject({
      name: 'rna_oligo',
      displayName: 'RNA Oligo',
    });
    expect(artifact.entity?.schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'sequence', type: 'rna_sequence', required: true }),
      ])
    );
    expect(artifact.computed.tmC).toBeNull();
    expect(artifact.computed.tmCalculation).toBeUndefined();
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact))).toEqual(artifact);
  });

  it('keeps historical artifacts readable after the vendor publishes a new ordering rule', async () => {
    const notation = '/5YakYel/ACGTACGTACGTACGTACGT/36-TAMSp/';
    const historicalOligo = parseIdtOligoNotation(notation, {
      enforceVendorConstraints: false,
    });
    expect(historicalOligo.errors).toEqual([]);
    expect(parseIdtOligoNotation(notation).errors).toContain(
      'IDT does not allow Yakima Yellow and TAMRA in the same oligo.'
    );

    const artifact = await buildPrimerArtifact({
      id: 'primer-before-vendor-rule',
      catalogNumber: 'PR-000094',
      name: 'Historical_modified_primer',
      sequence: historicalOligo.bases,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Historical_modified_primer.primer.json',
      source: 'manual',
    });
    const persistedBeforeRule = {
      ...artifact,
      oligo: historicalOligo.composition ?? undefined,
    };

    expect(parsePrimerArtifact(serializePrimerArtifact(persistedBeforeRule)).oligo).toEqual(
      historicalOligo.composition
    );
    await expect(
      buildPrimerArtifact({
        id: 'primer-after-vendor-rule',
        catalogNumber: 'PR-000093',
        name: 'New_invalid_modified_primer',
        sequence: historicalOligo.bases,
        oligo: historicalOligo.composition ?? undefined,
        workspaceRoot: WORKSPACE_ROOT,
        artifactPath: '/workspace/project/primers/New_invalid_modified_primer.primer.json',
        source: 'manual',
      })
    ).rejects.toThrow(/does not allow Yakima Yellow and TAMRA/);
  });

  it('round-trips a universal modified base without claiming a canonical identity', async () => {
    const parsedOligo = parseIdtOligoNotation('ATCGATCGAT/iRiboI/CGATCGATCG');
    expect(parsedOligo.errors).toEqual([]);
    expect(parsedOligo.bases).toBe('ATCGATCGATNCGATCGATCG');

    const artifact = await buildPrimerArtifact({
      id: 'primer-universal-base-v1',
      catalogNumber: 'PR-000095',
      name: 'Universal_base_F1',
      sequence: parsedOligo.bases,
      oligo: parsedOligo.composition ?? undefined,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Universal_base_F1.primer.json',
      source: 'manual',
    });

    expect(artifact.oligo?.modifications[0]).toMatchObject({
      vendorCode: 'iRiboI',
      naturalBase: 'N',
      anchor: { kind: 'base', index: 10 },
    });
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact))).toEqual(artifact);
  });

  it('rejects vendor composition whose modified-base analogue disagrees with natural bases', async () => {
    const parsedOligo = parseIdtOligoNotation('ATCGATCGAT/iBiodT/CGATCGATCG');
    expect(parsedOligo.errors).toEqual([]);
    const artifact = await buildPrimerArtifact({
      id: 'primer-modified-invalid',
      catalogNumber: 'PR-000097',
      name: 'Modified_invalid',
      sequence: parsedOligo.bases,
      oligo: parsedOligo.composition ?? undefined,
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Modified_invalid.primer.json',
      source: 'manual',
    });
    const corrupted = structuredClone(artifact);
    if (!corrupted.oligo || corrupted.oligo.modifications[0]?.anchor.kind !== 'base') {
      throw new Error('Expected a modified-base fixture.');
    }
    corrupted.oligo.modifications[0].naturalBase = 'A';

    expect(() => parsePrimerArtifact(serializePrimerArtifact(corrupted))).toThrow(
      /natural-base analogue/
    );
  });

  it('revises scientific content in place while preserving identity and bindings', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-edit-v1',
      catalogNumber: 'PR-000096',
      name: 'Before',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Before.primer.json',
      source: 'manual',
      binding: {
        id: 'binding-edit-v1',
        targetDocumentId: TARGET_DOCUMENT_ID,
        targetFilePath: TARGET_PATH,
        targetLength: 2686,
        targetTopology: 'circular',
        targetFileContentHash: 'target-file-sha256',
        targetNormalizedSequenceHash: 'target-sequence-sha256',
        start: 100,
        end: 120,
        strand: 1,
      },
      now: 1_750_000_000_000,
    });
    artifact.bindings[0].alignment = {
      identity: 1,
      editDistance: 0,
      mismatchPositions: [],
      threePrimeMatchLength: 20,
      effectiveTmC: artifact.computed.tmC,
    };
    const parsedOligo = parseIdtOligoNotation('/5Phos/ATCGATCGATCGATCGATCA');
    const revised = await revisePrimerArtifactContent(
      artifact,
      {
        name: 'After',
        sequence: parsedOligo.bases,
        oligo: parsedOligo.composition ?? undefined,
        notes: 'Revised manually',
      },
      1_750_000_010_000
    );

    expect(revised).toMatchObject({
      id: artifact.id,
      catalogNumber: artifact.catalogNumber,
      artifactRevision: 2,
      name: 'After',
      sequence: { bases: 'ATCGATCGATCGATCGATCA', length: 20 },
      metadata: {
        createdAt: artifact.metadata.createdAt,
        updatedAt: new Date(1_750_000_010_000).toISOString(),
        notes: 'Revised manually',
      },
      file: artifact.file,
    });
    expect(revised.bindings).toHaveLength(1);
    expect(revised.bindings[0].id).toBe('binding-edit-v1');
    expect(revised.bindings[0].alignment).toBeUndefined();
    expect(revised.oligo).toEqual(parsedOligo.composition);
    expect(parsePrimerArtifact(serializePrimerArtifact(revised))).toEqual(revised);
  });

  it('rejects changing an existing oligo entity between DNA and RNA', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-dna-identity-v1',
      catalogNumber: 'PR-000098',
      name: 'DNA identity',
      sequence: 'ACGTACGTACGT',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/DNA_identity.primer.json',
      source: 'manual',
    });
    const rna = parseIdtOligoNotation('rArCrGrUrArCrGrUrArCrGrU', { orderType: 'rna' });
    expect(rna.errors).toEqual([]);

    await expect(
      revisePrimerArtifactContent(artifact, {
        name: artifact.name,
        sequence: rna.bases,
        oligo: rna.composition,
      })
    ).rejects.toThrow(/oligo entity type cannot change/i);
  });

  it('carries a portable primer-schema snapshot and fields without changing artifact v1', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-schema-aware-1',
      catalogNumber: 'PR-000099',
      name: 'qPCR_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/qPCR_F1.primer.json',
      source: 'manual',
      entitySchema: {
        schemaId: 'schema-qpcr-primer',
        schemaRevisionId: 'schema-qpcr-primer-v3',
        name: 'qpcr_primer',
        displayName: 'qPCR primer',
        baseKind: 'primer',
        version: 3,
        fields: [
          { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
          { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
          { key: 'assayId', label: 'Assay ID', type: 'text', required: true },
        ],
      },
      entityFields: { assayId: 'ASSAY-42' },
    });

    expect(artifact.schemaVersion).toBe(3);
    expect(artifact.registry.kind).toBe('qpcr_primer');
    expect(artifact.entity).toEqual({
      schema: {
        schemaId: 'schema-qpcr-primer',
        schemaRevisionId: 'schema-qpcr-primer-v3',
        name: 'qpcr_primer',
        displayName: 'qPCR primer',
        baseKind: 'primer',
        version: 3,
        fields: [
          { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
          { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
          { key: 'assayId', label: 'Assay ID', type: 'text', required: true },
        ],
      },
      fields: { assayId: 'ASSAY-42' },
    });
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact)).entity).toEqual(artifact.entity);
  });

  it('rejects custom field values that violate the embedded schema', async () => {
    await expect(
      buildPrimerArtifact({
        id: 'primer-invalid-schema-value',
        catalogNumber: 'PR-000101',
        name: 'Invalid_F1',
        sequence: 'ATCGATCGATCGATCGATCG',
        workspaceRoot: WORKSPACE_ROOT,
        artifactPath: '/workspace/project/primers/Invalid_F1.primer.json',
        source: 'manual',
        entitySchema: {
          schemaId: 'schema-qpcr-primer',
          schemaRevisionId: 'schema-qpcr-primer-v1',
          name: 'qpcr_primer',
          displayName: 'qPCR primer',
          baseKind: 'primer',
          version: 1,
          fields: [{ key: 'replicateCount', label: 'Replicates', type: 'number', required: true }],
        },
        entityFields: { replicateCount: 'three' },
      })
    ).rejects.toThrow('replicateCount must be a finite number');
  });

  it('continues to parse legacy v1 artifacts that predate schema snapshots', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-legacy-v1',
      catalogNumber: 'PR-000100',
      name: 'Legacy_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Legacy_F1.primer.json',
      source: 'manual',
    });
    const legacy = { ...artifact, schemaVersion: 1 };
    delete legacy.entity;

    expect(parsePrimerArtifact(JSON.stringify(legacy))).toMatchObject({
      schemaVersion: 2,
      registry: { kind: 'oligo', use: 'primer' },
    });
  });

  it('reads v2 without changing its bytes and requires v3 for saved recovery state', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'versioned-recovery',
      catalogNumber: 'PR-000102',
      name: 'Versioned recovery',
      sequence: 'ACGTTGCAAGTCCTGATCGA',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Versioned.primer.json',
      source: 'manual',
    });
    const legacy = { ...artifact, schemaVersion: 2 as const };
    expect(serializePrimerArtifact(parsePrimerArtifact(serializePrimerArtifact(legacy)))).toBe(
      serializePrimerArtifact(legacy)
    );
    artifact.entity!.state = {
      registrationStatus: 'registered',
      domainStatus: null,
      archived: true,
      archivedAt: 1_700_000_000_000,
      status: null,
      source: null,
    };
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact)).entity!.state).toEqual(
      artifact.entity!.state
    );
    expect(() => parsePrimerArtifact(JSON.stringify({ ...artifact, schemaVersion: 2 }))).toThrow(
      'require primer artifact version 3'
    );
    expect(() => parsePrimerArtifact(JSON.stringify({ ...legacy, schemaVersion: 4 }))).toThrow(
      'Unsupported primer artifact schema version'
    );
  });

  it('retains portable and unrecognized saved metadata through the shared parser', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-preserved-extensions',
      catalogNumber: 'PR-000103',
      name: 'Preserved metadata',
      sequence: 'acgtACGTacgtACGTacgt',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Preserved.primer.json',
      source: 'manual',
    });
    const saved = {
      ...artifact,
      extension: { version: 2, values: ['original', null, 9] },
      metadata: { ...artifact.metadata, importedFrom: { label: 'Original order' } },
      entity: {
        ...artifact.entity!,
        otherFields: { provenance: { ownerLabel: 'Original project', annotations: [true, null] } },
        state: {
          registrationStatus: 'registered' as const,
          domainStatus: null,
          archived: true,
          archivedAt: 1_700_000_000_000,
          status: null,
          source: null,
        },
      },
      inventory: {
        origin: 'import',
        originDetails: { supplierRecord: { id: 'external-17' } },
        vendor: 'Original supplier',
        orderDate: null,
        scale: null,
        purification: null,
        modifications: null,
        stockLocation: 'Freezer 1',
        concentration: 12.5,
      },
      recovery: {
        schema: 'dnaforge.primer-recovery/v1' as const,
        source: 'registry' as const,
        sourceFingerprint: 'a'.repeat(64),
        sourceActor: null,
        relationshipsFingerprint: 'b'.repeat(64),
        retainedExtension: { original: true },
      },
    };
    const bytes = serializePrimerArtifact(saved);
    const shared = parseSharedPrimerArtifact(bytes);
    expect(JSON.parse(serializePrimerArtifact(shared))).toEqual(saved);
    expect(serializePrimerArtifact(parsePrimerArtifact(bytes))).toBe(bytes);
    expect(shared.sequence.bases).toBe('acgtACGTacgtACGTacgt');
  });

  it('uses a safe, user-visible workspace default path', () => {
    expect(defaultPrimerArtifactPath(WORKSPACE_ROOT, 'pUC19 reverse / test')).toBe(
      '/workspace/project/primers/pUC19_reverse_test.primer.json'
    );
  });

  it('normalizes the extension and rejects paths outside the owning workspace', () => {
    expect(normalizePrimerArtifactPath('/workspace/project/primers/p1')).toBe(
      '/workspace/project/primers/p1.primer.json'
    );
    expect(
      validatePrimerArtifactPath('/workspace/project/primers/p1.primer.json', WORKSPACE_ROOT)
    ).toEqual({ valid: true, relativePath: 'primers/p1.primer.json' });
    expect(
      validatePrimerArtifactPath('/workspace/project-evil/p1.primer.json', WORKSPACE_ROOT)
    ).toEqual({
      valid: false,
      error: 'Primer files must be saved inside the owning workspace.',
    });
    expect(
      validatePrimerArtifactPath(
        '/workspace/project/primers/../../outside/p1.primer.json',
        WORKSPACE_ROOT
      )
    ).toEqual({
      valid: false,
      error: 'Primer files must be saved inside the owning workspace.',
    });
  });

  it('captures stable registry identity, metadata, and a typed sequence relationship', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-entity-1',
      catalogNumber: 'PR-000001',
      name: 'pUC19_R1',
      sequence: 'GCGGGCCTCTTCGCTATTACGCCAGCTGGCGA',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/pUC19_R1.primer.json',
      binding: {
        id: 'primer-binding-1',
        targetDocumentId: TARGET_DOCUMENT_ID,
        targetFilePath: TARGET_PATH,
        targetLength: 2686,
        targetTopology: 'circular',
        targetFileContentHash: 'target-file-sha256',
        targetNormalizedSequenceHash: 'target-sequence-sha256',
        start: 1711,
        end: 1743,
        strand: -1,
      },
      application: 'sequencing',
      notes: 'Reverse sequencing primer',
      actor: 'local-user',
      source: 'drag-selection',
      now: 1_750_000_000_000,
    });

    expect(artifact).toMatchObject({
      schema: 'dnaforge.primer',
      schemaVersion: 3,
      artifactRevision: 1,
      id: 'primer-entity-1',
      name: 'pUC19_R1',
      catalogNumber: 'PR-000001',
      registry: {
        required: true,
        entityId: 'primer-entity-1',
        kind: 'oligo',
        use: 'primer',
      },
      metadata: {
        createdAt: new Date(1_750_000_000_000).toISOString(),
        updatedAt: new Date(1_750_000_000_000).toISOString(),
        actor: 'local-user',
        source: 'drag-selection',
        application: 'sequencing',
        notes: 'Reverse sequencing primer',
      },
      bindings: [
        {
          id: 'primer-binding-1',
          relation: 'binds_to_sequence',
          target: {
            documentId: TARGET_DOCUMENT_ID,
            topology: 'circular',
            length: 2686,
            fileContentHash: 'target-file-sha256',
            normalizedSequenceHash: 'target-sequence-sha256',
          },
          coordinates: {
            system: 'zero_based_half_open',
            start: 1711,
            end: 1743,
            strand: -1,
          },
          source: 'drag-selection',
        },
      ],
    });
    expect(artifact.sequence.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.sequence.length).toBe(32);
    expect(artifact.computed.tmC).toBeTypeOf('number');
    expect(artifact.computed.gcPercent).toBeTypeOf('number');

    const serialized = serializePrimerArtifact(artifact);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(parsePrimerArtifact(serialized)).toEqual(artifact);
  });

  it('persists the selected Tm calculation instead of silently replacing it with local SantaLucia', async () => {
    const tmCalculation = {
      model: { kind: 'neb' as const, polymerase: 'q5', prodcode: 'q5-0' },
      source: 'user-setting' as const,
      reason: 'App-wide Tm model chosen in settings (NEB Q5).',
      valueC: 72.4,
      status: 'verified' as const,
      provider: {
        source: 'neb-api' as const,
        tm: 72.4,
        conc_nM: 500,
        verified: true,
        polymerase: 'q5',
        prodcode: 'q5-0',
        nebApiVersion: '0.19.0',
        fetchedAt: '2026-08-10T12:00:00.000Z',
      },
    };

    const artifact = await buildPrimerArtifact({
      id: 'primer-neb',
      catalogNumber: 'PRI-0002',
      name: 'Q5 primer',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      workspaceRoot: '/workspace',
      artifactPath: '/workspace/primers/q5.primer.json',
      tmCalculation,
    });

    expect(artifact.computed.tmC).toBe(72.4);
    expect(artifact.computed.tmCalculation).toEqual(tmCalculation);
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact)).computed.tmCalculation).toEqual(
      tmCalculation
    );
  });

  it('supports a standalone registry primer until it is attached to a sequence', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-entity-unbound',
      catalogNumber: 'PR-000002',
      name: 'Library_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Library_F1.primer.json',
      source: 'manual',
      now: 1_750_000_000_000,
    });

    expect(artifact.bindings).toEqual([]);
    expect(parsePrimerArtifact(serializePrimerArtifact(artifact))).toEqual(artifact);
  });

  it('increments artifact revision and timestamps when relationships attach or detach', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-entity-mutable',
      catalogNumber: 'PR-000004',
      name: 'Mutable_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Mutable_F1.primer.json',
      source: 'manual',
      now: 1_750_000_000_000,
    });
    const binding = {
      id: 'primer-binding-mutable',
      relation: 'binds_to_sequence' as const,
      target: {
        documentId: TARGET_DOCUMENT_ID,
        topology: 'circular' as const,
        length: 2686,
        fileContentHash: 'file-hash',
        normalizedSequenceHash: 'sequence-hash',
      },
      coordinates: {
        system: 'zero_based_half_open' as const,
        start: 100,
        end: 120,
        strand: 1 as const,
      },
      source: 'manual' as const,
    };

    const attached = addPrimerArtifactBinding(artifact, binding, 1_750_000_001_000);
    expect(attached.artifactRevision).toBe(2);
    expect(attached.metadata.updatedAt).toBe(new Date(1_750_000_001_000).toISOString());
    expect(attached.bindings).toEqual([binding]);
    expect(parsePrimerArtifact(serializePrimerArtifact(attached))).toEqual(attached);

    const detached = removePrimerArtifactBinding(
      attached,
      'primer-binding-mutable',
      1_750_000_002_000
    );
    expect(detached.artifactRevision).toBe(3);
    expect(detached.bindings).toEqual([]);
    expect(parsePrimerArtifact(serializePrimerArtifact(detached))).toEqual(detached);
  });

  it('round-trips agent design provenance and updates a binding without changing its identity', async () => {
    const designTm = {
      model: { kind: 'neb' as const, prodcode: 'q5-0', polymerase: 'q5' },
      source: 'reaction' as const,
      reason: 'Q5 was selected for this design.',
      valueC: 63.2,
      status: 'verified' as const,
      provider: {
        source: 'neb-api' as const,
        tm: 63.2,
        verified: true,
        pendingNebVerification: false,
        conc_nM: 500,
        ta: 67,
        polymerase: 'q5',
        prodcode: 'q5-0',
        nebApiVersion: 'v1',
        fetchedAt: '2025-06-15T15:06:40.000Z',
      },
    };
    const artifact = await buildPrimerArtifact({
      id: 'primer-agent-1',
      catalogNumber: 'PR-000005',
      name: 'pUC19_agent_F',
      sequence: 'ggggACGTTGCAACGTTGCAACGT',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/pUC19_agent_F.primer.json',
      source: 'agent-design',
      tmCalculation: designTm,
      designProvenance: {
        designId: AGENT_DESIGN_ID,
        candidateId: `${AGENT_DESIGN_ID}:pair-0:forward`,
        candidateRank: 0,
        role: 'forward',
        pbsSequence: 'ACGTTGCAACGTTGCAACGT',
        overhangSequence: 'gggg',
        target: {
          documentId: TARGET_DOCUMENT_ID,
          topology: 'circular',
          length: 2686,
          fileContentHash: 'target-file-sha256',
          normalizedSequenceHash: 'target-sequence-sha256',
          start: 400,
          end: 700,
          wrapsOrigin: false,
        },
        primer3: {
          application: 'golden_gate',
          parameters: { num_return: 3, min_tm: 57 },
          warnings: [],
        },
        tm: designTm,
      },
      now: 1_750_000_000_000,
    });
    const originalBinding = {
      id: 'binding-stable-1',
      relation: 'binds_to_sequence' as const,
      target: {
        documentId: TARGET_DOCUMENT_ID,
        topology: 'circular' as const,
        length: 2686,
        fileContentHash: 'target-file-sha256',
        normalizedSequenceHash: 'target-sequence-sha256',
      },
      coordinates: {
        system: 'zero_based_half_open' as const,
        start: 100,
        end: 120,
        strand: 1 as const,
      },
      source: 'agent-design' as const,
      alignment: {
        identity: 1,
        editDistance: 0,
        mismatchPositions: [],
        threePrimeMatchLength: 20,
        effectiveTmC: 63.2,
      },
    };
    const attached = addPrimerArtifactBinding(artifact, originalBinding, 1_750_000_001_000);
    expect(() =>
      addPrimerArtifactBinding(
        artifact,
        { ...originalBinding, id: 'binding-without-alignment', alignment: undefined },
        1_750_000_001_000
      )
    ).toThrow(/requires valid alignment evidence/);
    const replacement = {
      ...originalBinding,
      coordinates: { ...originalBinding.coordinates, start: 101, end: 121 },
      alignment: {
        identity: 0.95,
        editDistance: 1,
        mismatchPositions: [4],
        threePrimeMatchLength: 15,
        effectiveTmC: 58.4,
      },
    };

    const updated = updatePrimerArtifactBinding(
      attached,
      'binding-stable-1',
      replacement,
      1_750_000_002_000
    );
    expect(() =>
      updatePrimerArtifactBinding(
        attached,
        'binding-stable-1',
        { ...replacement, alignment: undefined },
        1_750_000_002_000
      )
    ).toThrow(/requires valid alignment evidence/);

    expect(updated.id).toBe(artifact.id);
    expect(updated.artifactRevision).toBe(3);
    expect(updated.bindings).toEqual([replacement]);
    expect(updated.designProvenance).toEqual(artifact.designProvenance);
    expect(updated.designProvenance?.primer3.application).toBe('golden_gate');
    expect(parsePrimerArtifact(serializePrimerArtifact(updated))).toEqual(updated);

    const missingTm = JSON.parse(serializePrimerArtifact(updated)) as {
      designProvenance?: Record<string, unknown>;
    };
    delete missingTm.designProvenance?.tm;
    expect(() => parsePrimerArtifact(JSON.stringify(missingTm))).toThrow(/design provenance/);

    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...updated,
          designProvenance: {
            ...updated.designProvenance!,
            pbsSequence: 'TTTTTTTTTTTTTTTTTTTT',
          },
        })
      )
    ).toThrow(/design provenance/);
    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...updated,
          designProvenance: {
            ...updated.designProvenance!,
            candidateId: `${AGENT_DESIGN_ID}:pair-1:reverse`,
          },
        })
      )
    ).toThrow(/design provenance/);
    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...updated,
          designProvenance: {
            ...updated.designProvenance!,
            tm: {
              ...updated.designProvenance!.tm,
              valueC: 64.2,
              provider: { ...updated.designProvenance!.tm.provider, tm: 64.2 },
            },
          },
        })
      )
    ).toThrow(/design Tm provenance/);
    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...updated,
          designProvenance: {
            ...updated.designProvenance!,
            target: {
              ...updated.designProvenance!.target,
              start: 400,
              end: 700,
              wrapsOrigin: true,
            },
          },
        })
      )
    ).toThrow(/design provenance/);
    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...updated,
          bindings: [
            {
              ...updated.bindings[0],
              alignment: {
                ...updated.bindings[0].alignment!,
                mismatchPositions: [25],
              },
            },
          ],
        })
      )
    ).toThrow(/sequence binding relationship/);
  });

  it('rejects a file that attempts to project into another registry identity', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'primer-entity-1',
      catalogNumber: 'PR-000003',
      name: 'Identity_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: WORKSPACE_ROOT,
      artifactPath: '/workspace/project/primers/Identity_F1.primer.json',
      source: 'manual',
    });

    expect(() =>
      parsePrimerArtifact(
        serializePrimerArtifact({
          ...artifact,
          registry: { ...artifact.registry, entityId: 'another-entity' },
        })
      )
    ).toThrow(/registry projection/);
  });

  it('rejects an annotation-shaped or malformed artifact instead of treating it as a primer', () => {
    expect(() =>
      parsePrimerArtifact(
        JSON.stringify({
          schema: 'genbank.annotation',
          schemaVersion: 1,
          sequence: 'ACGT',
        })
      )
    ).toThrow(/dnaforge\.primer/);
  });
});

describe('primer metadata authority', () => {
  const input = {
    id: '04c47fb2-a71e-4ffe-97ff-27bd9c41baf9',
    catalogNumber: 'PR-000105',
    name: 'HSP104-deletion-F',
    sequence: 'acgtACGTacgtACGTacgt',
    workspaceRoot: WORKSPACE_ROOT,
    artifactPath: '/workspace/project/primers/HSP104-deletion-F.primer.json',
    source: 'manual' as const,
    now: 1_750_000_000_000,
  };

  it('uses saved schema Notes everywhere without rewriting divergent historical bytes', async () => {
    const artifact = await buildPrimerArtifact({ ...input, notes: 'Original construction notes' });
    artifact.entity!.fields.notes = 'original-history original history Save check';
    const original = serializePrimerArtifact(artifact);
    const reloaded = parsePrimerArtifact(original);
    expect(primerArtifactMetadataFields(reloaded).notes).toBe(
      'original-history original history Save check'
    );
    expect(primerArtifactNotes(reloaded)).toBe('original-history original history Save check');
    expect(
      primerArtifactRegistryFields(reloaded, {
        sequenceContentHash: 'sequence-hash',
        artifactContentHash: 'artifact-hash',
      }).notes
    ).toBe('original-history original history Save check');
    expect(serializePrimerArtifact(reloaded)).toBe(original);
    expect(reloaded.metadata.notes).toBe('Original construction notes');

    delete reloaded.entity!.fields.notes;
    expect(primerArtifactMetadataFields(reloaded).notes).toBe('Original construction notes');
    expect(primerArtifactNotes(reloaded)).toBe('Original construction notes');
    reloaded.entity!.fields.notes = null;
    expect(primerArtifactNotes(reloaded)).toBeNull();
    expect(primerArtifactMetadataFields(reloaded).notes).toBeNull();
  });

  it.each([
    { notes: 'Legacy caller', entityFields: undefined, expected: 'Legacy caller' },
    { notes: undefined, entityFields: { notes: 'Schema caller' }, expected: 'Schema caller' },
    { notes: 'Both callers', entityFields: { notes: 'Both callers' }, expected: 'Both callers' },
  ])('creates coherent compatibility Notes for $expected', async ({ expected, ...metadata }) => {
    const artifact = await buildPrimerArtifact({ ...input, ...metadata });
    expect(artifact.metadata.notes).toBe(expected);
    expect(artifact.entity?.fields.notes).toBe(expected);
  });

  it('saves and clears Notes through either API without changing scientific evidence', async () => {
    const artifact = await buildPrimerArtifact({ ...input, notes: 'Original' });
    artifact.bindings = [
      {
        id: 'metadata-only-binding',
        relation: 'binds_to_sequence',
        target: {
          documentId: TARGET_DOCUMENT_ID,
          topology: 'circular',
          length: 2686,
          fileContentHash: 'target-file-sha256',
          normalizedSequenceHash: 'target-sequence-sha256',
        },
        coordinates: { system: 'zero_based_half_open', start: 100, end: 120, strand: 1 },
        source: 'manual',
        alignment: {
          identity: 1,
          editDistance: 0,
          mismatchPositions: [],
          threePrimeMatchLength: 20,
          effectiveTmC: artifact.computed.tmC!,
        },
      },
    ];
    const original = serializePrimerArtifact(artifact);
    const changed = await revisePrimerArtifactContent(artifact, {
      name: artifact.name,
      sequence: artifact.sequence.bases,
      entityFields: { notes: 'Edited schema Notes', vendor: 'Retained vendor' },
    });
    expect(changed.metadata.notes).toBe('Edited schema Notes');
    expect(changed.entity?.fields).toEqual({
      notes: 'Edited schema Notes',
      vendor: 'Retained vendor',
    });
    expect(changed.sequence).toEqual(artifact.sequence);
    expect(changed.computed).toEqual(artifact.computed);
    expect(changed.bindings).toEqual(artifact.bindings);
    expect(serializePrimerArtifact(artifact)).toBe(original);
    const cleared = await revisePrimerArtifactContent(changed, {
      name: changed.name,
      sequence: changed.sequence.bases,
      entityFields: { vendor: 'Retained vendor' },
    });
    expect(cleared.metadata.notes).toBeNull();
    expect(primerArtifactMetadataFields(cleared)).not.toHaveProperty('notes');
    const legacyEdited = await revisePrimerArtifactContent(cleared, {
      name: cleared.name,
      sequence: cleared.sequence.bases,
      notes: 'Legacy edit',
    });
    expect(legacyEdited.entity?.fields.notes).toBe('Legacy edit');
    const legacyCleared = await revisePrimerArtifactContent(legacyEdited, {
      name: legacyEdited.name,
      sequence: legacyEdited.sequence.bases,
      notes: null,
    });
    expect(legacyCleared.metadata.notes).toBeNull();
    expect(legacyCleared.entity?.fields).not.toHaveProperty('notes');
  });

  it('rejects conflicting explicit Notes instead of choosing one silently', async () => {
    const conflicting = { notes: 'Legacy input', entityFields: { notes: 'Schema input' } };
    await expect(buildPrimerArtifact({ ...input, ...conflicting })).rejects.toThrow(
      /conflicting.*notes/i
    );
    const artifact = await buildPrimerArtifact(input);
    await expect(
      revisePrimerArtifactContent(artifact, {
        name: artifact.name,
        sequence: artifact.sequence.bases,
        ...conflicting,
      })
    ).rejects.toThrow(/conflicting.*notes/i);
  });
});
