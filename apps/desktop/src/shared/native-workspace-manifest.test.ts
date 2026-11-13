// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  NATIVE_WORKSPACE_MANIFEST_SCHEMA,
  nativeWorkspaceEntityDisplayPath,
  nativeWorkspaceUsesAtomicSequenceProjection,
  parseNativeWorkspaceManifest,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifest,
  type NativeWorkspaceManifestEntity,
} from './native-workspace-manifest';

describe('native workspace manifest LIMS projections', () => {
  it.each([
    ['../outside.gb', 'must match its authoritative entity path'],
    ['/outside.gb', 'must match its authoritative entity path'],
    ['Sequences/other.gb', 'must match its authoritative entity path'],
  ] as const)('rejects an untrusted portable sequence path: %s', (relPath, message) => {
    expect(() => parseNativeWorkspaceManifest(manifestWithSequence({ relPath }))).toThrow(message);
  });

  it('requires an explicit workspace path base before resolving a portable sequence path', () => {
    expect(() =>
      parseNativeWorkspaceManifest(manifestWithSequence({ pathBase: undefined }))
    ).toThrow(/must use the workspace path base/i);
  });

  it('rejects a fractional portable sequence length', () => {
    expect(() => parseNativeWorkspaceManifest(manifestWithSequence({ length: 4.5 }))).toThrow(
      /sequence length is invalid/i
    );
  });
});

describe('native workspace manifest v1 physical path contract', () => {
  it('does not route v1 metadata into the v2 atomic projection', () => {
    expect(
      nativeWorkspaceUsesAtomicSequenceProjection({
        id: 'legacy',
        type: 'sequence',
        name: 'Legacy',
        path: 'Legacy.gb',
        fileKind: 'genbank',
        metadata: { classificationDecision: { legacyNote: true } },
      })
    ).toBe(false);
  });
  it('rejects a pathless database-backed entity', () => {
    expect(() =>
      parseNativeWorkspaceManifest(
        JSON.stringify({
          schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
          entities: [
            {
              id: 'strain-1',
              type: 'sample',
              name: 'Legacy strain',
              fileKind: 'benchling-native-record-evidence',
              lims: {
                kind: 'strain',
                name: 'Legacy strain',
                fields: {},
              },
            },
          ],
          links: [],
        })
      )
    ).toThrow(/entity strain-1 path is invalid/i);
  });

  it('round-trips a v1 document as v1 instead of silently upgrading it', () => {
    const original = JSON.stringify({
      schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
      entities: [baseEntity()],
      links: [],
    });
    const parsed = parseNativeWorkspaceManifest(original);
    expect(parsed.schema).toBe(NATIVE_WORKSPACE_MANIFEST_SCHEMA);
    const serialized = serializeNativeWorkspaceManifest(parsed);
    expect(serialized).toContain('dnaforge.native-workspace-manifest.v1');
    expect(serialized).not.toContain('dnaforge.native-workspace-manifest.v2');
  });
});

