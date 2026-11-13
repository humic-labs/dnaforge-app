import { describe, expect, it } from 'vitest';
import type { SourceObject } from '../../shared/benchling-migration';
import { resolveOfflineRelationships } from './relationship-resolver';
import { attachStrainRelationships } from './strain-relationship-resolver';

describe('Benchling strain relationship resolution', () => {
  it('links one exact name under an allowlisted relationship field', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [field('Ancestor strain', 'Parent', 0)]),
      strain('bfi_PARENTAA', 'Parent', []),
    ]);

    const resolutions = resolve(sourceObjects);
    expect(resolutions).toEqual([
      expect.objectContaining({
        sourceObjectId: 'bfi_SOURCEAA',
        targetSourceId: 'bfi_PARENTAA',
        relationType: 'derives_from',
        classification: 'exact',
        candidateSourceIds: ['bfi_PARENTAA'],
      }),
    ]);
  });

  it('keeps every duplicate-name candidate as ambiguous instead of choosing one', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [field('Ancestor strain', 'Shared parent', 0)]),
      strain('bfi_PARENTAA', 'Shared parent', []),
      strain('bfi_PARENTBB', 'Shared parent', []),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: null,
        classification: 'ambiguous',
        candidateSourceIds: ['bfi_PARENTAA', 'bfi_PARENTBB'],
      }),
    ]);
  });

  it('does not treat notebook placeholders as native strain candidates', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [field('Ancestor strain', 'Shared parent', 0)]),
      strain('bfi_PARENTAA', 'Shared parent', []),
      notebookPlaceholder('bfi_NOTEBOOKA', 'Shared parent'),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'bfi_PARENTAA',
        classification: 'exact',
        candidateSourceIds: ['bfi_PARENTAA'],
      }),
    ]);
  });

  it('keeps an explicit strain identity pending when only a notebook placeholder exists', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [field('Ancestor strain', 'bfi_TARGETAA', 0)]),
      notebookPlaceholder('bfi_TARGETAA', 'Referenced registry item'),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'bfi_TARGETAA',
        classification: 'unresolved',
        candidateSourceIds: [],
      }),
    ]);
  });

  it('preserves a missing exact stable ID as pending and ignores unknown field semantics', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [
        field('Ancestor strain', 'bfi_MISSINGA', 0),
        field('custom field', 'bfi_IGNOREDX', 1),
      ]),
    ]);

    expect(sourceObjects[0]?.relationships).toHaveLength(1);
    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'bfi_MISSINGA',
        classification: 'unresolved',
        candidateSourceIds: [],
      }),
    ]);
  });

  it('keeps source missing-value sentinels as metadata without creating pending links', () => {
    const [sourceObject] = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Child', [
        field('Ancestor strain', 'None', 0),
        field('Sequence link(s)', '-', 1),
      ]),
    ]);

    expect(sourceObject?.relationships).toEqual([]);
    expect(sourceObject?.content).toMatchObject({
      fields: [
        { label: 'Ancestor strain', value: 'None', position: 0 },
        { label: 'Sequence link(s)', value: '-', position: 1 },
      ],
    });
  });

  it('links each comma-separated display name instead of the joined field text', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'PCY602', [
        field(
          'Sequence link(s)',
          'GEM-ZQX-Sundew integrated Chr XI, Triple reporter integrated',
          0
        ),
      ]),
      sequence('seq_SUNTA1', 'GEM-ZQX-Sundew integrated Chr XI'),
      sequence('seq_TRIPL1', 'Triple reporter integrated'),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'seq_SUNTA1',
        relationType: 'associated_with',
        classification: 'exact',
        candidateSourceIds: ['seq_SUNTA1'],
      }),
      expect.objectContaining({
        targetSourceId: 'seq_TRIPL1',
        relationType: 'associated_with',
        classification: 'exact',
        candidateSourceIds: ['seq_TRIPL1'],
      }),
    ]);
  });

  it('keeps a missing sibling pending under its own name when the other display name resolves', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'PCY721', [
        field('Sequence link(s)', 'Triple reporter integrated, pDEMO175', 0),
      ]),
      sequence('seq_TRIPL1', 'Triple reporter integrated'),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'seq_TRIPL1',
        classification: 'exact',
      }),
      expect.objectContaining({
        targetSourceId: null,
        classification: 'unresolved',
        candidateSourceIds: [],
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: 'name', value: 'pDEMO175' }),
        ]),
      }),
    ]);
  });

  it('does not split a field whose full text is already one exact display name', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'PCY602', [
        field('Sequence link(s)', 'Alpha construct, beta construct', 0),
      ]),
      sequence('seq_JOINED1', 'Alpha construct, beta construct'),
      sequence('seq_ALPHAA1', 'Alpha construct'),
      sequence('seq_BETAA01', 'beta construct'),
    ]);

    expect(resolve(sourceObjects)).toEqual([
      expect.objectContaining({
        targetSourceId: 'seq_JOINED1',
        classification: 'exact',
        candidateSourceIds: ['seq_JOINED1'],
      }),
    ]);
  });

  it('creates one exact relationship per explicit provider ID in a multi-target field', () => {
    const sourceObjects = attachStrainRelationships([
      strain('bfi_SOURCEAA', 'Carrier', [
        field('Plasmids, lysogens, episomes', 'seq_PLASMIDA; seq_PLASMIDB', 0),
      ]),
      sequence('seq_PLASMIDA', 'Plasmid A'),
      sequence('seq_PLASMIDB', 'Plasmid B'),
    ]);

    expect(resolve(sourceObjects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetSourceId: 'seq_PLASMIDA',
          classification: 'exact',
        }),
        expect.objectContaining({
          targetSourceId: 'seq_PLASMIDB',
          classification: 'exact',
        }),
      ])
    );
  });
});

function resolve(sourceObjects: readonly SourceObject[]) {
  return resolveOfflineRelationships({
    sourceObjects,
    relationships: sourceObjects.flatMap(({ relationships }) => relationships),
    selectedSnapshotStableIdsAreAuthoritative: true,
  }).resolutions;
}

function strain(
  stableId: string,
  name: string,
  fields: Array<{ label: string; value: string; position: number }>
): SourceObject {
  return {
    id: stableId,
    stableId,
    sourceType: 'strain',
    name,
    aliases: [],
    sourceUrl: `urn:dnaforge:test:${stableId}`,
    sourcePath: `Registry/${name} (${stableId}).txt`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: { kind: 'benchling_strain', displayName: name, fields },
    relationships: [],
  };
}

function sequence(stableId: string, name: string): SourceObject {
  return {
    id: stableId,
    stableId,
    sourceType: 'dna_sequence',
    name,
    aliases: [],
    sourceUrl: `urn:dnaforge:test:${stableId}`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: { moleculeType: 'DNA', bases: 'ACGT', annotations: [] },
    relationships: [],
  };
}

function notebookPlaceholder(stableId: string, name: string): SourceObject {
  return {
    id: stableId,
    stableId,
    sourceType: 'notebook_entry',
    name,
    aliases: [],
    sourceUrl: `urn:dnaforge:test:${stableId}`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: { blocks: [] },
    relationships: [],
  };
}

function field(label: string, value: string, position: number) {
  return { label, value, position };
}
