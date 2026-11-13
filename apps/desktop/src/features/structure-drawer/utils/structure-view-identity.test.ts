// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs } from '../../page/embeds/structure3d/types';
import type { StructureDrawerRequest } from '../types/structure-drawer';
import {
  createStructureBinding,
  createStructureViewIdentity,
  resolveLegacyStructureTarget,
} from './structure-view-identity';

const COORDINATES: Structure3dAttrs = {
  source: 'pdb',
  sourceId: 'RCSB:1ABC:ENTRY',
  providerIdentityKey: 'RCSB:1ABC:ENTRY',
  pdbId: '1ABC',
  pdbEntityId: '1',
  labelAsymIds: ['A'],
  authAsymIds: ['X'],
};

function request(input: {
  path: string;
  featureKey: string;
  digest: string;
  translation?: string;
  residueFeatureKey?: string;
}): StructureDrawerRequest {
  const translation = input.translation ?? 'MPEPTIDE';
  const residueFeatureKey = input.residueFeatureKey ?? input.featureKey;
  return {
    translation,
    identityRequestKey: `req:${input.featureKey}:protein-sequence:v2:${input.digest}`,
    entityId: input.path,
    cdsLabel: input.featureKey,
    cdsBounds: { cdsStart: 10, cdsEnd: 33, strand: 1 },
    residueMolecule: {
      moleculeId: `translated-cds:${input.path}:${residueFeatureKey}:11-34:1`,
      moleculeKind: 'translated-cds',
      label: residueFeatureKey,
    },
    hints: {},
    proteinIdentity: {
      schemaVersion: 2,
      feature: {
        kind: 'sequence_feature',
        entityId: input.path,
        featureKey: input.featureKey,
        label: input.featureKey,
        location: {
          segments: [{ start0: 10, end0: 33, strand: 1 }],
          circular: false,
        },
        hintSummary: {
          dbXrefCount: 0,
          hasProteinId: false,
          hasLocusTag: false,
          hasGeneName: false,
        },
        evidenceIds: [],
      },
      sequence: {
        kind: 'protein_sequence',
        schemaVersion: 2,
        identityKey: `protein-sequence:v2:${input.digest}`,
        canonicalizationStatus: 'renderer_preflight',
        lookupSequence: translation,
        canonicalLookupSequence: translation,
        length: translation.length,
        source: 'qualifier_translation',
        startCodon: 'ATG',
        initiatorNormalized: false,
        digests: { sha256: input.digest },
        evidenceIds: [],
      },
      externalProteins: [],
      resolutionSets: [],
      structures: [],
      evidence: [],
    },
  };
}

describe('structure view identity', () => {
  it('uses the request-captured residue molecule for the pinned polymer revision', () => {
    const binding = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({
        path: '/project/source.gb',
        featureKey: 'feature:v2:stable-hash',
        residueFeatureKey: 'DNA primase',
        digest: 'a'.repeat(64),
      }),
      linkOwnerId: 'owner-a',
    });

    expect(binding.polymerRevision).toMatchObject({
      moleculeId: 'translated-cds:/project/source.gb:DNA primase:11-34:1',
      moleculeKind: 'translated-cds',
      translation: { featureId: 'DNA primase' },
    });
  });

  it('isolates bindings for two owners that share one coordinate artifact', () => {
    const left = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({
        path: '/project-a/source.gb',
        featureKey: 'cds:a',
        digest: 'a'.repeat(64),
      }),
      linkOwnerId: 'owner-a',
    });
    const right = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({
        path: '/project-b/source.gb',
        featureKey: 'cds:b',
        digest: 'a'.repeat(64),
      }),
      linkOwnerId: 'owner-b',
    });

    expect(left.structureId).toBe(right.structureId);
    expect(left.bindingId).not.toBe(right.bindingId);
    expect(left.polymerRevision.sequenceDigestSha256).toBe(
      right.polymerRevision.sequenceDigestSha256
    );
    expect(left.linkOwnerId).toBe('owner-a');
    expect(right.linkOwnerId).toBe('owner-b');
  });

  it('changes the binding for a same-length polymer revision edit', () => {
    const before = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({ path: '/project/source.gb', featureKey: 'cds:a', digest: 'a'.repeat(64) }),
      linkOwnerId: 'owner-a',
    });
    const after = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({ path: '/project/source.gb', featureKey: 'cds:a', digest: 'b'.repeat(64) }),
      linkOwnerId: 'owner-a',
    });

    expect(before.polymerRevision.moleculeId).toBe(after.polymerRevision.moleculeId);
    expect(before.polymerRevision.sequenceDigestSha256).not.toBe(
      after.polymerRevision.sequenceDigestSha256
    );
    expect(before.bindingId).not.toBe(after.bindingId);
  });

  it('keeps one logical view stable across drawer and tab renderer instances', () => {
    const binding = createStructureBinding({
      structureId: 'structure:RCSB:1ABC:ENTRY',
      attrs: COORDINATES,
      request: request({ path: '/project/source.gb', featureKey: 'cds:a', digest: 'a'.repeat(64) }),
      linkOwnerId: 'owner-a',
    });
    const first = createStructureViewIdentity(binding, 'drawer-request-7');
    const second = createStructureViewIdentity(binding, 'drawer-request-7');

    expect(first).toEqual(second);
    expect(first.bindingId).toBe(binding.bindingId);
    expect(first.structureViewId).not.toBe(binding.structureId);
  });

  it('fails closed when a legacy structureId resolves to multiple bindings', () => {
    const bindings = ['owner-a', 'owner-b'].map((linkOwnerId) =>
      createStructureBinding({
        structureId: 'structure:RCSB:1ABC:ENTRY',
        attrs: COORDINATES,
        request: request({
          path: `/project/${linkOwnerId}.gb`,
          featureKey: `cds:${linkOwnerId}`,
          digest: 'a'.repeat(64),
        }),
        linkOwnerId,
      })
    );

    expect(resolveLegacyStructureTarget(bindings, 'structure:RCSB:1ABC:ENTRY')).toEqual({
      status: 'ambiguous',
      structureId: 'structure:RCSB:1ABC:ENTRY',
      candidates: bindings.map(({ bindingId }) => bindingId).sort(),
    });
    expect(resolveLegacyStructureTarget([bindings[0]], 'structure:RCSB:1ABC:ENTRY')).toEqual({
      status: 'resolved',
      binding: bindings[0],
    });
  });
});
