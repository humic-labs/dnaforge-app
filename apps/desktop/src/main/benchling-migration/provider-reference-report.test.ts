import { describe, expect, it } from 'vitest';

import type {
  RelationshipResolution,
  RelationshipResolutionClass,
  SourceObject,
} from '../../shared/benchling-migration';
import { summarizeProviderReferenceOutcomes } from './provider-reference-report';

describe('summarizeProviderReferenceOutcomes', () => {
  it('reports each resolution class as the outcome a reader can act on', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'Imported plasmid')],
      resolutions: [
        resolution('rel_1', 'exact', 'seq_AAAAAA'),
        resolution('rel_2', 'unresolved', 'seq_BBBBBB'),
        resolution('rel_3', 'ambiguous', 'seq_CCCCCC'),
        resolution('rel_4', 'external', null),
        resolution('rel_5', 'source_broken', null),
      ],
    });

    expect(summary.counts).toEqual({
      resolved: 1,
      pending: 1,
      ambiguous: 1,
      external: 1,
      source_broken: 1,
    });
    expect(summary.total).toBe(5);
    expect(summary.details.map((detail) => detail.action)).toEqual([
      'none',
      'add_export',
      'review',
      'open_in_benchling',
      'unavailable',
    ]);
  });

  it('reports a target this import brought in as resolved, whatever the export said', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'Imported plasmid')],
      resolutions: [
        resolution('rel_1', 'unresolved', 'seq_AAAAAA'),
        resolution('rel_2', 'unresolved', 'seq_BBBBBB'),
      ],
    });

    expect(summary.counts.resolved).toBe(1);
    expect(summary.counts.pending).toBe(1);
    expect(summary.details.find((d) => d.relationshipId === 'rel_1')).toMatchObject({
      outcome: 'resolved',
      action: 'none',
    });
    expect(summary.details.find((d) => d.relationshipId === 'rel_2')).toMatchObject({
      outcome: 'pending',
      action: 'add_export',
    });
  });

  it('reports an exact-but-absent target as pending, not resolved', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [],
      resolutions: [resolution('rel_1', 'exact', 'seq_AAAAAA')],
    });

    expect(summary.counts.resolved).toBe(0);
    expect(summary.counts.pending).toBe(1);
  });

  it('keeps external and source-broken as source facts regardless of what was imported', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'Imported plasmid')],
      resolutions: [
        resolution('rel_1', 'external', 'seq_AAAAAA'),
        resolution('rel_2', 'source_broken', 'seq_AAAAAA'),
      ],
    });

    expect(summary.counts).toMatchObject({ external: 1, source_broken: 1, resolved: 0 });
  });

  it('reports a heuristic match as ambiguous, never as resolved', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [],
      resolutions: [resolution('rel_1', 'heuristic', 'seq_AAAAAA')],
    });

    expect(summary.counts.resolved).toBe(0);
    expect(summary.counts.ambiguous).toBe(1);
    expect(summary.details[0].action).toBe('review');
  });

  it('moves exactly one reference from pending to resolved when its target arrives', () => {
    const before = summarizeProviderReferenceOutcomes({
      sourceObjects: [],
      resolutions: [
        resolution('rel_1', 'unresolved', 'seq_AAAAAA'),
        resolution('rel_2', 'unresolved', 'seq_BBBBBB'),
      ],
    });
    const after = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'Imported plasmid')],
      resolutions: [
        resolution('rel_1', 'exact', 'seq_AAAAAA'),
        resolution('rel_2', 'unresolved', 'seq_BBBBBB'),
      ],
    });

    expect(before.counts.pending).toBe(2);
    expect(after.counts.pending).toBe(1);
    expect(after.counts.resolved).toBe(1);
    expect(after.total).toBe(before.total);
  });

  it('counts one reference once even when a duplicate resolution row survives', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'Imported plasmid')],
      resolutions: [
        resolution('rel_1', 'exact', 'seq_AAAAAA'),
        resolution('rel_1', 'exact', 'seq_AAAAAA'),
      ],
    });

    expect(summary.total).toBe(1);
    expect(summary.counts.resolved).toBe(1);
    expect(summary.details).toHaveLength(1);
  });

  it('shows a plain display name and the imported object class', () => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', 'pUC19 backbone')],
      resolutions: [resolution('rel_1', 'exact', 'seq_AAAAAA')],
    });

    expect(summary.details[0]).toMatchObject({
      targetStableObjectId: 'seq_AAAAAA',
      title: 'pUC19 backbone',
      objectClass: 'dna_sequence',
      outcome: 'resolved',
    });
  });

  it.each([
    ['a filesystem path', '/Users/someone/Library/Application Support/export.zip'],
    ['markup', '<img src=x onerror=alert(1)>'],
    ['a hidden control character', 'pUC19\u0007 backbone'],
    ['a zero-width joiner', 'pUC19\u200d backbone'],
    ['an unbounded payload', 'x'.repeat(5_000)],
  ])('drops a title carrying %s rather than laundering it', (_label, name) => {
    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [sourceObject('seq_AAAAAA', name)],
      resolutions: [resolution('rel_1', 'exact', 'seq_AAAAAA')],
    });

    expect(summary.details[0].title).toBeNull();
    expect(summary.counts.resolved).toBe(1);
  });

  it('keeps the counts complete when the detail rows are cut', () => {
    const resolutions = Array.from({ length: 12 }, (_unused, index) =>
      resolution(`rel_${String(index).padStart(3, '0')}`, 'unresolved', `seq_TARGET${index}`)
    );

    const summary = summarizeProviderReferenceOutcomes({
      sourceObjects: [],
      resolutions,
      detailLimit: 5,
    });

    expect(summary.details).toHaveLength(5);
    expect(summary.truncated).toBe(true);
    expect(summary.counts.pending).toBe(12);
    expect(summary.total).toBe(12);
  });
});

function resolution(
  relationshipId: string,
  classification: RelationshipResolutionClass,
  targetSourceId: string | null
): RelationshipResolution {
  return {
    relationshipId,
    sourceObjectId: 'etr_NOTEBOOK',
    targetSourceId,
    relationType: 'references',
    classification,
    evidence: [],
    candidateSourceIds: [],
    requiresTargetedRead: false,
    reason: 'test',
  };
}

function sourceObject(stableId: string, name: string): SourceObject {
  return {
    id: stableId,
    stableId,
    sourceType: 'dna_sequence',
    name,
    aliases: [],
    sourceUrl: 'https://benchling.com/example',
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: null,
    relationships: [],
  };
}