describe('native workspace manifest v2 placements', () => {
  it('only classifies file sequences with a LIMS projection as atomic', () => {
    const sequence = {
      id: 'sequence-1',
      type: 'sequence',
      name: 'Sequence',
      placement: { kind: 'file', relativePath: 'Sequence.gb', fileKind: 'genbank' },
      metadata: { classificationDecision: {} },
    } as const;

    expect(nativeWorkspaceUsesAtomicSequenceProjection(sequence)).toBe(false);
    expect(
      nativeWorkspaceUsesAtomicSequenceProjection({
        ...sequence,
        lims: { kind: 'dna_sequence', name: 'Sequence', fields: {} },
      })
    ).toBe(true);
  });

  it('preserves record archive state and allows its name to be reused by an active sibling', () => {
    const record = (id: string) => ({
      id,
      type: 'record',
      name: 'Reagent',
      placement: {
        kind: 'catalog-record',
        parentRelativePath: '',
        displayName: 'Reagent',
        catalogType: 'record',
        presentationKind: 'record',
      },
      lims: { kind: 'reagent', name: 'Reagent', fields: {} },
    });
    const archived = { ...record('a'), lifecycle: { state: 'archived', archivedAt: 100 } };
    expect(parseNativeWorkspaceManifest(v2Manifest([archived, record('b')])).entities[0]).toEqual(
      archived
    );
    expect(() => parseNativeWorkspaceManifest(v2Manifest([record('a'), record('b')]))).toThrow(
      /duplicated/
    );
    for (const lifecycle of [
      { state: 'archived' },
      { state: 'archived', archivedAt: -1 },
      { state: 'active', archivedAt: 100 },
      { state: 'unknown' },
    ]) {
      expect(() =>
        parseNativeWorkspaceManifest(v2Manifest([{ ...record('a'), lifecycle }]))
      ).toThrow(/lifecycle|archived/i);
    }
    expect(() =>
      parseNativeWorkspaceManifest(
        v2Manifest([
          {
            id: 'file',
            type: 'file',
            name: 'DNA',
            placement: { kind: 'file', relativePath: 'DNA.gb', fileKind: 'genbank' },
            lifecycle: { state: 'archived', archivedAt: 100 },
          },
        ])
      )
    ).toThrow(/record/i);
  });
  it('keeps Registry archive state portable for a native sequence without changing its physical binding', () => {
    const entity = {
      id: 'sequence',
      type: 'sequence',
      name: 'DNA',
      placement: { kind: 'file', relativePath: 'DNA.gb', fileKind: 'genbank' },
      lifecycle: { state: 'archived', archivedAt: 100 },
    };
    expect(parseNativeWorkspaceManifest(v2Manifest([entity])).entities[0]).toEqual(entity);
  });
  it('represents a custom Registry record without pretending it is a strain or a file', () => {
    const entity = {
      id: 'registry-record-1',
      type: 'record',
      name: 'Reagent',
      placement: {
        kind: 'catalog-record',
        parentRelativePath: 'Registry',
        displayName: 'Reagent',
        catalogType: 'record',
        presentationKind: 'record',
      },
      lims: {
        kind: 'reagent',
        name: 'Reagent',
        fields: { concentration: 12.5 },
        schemaRevisionId: 'reagent-v1',
        schemaSnapshot: {
          schemaId: 'reagent',
          schemaRevisionId: 'reagent-v1',
          name: 'reagent',
          displayName: 'Reagent',
          baseKind: 'reagent',
          version: 1,
          fields: [{ key: 'concentration', label: 'Concentration', type: 'number' }],
        },
      },
    };
    expect(parseNativeWorkspaceManifest(v2Manifest([entity])).entities[0]).toEqual(entity);
  });

  it('parses file, package, and catalog-record placements without mixing their fields', () => {
    const parsed = parseNativeWorkspaceManifest(
      v2Manifest([
        {
          id: 'sequence-file',
          type: 'sequence',
          name: 'Sequence file',
          placement: { kind: 'file', relativePath: 'Sequences/file.gb', fileKind: 'genbank' },
        },
        {
          id: 'notebook-package',
          type: 'notebook',
          name: 'Notebook package',
          placement: {
            kind: 'package',
            rootRelativePath: 'Notebooks/Notebook',
            primaryRelativePath: 'Notebooks/Notebook/page.md',
            fileKind: 'notebook-package',
          },
        },
        {
          id: 'strain-record',
          type: 'sample',
          name: 'Strain record',
          placement: {
            kind: 'catalog-record',
            parentRelativePath: 'Strains',
            displayName: 'Strain record',
            catalogType: 'sample',
            presentationKind: 'strain',
          },
          lims: { kind: 'strain', name: 'Strain record', fields: {} },
          sourceIdentities: [
            {
              provider: 'benchling',
              stableObjectId: 'bfi_STRAINAA',
              objectClass: 'registry_entity',
              bindingKind: 'reviewed',
            },
          ],
          migrationSource: {
            historyRunId: 'run-native-v2',
            sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
            sourceObjectId: 'bfi_STRAINAA',
          },
        },
      ])
    );
    const strainRecord = parsed.entities[2];
    if (!strainRecord) throw new Error('Expected a strain record fixture.');
    expect(nativeWorkspaceEntityDisplayPath(strainRecord)).toBe('Strains/Strain record');

    expect(parsed.schema).toBe('dnaforge.native-workspace-manifest.v2');
    expect(parsed.entities.map((entity) => entity.placement.kind)).toEqual([
      'file',
      'package',
      'catalog-record',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('/Users/');
  });

  it.each([
    [
      'mixed legacy fields',
      {
        id: 'mixed',
        type: 'sequence',
        name: 'Mixed',
        path: 'Sequences/mixed.gb',
        fileKind: 'genbank',
        placement: { kind: 'file', relativePath: 'Sequences/mixed.gb', fileKind: 'genbank' },
      },
      /unsupported field|mixed/i,
    ],
    [
      'protected path',
      {
        id: 'protected',
        type: 'sequence',
        name: 'Protected',
        placement: { kind: 'file', relativePath: '.dnaforge/object.gb', fileKind: 'genbank' },
      },
      /protected/i,
    ],
    [
      'unsupported presentation',
      {
        id: 'catalog',
        type: 'sample',
        name: 'Catalog',
        placement: {
          kind: 'catalog-record',
          parentRelativePath: 'Samples',
          displayName: 'Catalog',
          catalogType: 'sample',
          presentationKind: 'cell_line',
        },
      },
      /presentation kind/i,
    ],
    [
      'absolute migration source path',
      {
        id: 'source',
        type: 'sequence',
        name: 'Source',
        placement: { kind: 'file', relativePath: 'Sequences/source.gb', fileKind: 'genbank' },
        migrationSource: {
          historyRunId: 'run-1',
          sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
          sourceObjectId: 'seq_SOURCE01',
          originalPath: '/Users/example/export.zip',
        },
      },
      /migration source/i,
    ],
  ])('rejects %s', (_label, entity, message) => {
    expect(() => parseNativeWorkspaceManifest(v2Manifest([entity]))).toThrow(message);
  });

  it('rejects duplicate physical locations and duplicate virtual siblings', () => {
    expect(() =>
      parseNativeWorkspaceManifest(
        v2Manifest([
          fileEntity('first', 'Designs/shared.gb'),
          fileEntity('second', 'Designs/shared.gb'),
        ])
      )
    ).toThrow(/location is duplicated/i);
    expect(() =>
      parseNativeWorkspaceManifest(
        v2Manifest([
          catalogEntity('first', 'Strains', 'Shared strain'),
          catalogEntity('second', 'Strains', 'shared strain'),
        ])
      )
    ).toThrow(/virtual sibling/i);
  });

  it('rejects divergent catalog entity and placement display names', () => {
    const entity = catalogEntity('strain-1', 'Strains', 'Display name');
    entity.name = 'Different name';

    expect(() => parseNativeWorkspaceManifest(v2Manifest([entity]))).toThrow(
      /name does not match its catalog display name/i
    );
  });
});

function manifestWithSequence(
  overrides: Partial<{ relPath: string; pathBase: 'workspace' | undefined; length: number }>
): string {
  return JSON.stringify({
    schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
    entities: [
      {
        id: 'sequence-1',
        type: 'sequence',
        name: 'Sequence 1',
        path: 'Sequences/sequence-1.gb',
        fileKind: 'genbank',
        lims: {
          kind: 'dna_sequence',
          name: 'Sequence 1',
          fields: {
            sequence: {
              mode: 'file',
              pathBase: 'workspace',
              relPath: 'Sequences/sequence-1.gb',
              topology: 'linear',
              length: 4,
              contentHash: `sha256:${'a'.repeat(64)}`,
              sourceFormat: 'genbank',
              ...overrides,
            },
          },
        },
      },
    ],
    links: [],
  });
}

describe('native workspace manifest source identities', () => {
  const sequenceIdentity = {
    provider: 'benchling',
    stableObjectId: 'seq_DEMOSQ0005',
    objectClass: 'sequence',
    providerAccountHint: 'acme.benchling.com',
    canonicalUrl: 'https://acme.benchling.com/acme/f/lib_DEMOLB02/seq_DEMOSQ0005/edit',
    bindingKind: 'observed',
  } as const;
  const notebookIdentity = {
    provider: 'benchling',
    stableObjectId: 'etr_DEMOET0004',
    objectClass: 'notebook',
    bindingKind: 'reviewed',
  } as const;

  it('keeps source identities across a serialize and parse round trip', () => {
    const serialized = serializeNativeWorkspaceManifest(
      manifestOf({ ...baseEntity(), sourceIdentities: [sequenceIdentity] })
    );
    expect(serialized).toContain('seq_DEMOSQ0005');
    const reparsed = parseNativeWorkspaceManifest(serialized);
    expect(reparsed.entities[0]?.sourceIdentities).toEqual([sequenceIdentity]);
  });

  it('parses an entity that carries no source identities and adds no key', () => {
    const parsed = parseNativeWorkspaceManifest(manifestJson(undefined));
    expect(parsed.entities[0]).toBeDefined();
    expect(parsed.entities[0] && 'sourceIdentities' in parsed.entities[0]).toBe(false);
    expect(serializeNativeWorkspaceManifest(parsed)).not.toContain('sourceIdentities');
  });

  it('accepts an empty source identity array and omits it rather than writing noise', () => {
    const parsed = parseNativeWorkspaceManifest(manifestJson([]));
    expect(parsed.entities[0] && 'sourceIdentities' in parsed.entities[0]).toBe(false);
    expect(serializeNativeWorkspaceManifest(parsed)).not.toContain('sourceIdentities');
  });

  it('emits source identities in a deterministic order', () => {
    const forward = serializeNativeWorkspaceManifest(
      manifestOf({ ...baseEntity(), sourceIdentities: [sequenceIdentity, notebookIdentity] })
    );
    const reversed = serializeNativeWorkspaceManifest(
      manifestOf({ ...baseEntity(), sourceIdentities: [notebookIdentity, sequenceIdentity] })
    );
    expect(forward).toBe(reversed);
    expect(
      parseNativeWorkspaceManifest(reversed).entities[0]?.sourceIdentities?.map(
        (identity) => identity.stableObjectId
      )
    ).toEqual(['etr_DEMOET0004', 'seq_DEMOSQ0005']);
  });

  it('rejects a source identity list that is not an array', () => {
    expect(() => parseNativeWorkspaceManifest(manifestJson({ ...sequenceIdentity }))).toThrow(
      /source identities must be an array/i
    );
  });

  it('rejects a source identity that is not an object', () => {
    expect(() => parseNativeWorkspaceManifest(manifestJson(['seq_DEMOSQ0005']))).toThrow(
      /source identity 1 must be an object/i
    );
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      parseNativeWorkspaceManifest(manifestJson([{ ...sequenceIdentity, provider: 'geneious' }]))
    ).toThrow(/source identity 1 provider is invalid/i);
  });

  it.each(['seq_x', 'lib_DEMOLB02', '', 'Sequence 1'])(
    'rejects a stable object ID that is not an exact provider ID: %s',
    (stableObjectId) => {
      expect(() =>
        parseNativeWorkspaceManifest(manifestJson([{ ...sequenceIdentity, stableObjectId }]))
      ).toThrow(/source identity 1 stable object ID is invalid/i);
    }
  );

  it('rejects an unknown object class', () => {
    expect(() =>
      parseNativeWorkspaceManifest(manifestJson([{ ...sequenceIdentity, objectClass: 'plasmid' }]))
    ).toThrow(/source identity 1 object class is invalid/i);
  });

  it('rejects an unknown binding kind', () => {
    expect(() =>
      parseNativeWorkspaceManifest(manifestJson([{ ...sequenceIdentity, bindingKind: 'guessed' }]))
    ).toThrow(/source identity 1 binding kind is invalid/i);
  });

  it.each([
    'http://acme.benchling.com/acme/f/seq_DEMOSQ0005',
    'javascript:alert(1)',
    'https://evil.example.com/acme/f/seq_DEMOSQ0005',
    'https://user:pass@acme.benchling.com/acme/f/seq_DEMOSQ0005',
  ])('rejects an unsafe canonical URL: %s', (canonicalUrl) => {
    expect(() =>
      parseNativeWorkspaceManifest(manifestJson([{ ...sequenceIdentity, canonicalUrl }]))
    ).toThrow(/source identity 1 canonical URL is invalid/i);
  });

  it('rejects a duplicate identity on one entity', () => {
    expect(() =>
      parseNativeWorkspaceManifest(
        manifestJson([
          sequenceIdentity,
          { ...sequenceIdentity, bindingKind: 'reviewed', providerAccountHint: 'other' },
        ])
      )
    ).toThrow(/source identity is duplicated/i);
  });

  it('keeps different identities on different entities apart', () => {
    const parsed = parseNativeWorkspaceManifest(
      serializeNativeWorkspaceManifest(
        manifestOf(
          { ...baseEntity(), sourceIdentities: [sequenceIdentity] },
          {
            ...baseEntity({ id: 'notebook-1', path: 'Notebooks/notebook-1.md', type: 'notebook' }),
            sourceIdentities: [notebookIdentity],
          }
        )
      )
    );
    expect(parsed.entities[0]?.sourceIdentities).toEqual([sequenceIdentity]);
    expect(parsed.entities[1]?.sourceIdentities).toEqual([notebookIdentity]);
  });

  it('leaves one identity shared by two entities for the resolver to judge', () => {
    const parsed = parseNativeWorkspaceManifest(
      serializeNativeWorkspaceManifest(
        manifestOf(
          { ...baseEntity(), sourceIdentities: [sequenceIdentity] },
          {
            ...baseEntity({ id: 'sequence-2', path: 'Sequences/sequence-2.gb' }),
            sourceIdentities: [sequenceIdentity],
          }
        )
      )
    );
    expect(parsed.entities.map((entity) => entity.sourceIdentities)).toEqual([
      [sequenceIdentity],
      [sequenceIdentity],
    ]);
  });

  function manifestJson(sourceIdentities: unknown): string {
    return JSON.stringify({
      schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
      entities: [
        {
          ...baseEntity(),
          ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
        },
      ],
      links: [],
    });
  }
});

function baseEntity(
  overrides: Partial<NativeWorkspaceManifestEntity> = {}
): NativeWorkspaceManifestEntity {
  return {
    id: 'sequence-1',
    type: 'sequence',
    name: 'Sequence 1',
    path: 'Sequences/sequence-1.gb',
    fileKind: 'genbank',
    ...overrides,
  };
}

function manifestOf(...entities: NativeWorkspaceManifestEntity[]): NativeWorkspaceManifest {
  return { schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA, entities, links: [] };
}

function v2Manifest(entities: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    schema: 'dnaforge.native-workspace-manifest.v2',
    entities,
    links: [],
  });
}

function fileEntity(id: string, relativePath: string): Record<string, unknown> {
  return {
    id,
    type: 'sequence',
    name: id,
    placement: { kind: 'file', relativePath, fileKind: 'genbank' },
  };
}

function catalogEntity(
  id: string,
  parentRelativePath: string,
  displayName: string
): Record<string, unknown> {
  return {
    id,
    type: 'sample',
    name: displayName,
    placement: {
      kind: 'catalog-record',
      parentRelativePath,
      displayName,
      catalogType: 'sample',
      presentationKind: 'strain',
    },
  };
}
