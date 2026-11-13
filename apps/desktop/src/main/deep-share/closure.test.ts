import { describe, expect, it } from 'vitest';
import { buildDeepShareArtifactClosure, DeepShareClosureError } from './closure';

describe('buildDeepShareArtifactClosure', () => {
  it('follows confirmed scientific relations in both directions and stops at cycles', () => {
    const closure = buildDeepShareArtifactClosure({
      rootArtifactId: 'sequence-1',
      entities: [
        { id: 'design-1', type: 'design', name: 'Design' },
        { id: 'sequence-1', type: 'sequence', name: 'Sequence' },
        { id: 'primer-1', type: 'primer', name: 'Primer' },
      ],
      links: [
        {
          sourceArtifactId: 'design-1',
          relation: 'produces',
          targetArtifactId: 'sequence-1',
          confidence: 'confirmed',
        },
        {
          sourceArtifactId: 'primer-1',
          relation: 'binds_to_sequence',
          targetArtifactId: 'sequence-1',
          confidence: 'confirmed',
        },
        {
          sourceArtifactId: 'sequence-1',
          relation: 'derived_from',
          targetArtifactId: 'design-1',
          confidence: 'confirmed',
        },
      ],
    });

    expect(closure.artifacts.map((artifact) => artifact.id)).toEqual([
      'design-1',
      'primer-1',
      'sequence-1',
    ]);
    expect(closure.artifacts.find((artifact) => artifact.id === 'sequence-1')).toMatchObject({
      required: true,
    });
    expect(closure.relationships).toHaveLength(3);
    expect(closure.omissions).toEqual([]);
  });

  it('reports unconfirmed, unsupported, and unresolved edges without following them', () => {
    const closure = buildDeepShareArtifactClosure({
      rootArtifactId: 'sequence-1',
      entities: [
        { id: 'sequence-1', type: 'sequence', name: 'Sequence' },
        { id: 'suggested-primer', type: 'primer', name: 'Suggested primer' },
        { id: 'context-file', type: 'file', name: 'Context file' },
      ],
      links: [
        {
          sourceArtifactId: 'suggested-primer',
          relation: 'binds_to_sequence',
          targetArtifactId: 'sequence-1',
          confidence: 'suggested',
        },
        {
          sourceArtifactId: 'sequence-1',
          relation: 'created_beside',
          targetArtifactId: 'context-file',
          confidence: 'confirmed',
        },
        {
          sourceArtifactId: 'sequence-1',
          relation: 'references',
          targetArtifactId: 'missing-file',
          confidence: 'confirmed',
        },
      ],
    });

    expect(closure.artifacts.map((artifact) => artifact.id)).toEqual(['sequence-1']);
    expect(closure.omissions).toEqual([
      expect.objectContaining({ code: 'UNCONFIRMED_RELATION', subject: 'suggested-primer' }),
      expect.objectContaining({ code: 'UNRESOLVED_TARGET', subject: 'missing-file' }),
      expect.objectContaining({ code: 'UNSUPPORTED_RELATION', subject: 'created_beside' }),
    ]);
  });

  it('fails when the selected root is not an active catalog entity', () => {
    expect(() =>
      buildDeepShareArtifactClosure({
        rootArtifactId: 'missing',
        entities: [],
        links: [],
      })
    ).toThrow(new DeepShareClosureError('ROOT_NOT_FOUND', 'Deep Share root was not found.'));
  });
});
