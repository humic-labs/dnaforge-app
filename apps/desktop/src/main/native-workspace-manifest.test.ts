import { describe, expect, it } from 'vitest';

import {
  parseNativeWorkspaceManifest,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifestSourceIdentity,
} from '../shared/native-workspace-manifest';
import { nativeWorkspaceManifestFromPlan } from './native-workspace-manifest';
import { relocateNativeWorkspaceDirectFilePlacement } from './native-workspace-manifest-mutations';
import type { NativeWorkspaceMaterializationPlan } from './native-workspace-materializer';

const WORKSPACE_PATH = '/tmp/native-workspace';

const sequenceIdentity: NativeWorkspaceManifestSourceIdentity = {
  provider: 'benchling',
  stableObjectId: 'seq_DEMOSQ0005',
  objectClass: 'sequence',
  providerAccountHint: 'acme.benchling.com',
  canonicalUrl: 'https://acme.benchling.com/acme/f/lib_DEMOLB02/seq_DEMOSQ0005/edit',
  bindingKind: 'observed',
};

describe('nativeWorkspaceManifestFromPlan source identities', () => {
  it.each([1, 2] as const)(
    'preserves a pinned custom schema in a v%s catalog roundtrip',
    (version) => {
      const plan = planWith(undefined);
      const entity = plan.entities[0];
      if (!entity) throw new Error('Expected the fixture entity.');
      entity.placement = {
        kind: 'file',
        relativePath: 'Sequences/sequence-1.gb',
        fileKind: 'genbank',
      };
      const schemaSnapshot = {
        schemaId: 'schema-fidelity-reagent',
        schemaRevisionId: 'schema-fidelity-reagent-v1',
        name: 'fidelity_reagent',
        displayName: 'Fidelity reagent',
        baseKind: 'fidelity_reagent',
        version: 1,
        fields: [
          { key: 'concentration', label: 'Concentration', type: 'number' },
          { key: 'sequence', label: 'Sequence number', type: 'number' },
        ],
      };
      plan.limsEntities = [
        {
          entityRawId: entity.rawId,
          input: {
            kind: 'fidelity_reagent',
            name: 'Reagent',
            fields: { concentration: 12.5, sequence: 17 },
            schemaRevisionId: schemaSnapshot.schemaRevisionId,
            schemaSnapshot,
          },
        },
      ];

      const manifest = nativeWorkspaceManifestFromPlan({
        workspacePath: WORKSPACE_PATH,
        plan,
        manifestVersion: version,
      });
      const restored = parseNativeWorkspaceManifest(serializeNativeWorkspaceManifest(manifest));
      expect(restored.entities[0]?.lims).toMatchObject({
        schemaRevisionId: schemaSnapshot.schemaRevisionId,
        schemaSnapshot,
        fields: { concentration: 12.5, sequence: 17 },
      });
    }
  );

  it('emits the source identities carried by a plan entity', () => {
    const manifest = nativeWorkspaceManifestFromPlan({
      workspacePath: WORKSPACE_PATH,
      plan: planWith([sequenceIdentity]),
    });
    expect(manifest.entities[0]?.sourceIdentities).toEqual([sequenceIdentity]);

    const written = serializeNativeWorkspaceManifest(manifest);
    expect(parseNativeWorkspaceManifest(written).entities[0]?.sourceIdentities).toEqual([
      sequenceIdentity,
    ]);
  });

  it('omits the key entirely when a plan entity has no source identities', () => {
    const manifest = nativeWorkspaceManifestFromPlan({
      workspacePath: WORKSPACE_PATH,
      plan: planWith(undefined),
    });
    expect(manifest.entities[0] && 'sourceIdentities' in manifest.entities[0]).toBe(false);
    expect(serializeNativeWorkspaceManifest(manifest)).not.toContain('sourceIdentities');
  });

  it('omits the key when a plan entity carries an empty source identity list', () => {
    const manifest = nativeWorkspaceManifestFromPlan({
      workspacePath: WORKSPACE_PATH,
      plan: planWith([]),
    });
    expect(manifest.entities[0] && 'sourceIdentities' in manifest.entities[0]).toBe(false);
    expect(serializeNativeWorkspaceManifest(manifest)).not.toContain('sourceIdentities');
  });

  it('writes an explicit v2 manifest with all placement kinds and a reviewed source reference', () => {
    const plan = planWith(undefined);
    const sequenceEntity = plan.entities[0];
    if (!sequenceEntity) throw new Error('Expected the sequence fixture entity.');
    plan.entities = [
      {
        ...sequenceEntity,
        placement: { kind: 'file', relativePath: 'Sequences/sequence-1.gb', fileKind: 'genbank' },
      },
      {
        rawId: 'notebook-1',
        type: 'notebook',
        name: 'Notebook 1',
        locator: { kind: 'file' },
        storageType: 'file',
        placement: {
          kind: 'package',
          rootRelativePath: 'Notebooks/Notebook 1',
          primaryRelativePath: 'Notebooks/Notebook 1/page.md',
          fileKind: 'notebook-package',
        },
      },
      {
        rawId: 'strain-1',
        type: 'sample',
        name: 'Native strain name',
        locator: { kind: 'entity', namespace: 'lims' },
        storageType: 'database',
        placement: {
          kind: 'catalog-record',
          parentRelativePath: 'Strains',
          displayName: 'Native strain name',
          catalogType: 'sample',
          presentationKind: 'strain',
        },
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
    ];
    plan.limsEntities = [
      {
        entityRawId: 'strain-1',
        input: {
          kind: 'strain',
          name: 'Native strain name',
          fields: {},
          registrationStatus: 'registered',
          actor: 'migration',
        },
      },
    ];

    const manifest = nativeWorkspaceManifestFromPlan({
      workspacePath: WORKSPACE_PATH,
      plan,
      manifestVersion: 2,
    });
    expect(manifest.schema).toBe('dnaforge.native-workspace-manifest.v2');
    if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2') {
      throw new Error('Expected a v2 manifest.');
    }
    expect(manifest.entities.map((entity) => entity.placement.kind)).toEqual([
      'file',
      'package',
      'catalog-record',
    ]);
    expect(manifest.entities[2]).toMatchObject({
      placement: { catalogType: 'sample', presentationKind: 'strain' },
      lims: { kind: 'strain' },
      sourceIdentities: [{ bindingKind: 'reviewed', stableObjectId: 'bfi_STRAINAA' }],
      migrationSource: { historyRunId: 'run-native-v2', sourceObjectId: 'bfi_STRAINAA' },
    });
    const written = serializeNativeWorkspaceManifest(manifest);
    expect(written).not.toContain(WORKSPACE_PATH);
    expect(parseNativeWorkspaceManifest(written).schema).toBe(
      'dnaforge.native-workspace-manifest.v2'
    );
  });

  it('refuses to write an absolute external path into v2 metadata', () => {
    const plan = planWith(undefined);
    const sequenceEntity = plan.entities[0];
    if (!sequenceEntity) throw new Error('Expected the sequence fixture entity.');
    plan.entities[0] = {
      ...sequenceEntity,
      placement: { kind: 'file', relativePath: 'Sequences/sequence-1.gb', fileKind: 'genbank' },
      metadata: { originalPath: '/Users/example/Benchling export.zip' },
    };
    expect(() =>
      nativeWorkspaceManifestFromPlan({
        workspacePath: WORKSPACE_PATH,
        plan,
        manifestVersion: 2,
      })
    ).toThrow(/external source path/i);
  });

  it('moves a v2 direct file by portable entity ID and updates its file-backed LIMS field', () => {
    const plan = planWith(undefined);
    const entity = plan.entities[0];
    if (!entity) throw new Error('Expected the sequence fixture entity.');
    plan.entities[0] = {
      ...entity,
      placement: { kind: 'file', relativePath: 'Sequences/sequence-1.gb', fileKind: 'genbank' },
    };
    plan.limsEntities = [
      {
        entityRawId: 'sequence-1',
        input: {
          kind: 'dna_sequence',
          name: 'Sequence 1',
          fields: {
            sequence: {
              mode: 'file',
              relPath: `${WORKSPACE_PATH}/Sequences/sequence-1.gb`,
            },
          },
          actor: 'migration',
        },
      },
    ];
    const manifest = nativeWorkspaceManifestFromPlan({
      workspacePath: WORKSPACE_PATH,
      plan,
      manifestVersion: 2,
    });
    if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2') {
      throw new Error('Expected a v2 manifest.');
    }

    const moved = relocateNativeWorkspaceDirectFilePlacement({
      manifest,
      portableId: 'sequence-1',
      oldRelativePath: 'Sequences/sequence-1.gb',
      newRelativePath: 'Archive/renamed.gb',
    });

    expect(moved?.entities[0]).toMatchObject({
      id: 'sequence-1',
      placement: { kind: 'file', relativePath: 'Archive/renamed.gb' },
      lims: {
        fields: {
          sequence: {
            mode: 'file',
            pathBase: 'workspace',
            relPath: 'Archive/renamed.gb',
          },
        },
      },
    });
  });
});

function planWith(
  sourceIdentities: NativeWorkspaceManifestSourceIdentity[] | undefined
): NativeWorkspaceMaterializationPlan {
  return {
    schema: 'dnaforge.native-workspace-materialization.v1',
    entities: [
      {
        rawId: 'sequence-1',
        type: 'sequence',
        name: 'Sequence 1',
        locator: { kind: 'file' },
        storageType: 'file',
        relativePath: 'Sequences/sequence-1.gb',
        fileKind: 'genbank',
        ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
      },
    ],
    links: [],
    events: [],
  };
}
