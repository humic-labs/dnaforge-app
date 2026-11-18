import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyNativeStrainRepresentation,
  nativeStrainRelationshipOwnership,
  parseNativeStrainRelationships,
  UnsupportedNativeStrainRepresentationError,
} from './native-references';
import {
  serializeEntityArtifact,
  type EntityArtifactRelationshipV1,
} from './shared/entity-artifact';

const probe = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('./native-json', async (importOriginal) => {
  const original = await importOriginal<typeof import('./native-json')>();
  return {
    ...original,
    parseNativeJson: (text: string) => {
      if (probe.error) throw probe.error;
      return original.parseNativeJson(text);
    },
  };
});

function strain(relationship: EntityArtifactRelationshipV1, kind = 'strain'): string {
  return serializeEntityArtifact({
    schema: 'waypoint.entity.v1',
    id: 's',
    kind,
    name: 'Source',
    fields: {},
    registrationStatus: 'tracked',
    domainStatus: null,
    source: { type: 'manual', values: {} },
    relationships: [relationship],
  });
}
const planned = {
  type: 'derives_from',
  fromEntityId: 's',
  toEntityId: 'parent',
  payload: { assertion: 'planned' },
};
afterEach(() => {
  probe.error = null;
});

describe('native strain representation admission', () => {
  it('preserves the strict native relationship identity and claims', () => {
    const claims = [
      {
        resourceId:
          'native-strain-link-a795b01a4e8edef58cb542ba8f7163f060e0b80e09f5bed922967c6f412789c1',
        strainId: 's',
        kind: 'strain-descent',
        targetId: 'parent',
        targetRevisionId: null,
        fields: { nativeRelationshipType: 'derives_from', payload: { assertion: 'planned' } },
      },
    ];
    expect(parseNativeStrainRelationships(strain(planned))).toEqual(claims);
    expect(classifyNativeStrainRepresentation(strain(planned))).toEqual({ kind: 'native', claims });
  });

  it.each([
    { name: 'omitted assertion', relationship: { ...planned, payload: {} } },
    {
      name: 'observed assertion',
      relationship: { ...planned, payload: { assertion: 'observed', original: [false, 0] } },
    },
    {
      name: 'generic association',
      relationship: { ...planned, type: 'associated_with', payload: { source: 'retained' } },
    },
    { name: 'Registry reference', relationship: { ...planned, type: 'references', payload: {} } },
    {
      name: 'opaque legacy pin',
      relationship: {
        ...planned,
        payload: { assertion: 'planned', targetRevisionId: 'old opaque reference' },
      },
    },
    {
      name: 'legacy verification report',
      relationship: {
        ...planned,
        type: 'has_genome',
        payload: { assertion: 'planned', confidence: 'WGS_verified' },
      },
    },
  ])('retains $name as legacy without relaxing strict native admission', ({ relationship }) => {
    const text = strain(relationship);
    expect(() => parseNativeStrainRelationships(text)).toThrow(
      UnsupportedNativeStrainRepresentationError
    );
    expect(classifyNativeStrainRepresentation(text)).toMatchObject({
      kind: 'legacy',
      reason: { code: 'UNSUPPORTED_NATIVE_STRAIN_REPRESENTATION' },
    });
  });

  it('keeps malformed, wrong-kind and unexpected parser failures outside legacy classification', () => {
    expect(() => classifyNativeStrainRepresentation('{}')).toThrow();
    expect(() => classifyNativeStrainRepresentation(strain(planned, 'protein'))).toThrow(TypeError);
    try {
      classifyNativeStrainRepresentation(strain(planned, 'protein'));
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnsupportedNativeStrainRepresentationError);
    }
    probe.error = new TypeError('Unexpected codec failure');
    expect(() => classifyNativeStrainRepresentation(strain(planned))).toThrow(probe.error);
  });

  it.each([
    { type: 'derives_from', owner: 'from', target: 'to', kind: 'strain-descent' },
    { type: 'has_genome', owner: 'from', target: 'to', kind: 'strain-sequence' },
    { type: 'carried_by', owner: 'to', target: 'from', kind: 'strain-sequence' },
  ])('uses one ownership mapping for $type', ({ type, owner, target, kind }) => {
    expect(
      nativeStrainRelationshipOwnership({ type, fromEntityId: 'from', toEntityId: 'to' })
    ).toEqual({ strainId: owner, targetId: target, kind });
    expect(
      nativeStrainRelationshipOwnership({
        type: 'references',
        fromEntityId: 'from',
        toEntityId: 'to',
      })
    ).toBeNull();
  });
});
