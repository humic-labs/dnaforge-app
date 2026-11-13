import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';

import { useSequenceStore } from '../../sequence/store';
import { buildSelectionDescriptor } from './build';
import { isSelectionDescriptor } from './types';

const REPO_ROOT = join(__dirname, '../../../../../..');
const PUC19_PATH = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
const puc19: AnnotatedSequence = parseGenBankFull(readFileSync(PUC19_PATH, 'utf8'));

let seededDocumentIds: string[] = [];

function seed(documentId: string, sequence: AnnotatedSequence = puc19): number {
  useSequenceStore.getState().setSequence(documentId, sequence);
  seededDocumentIds.push(documentId);
  return useSequenceStore.getState().getVersion(documentId);
}

afterEach(() => {
  const store = useSequenceStore.getState();
  for (const documentId of seededDocumentIds) store.clearSequence(documentId);
  seededDocumentIds = [];
});

describe('buildSelectionDescriptor — unavailable marker', () => {
  it('returns unavailable when the document has no resident parsed sequence', () => {
    const result = buildSelectionDescriptor({
      kind: 'sequence_region',
      documentId: 'sequence-document-not-open',
      range: { start: 1, end: 10 },
    });
    expect(result.kind).toBe('unavailable');
    expect(isSelectionDescriptor(result)).toBe(false);
  });
});

describe('buildSelectionDescriptor — empty_selection markers', () => {
  it('returns empty_selection (no-range) for a region request without a range', () => {
    const documentId = 'sequence-document-region-no-range';
    seed(documentId);
    const result = buildSelectionDescriptor({ kind: 'sequence_region', documentId });
    expect(result.kind).toBe('empty_selection');
    expect(result).toMatchObject({ reason: 'no-range' });
  });

  it('returns empty_selection (no-range) for an invalid (< 1) range', () => {
    const documentId = 'sequence-document-region-bad-range';
    seed(documentId);
    const result = buildSelectionDescriptor({
      kind: 'sequence_region',
      documentId,
      range: { start: 0, end: 10 },
    });
    expect(result.kind).toBe('empty_selection');
  });

  it('returns empty_selection (no-annotation-at-range) when no feature matches', () => {
    const documentId = 'sequence-document-annotation-gap';
    const range = { start: 1, end: 50 };
    const annotations = puc19.annotations.filter(({ type }) => type.toLowerCase() !== 'source');
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations.every(({ start, end }) => end < range.start || start > range.end)).toBe(
      true
    );
    seed(documentId, { ...puc19, annotations });
    const result = buildSelectionDescriptor({
      kind: 'annotation',
      documentId,
      range,
    });
    expect(result.kind).toBe('empty_selection');
    expect(result).toMatchObject({ reason: 'no-annotation-at-range' });
  });
});

describe('buildSelectionDescriptor — routing + sourceVersion', () => {
  it('routes a valid range to the sequence_region builder', () => {
    const documentId = 'sequence-document-route-region';
    const version = seed(documentId);
    const result = buildSelectionDescriptor({
      kind: 'sequence_region',
      documentId,
      range: { start: 615, end: 938 },
    });
    expect(result.kind).toBe('sequence_region');
    expect(isSelectionDescriptor(result)).toBe(true);
    if (isSelectionDescriptor(result)) {
      expect(result.sourceVersion).toBe(version);
      expect(result.locator.documentId).toBe(documentId);
    }
  });

  it('routes an annotation request to the annotation builder', () => {
    const documentId = 'sequence-document-route-annotation';
    seed(documentId);
    const result = buildSelectionDescriptor({
      kind: 'annotation',
      documentId,
      range: { start: 615, end: 938 },
    });
    expect(result.kind).toBe('annotation');
  });

  it('routes a whole_entity request to the whole_entity builder', () => {
    const documentId = 'sequence-document-route-whole';
    const version = seed(documentId);
    const result = buildSelectionDescriptor({ kind: 'whole_entity', documentId });
    expect(result.kind).toBe('whole_entity');
    if (result.kind === 'whole_entity') {
      expect(result.sourceVersion).toBe(version);
      expect(result.bases).toBe('never');
      expect(result.measured.length).toBe(puc19.length);
      expect(result.measured.featureCount).toBe(puc19.annotations.length);
      expect(result.measured.metadataAvailable.definition).toBe(true);
      expect(result.measured.metadataAvailable.organism).toBe(false);
      expect(result.measured.metadataAvailable.taxonId).toBe(false);
      expect(result.measured.functionalGistIsInferred).toBe(true);
    }
  });
});
