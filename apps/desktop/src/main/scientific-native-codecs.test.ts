import { describe, expect, it } from 'vitest';
import { applyScientificBatch, defineScientificFile } from '@waypoint/scientific-objects';
import {
  createRevisionGraph,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import { scientificNativeCodecs } from './scientific-native-codecs';
import {
  buildPrimerArtifact,
  serializePrimerArtifact,
} from '../features/primers/public/primer-artifact';
import { parseIdtOligoNotation } from '../features/primers/public/oligo-modifications';
import { serializeEntityArtifact } from '../features/lims/public/entity-artifact';

async function primer(notation = '/5Phos/acgtACGTacgtACGTacgt/3SpC3/') {
  const parsed = parseIdtOligoNotation(notation);
  if (parsed.errors.length) throw Error(JSON.stringify(parsed.errors));
  return buildPrimerArtifact({
    id: 'primer-native',
    catalogNumber: 'PR-000001',
    name: 'Native primer',
    sequence: parsed.bases,
    ...(parsed.composition ? { oligo: parsed.composition } : {}),
    workspaceRoot: '/workspace',
    artifactPath: '/workspace/native.primer.json',
    source: 'manual',
  });
}
function define(format: string, text: string) {
  return defineScientificFile({ representation: { format, text } }, scientificNativeCodecs);
}
const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('product-owned native scientific codecs', () => {
  it('retains anchored chemistry, recorded calculations and unsupported fields while separating display edits from binding inputs', async () => {
    const artifact = await primer();
    const raw = {
      ...artifact,
      unsupportedSource: { preserve: ['raw', 7] },
      metadata: { ...artifact.metadata, unknownSetting: 'keep' },
    };
    const text = JSON.stringify(raw);
    const original = define('primer-v2', text);
    expect(original.nativeResourceId).toBe(artifact.id);
    expect(original.text).toBe(text);
    expect(original.document).toMatchObject({
      kind: 'primer',
      bases: artifact.sequence.bases,
      modifications: artifact.oligo?.modifications.map((modification) => ({
        code: modification.chemistryId,
        anchor: modification.anchor,
        details: { vendorCode: modification.vendorCode },
      })),
      fields: {
        computed: artifact.computed,
        nativeExtras: {
          record: { unsupportedSource: { preserve: ['raw', 7] } },
          metadata: { unknownSetting: 'keep' },
        },
      },
    });
    const renamed = define(
      'primer-v2',
      JSON.stringify({
        ...raw,
        name: 'Another name',
        artifactRevision: artifact.artifactRevision + 1,
        metadata: {
          ...raw.metadata,
          actor: 'someone else',
          updatedAt: '2026-10-07T00:00:00.000Z',
          notes: 'Display notes',
        },
      })
    );
    expect(renamed.blob.hash).not.toBe(original.blob.hash);
    expect(renamed.bindingInputHash).toBe(original.bindingInputHash);
    const alteredChemistry = define(
      'primer-v2',
      serializePrimerArtifact(await primer('/5Phos/acgtACGTacgtACGTacgt/3InvdT/'))
    );
    expect(alteredChemistry.bindingInputHash).not.toBe(
      define('primer-v2', serializePrimerArtifact(artifact)).bindingInputHash
    );
    const customChange = define(
      'primer-v2',
      JSON.stringify({ ...raw, unsupportedSource: { preserve: ['changed', 7] } })
    );
    expect(customChange.bindingInputHash).not.toBe(original.bindingInputHash);
  });
  it('refuses duplicate JSON keys and unresolved native bindings instead of silently discarding them', async () => {
    const artifact = await primer();
    expect(() =>
      define(
        'primer-v2',
        serializePrimerArtifact(artifact).replace(
          '"id": "primer-native"',
          '"id": "discarded-id", "id": "primer-native"'
        )
      )
    ).toThrow(/duplicate/iu);
    const bound = {
      ...artifact,
      bindings: [
        {
          id: 'placement',
          relation: 'binds_to_sequence',
          target: {
            documentId: 'closed-target',
            topology: 'linear',
            length: 100,
            fileContentHash: 'sha256:' + 'a'.repeat(64),
            normalizedSequenceHash: 'sha256:' + 'b'.repeat(64),
          },
          coordinates: { system: 'zero_based_half_open', start: 10, end: 30, strand: 1 },
          source: 'manual',
        },
      ],
    };
    const text = JSON.stringify(bound);
    const defined = define('primer-v2', text);
    const refName = must(parseRefName('accepted'));
    const graph = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('native-placement-boundary')),
      acceptedRef: refName,
    });
    const rejected = applyScientificBatch({
      graph,
      refName,
      operationId: must(parseOperationId('missing-native-closure')),
      expectedHead: null,
      codecs: scientificNativeCodecs,
      readBlob: () => new TextEncoder().encode(text),
      mutations: [
        {
          kind: 'create-resource',
          resourceId: must(parseResourceId(artifact.id)),
          path: must(parseWorkspacePath('native.primer.json')),
          state: defined.state,
          origin: { kind: 'created' },
        },
      ],
    });
    expect(rejected.kind).toBe('rejected');
  });
  it('preserves legacy strain import provenance and custom values, and refuses other entity kinds or unresolved descent', () => {
    const artifact = {
      schema: 'waypoint.entity.v1' as const,
      id: 'strain-native',
      kind: 'strain',
      name: 'BY4741',
      fields: {
        species: 'Saccharomyces cerevisiae',
        genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0',
        custom: { growthMedia: ['YPD', 'SC-Ura'] },
      },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      relationships: [],
      source: {
        recordId: 'source-row-12',
        sourceName: 'strain-sheet.csv',
        sourceKind: 'csv' as const,
        sourceRow: 12,
        values: { originalGenotype: 'parent stock' },
      },
    };
    const text = serializeEntityArtifact(artifact);
    expect(define('strain-entity-v1', text)).toMatchObject({
      nativeResourceId: artifact.id,
      text,
      document: {
        kind: 'strain',
        taxon: artifact.fields.species,
        fields: { values: artifact.fields, source: artifact.source },
      },
    });
    expect(() =>
      define('strain-entity-v1', serializeEntityArtifact({ ...artifact, kind: 'protein' }))
    ).toThrow(/strain record/iu);
    expect(() =>
      define(
        'strain-entity-v1',
        serializeEntityArtifact({
          ...artifact,
          relationships: [
            {
              type: 'descends_from',
              fromEntityId: artifact.id,
              toEntityId: 'missing-parent',
              payload: {},
            },
          ],
        })
      )
    ).toThrow(/pinned relationship migration/iu);
    const plannedText = serializeEntityArtifact({
      ...artifact,
      relationships: [
        {
          type: 'has_genome',
          fromEntityId: artifact.id,
          toEntityId: 'closed-genome',
          payload: { assertion: 'planned', source: { preserve: ['genome proposal', 7] } },
        },
      ],
    });
    const defined = define('strain-entity-v1', plannedText);
    for (const confidence of ['WGS_verified', 'partially_verified'])
      expect(() =>
        define(
          'strain-entity-v1',
          serializeEntityArtifact({
            ...artifact,
            relationships: [
              {
                type: 'has_genome',
                fromEntityId: artifact.id,
                toEntityId: 'closed-genome',
                payload: { assertion: 'planned', confidence },
              },
            ],
          })
        )
      ).toThrow(/physical evidence/iu);
    const refName = must(parseRefName('accepted'));
    const graph = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('native-strain-boundary')),
      acceptedRef: refName,
    });
    expect(
      applyScientificBatch({
        graph,
        refName,
        operationId: must(parseOperationId('missing-native-strain-closure')),
        expectedHead: null,
        codecs: scientificNativeCodecs,
        readBlob: () => new TextEncoder().encode(plannedText),
        mutations: [
          {
            kind: 'create-resource',
            resourceId: must(parseResourceId(artifact.id)),
            path: must(parseWorkspacePath('strain.entity.json')),
            state: defined.state,
            origin: { kind: 'created' },
          },
        ],
      }).kind
    ).toBe('rejected');
  });
});
