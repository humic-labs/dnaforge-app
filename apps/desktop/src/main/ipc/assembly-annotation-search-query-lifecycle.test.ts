import { describe, expect, it } from 'vitest';

import {
  AssemblyAnnotationSearchQueryLifecycle,
  GenomeSearchQueryCapacity,
  assemblyAnnotationSearchQueryLifecycle,
  assemblyProteinSearchQueryLifecycle,
  sequenceSearchQueryLifecycle,
} from './assembly-annotation-search-query-lifecycle';

describe('assembly annotation search main-process lifecycle', () => {
  it('keeps parallel annotation, protein, and sequence authorities isolated', () => {
    assemblyAnnotationSearchQueryLifecycle.dispose();
    assemblyProteinSearchQueryLifecycle.dispose();
    sequenceSearchQueryLifecycle.dispose();

    const annotation = assemblyAnnotationSearchQueryLifecycle.begin(5, 'find-a', 'annotation-1');
    const protein = assemblyProteinSearchQueryLifecycle.begin(5, 'find-a', 'protein-1');
    const sequence = sequenceSearchQueryLifecycle.begin(5, 'find-a', 'sequence-1');

    expect(annotation.signal.aborted).toBe(false);
    expect(protein.signal.aborted).toBe(false);
    expect(sequence.signal.aborted).toBe(false);

    const annotationSuccessor = assemblyAnnotationSearchQueryLifecycle.begin(
      5,
      'find-a',
      'annotation-2'
    );
    expect(annotation.signal.aborted).toBe(true);
    expect(annotationSuccessor.signal.aborted).toBe(false);
    expect(protein.signal.aborted).toBe(false);
    expect(sequence.signal.aborted).toBe(false);

    assemblyAnnotationSearchQueryLifecycle.dispose();
    assemblyProteinSearchQueryLifecycle.dispose();
    sequenceSearchQueryLifecycle.dispose();
    annotation.complete();
    annotationSuccessor.complete();
    protein.complete();
    sequence.complete();
  });

  it('makes each WebContents+client latest-wins while isolating distinct clients', () => {
    const lifecycle = new AssemblyAnnotationSearchQueryLifecycle();
    const first = lifecycle.begin(7, 'find-a', 'probe-1');
    const otherClient = lifecycle.begin(7, 'find-b', 'probe-1');
    const successor = lifecycle.begin(7, 'find-a', 'probe-2');

    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(successor.signal.aborted).toBe(false);
    expect(otherClient.signal.aborted).toBe(false);
    expect(lifecycle.activeCountForTests()).toBe(2);
    expect(lifecycle.unsettledCountForTests()).toBe(3);

    first.complete();
    otherClient.complete();
    successor.complete();
  });

  it('requires both exact identities and retains cancelled capacity until settlement', () => {
    const capacity = new GenomeSearchQueryCapacity(1, 1);
    const lifecycle = new AssemblyAnnotationSearchQueryLifecycle(capacity);
    const successor = lifecycle.begin(9, 'find-a', 'probe-2');

    expect(lifecycle.cancel(9, 'find-a', 'probe-1')).toBe(false);
    expect(lifecycle.cancel(9, 'find-b', 'probe-2')).toBe(false);
    expect(successor.signal.aborted).toBe(false);
    expect(lifecycle.cancel(9, 'find-a', 'probe-2')).toBe(true);
    expect(successor.signal.aborted).toBe(true);
    expect(lifecycle.activeCountForTests()).toBe(0);
    expect(capacity.activeCountForTests()).toBe(1);
    expect(() => lifecycle.begin(9, 'find-a', 'probe-3')).toThrow(
      'Active search query capacity is full'
    );

    successor.complete();
    const replacement = lifecycle.begin(9, 'find-a', 'probe-3');
    replacement.complete();
    expect(capacity.activeCountForTests()).toBe(0);
  });

  it('retains search capacity after caller settlement until bound worker work physically settles', () => {
    const capacity = new GenomeSearchQueryCapacity(1, 1);
    const lifecycle = new AssemblyAnnotationSearchQueryLifecycle(capacity);
    const search = lifecycle.begin(9, 'find-a', 'probe-physical');

    search.physicalLifecycle.started();
    search.complete();

    expect(lifecycle.activeCountForTests()).toBe(0);
    expect(lifecycle.unsettledCountForTests()).toBe(1);
    expect(capacity.activeCountForTests()).toBe(1);
    expect(() => lifecycle.begin(9, 'find-a', 'probe-blocked')).toThrow(
      'Active search query capacity is full'
    );

    search.physicalLifecycle.settled();
    expect(lifecycle.unsettledCountForTests()).toBe(0);
    expect(capacity.activeCountForTests()).toBe(0);
    const replacement = lifecycle.begin(9, 'find-a', 'probe-replacement');
    replacement.complete();
  });

  it('cancels every client owned by a destroyed WebContents', () => {
    const lifecycle = new AssemblyAnnotationSearchQueryLifecycle();
    const first = lifecycle.begin(11, 'find-a', 'probe-1');
    const second = lifecycle.begin(11, 'find-b', 'probe-1');
    const otherWindow = lifecycle.begin(12, 'find-a', 'probe-1');

    lifecycle.cancelWebContents(11);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(otherWindow.signal.aborted).toBe(false);
    expect(lifecycle.activeCountForTests()).toBe(1);

    first.complete();
    second.complete();
    otherWindow.complete();
  });

  it('shares finite authority across search kinds without transferring unsettled ownership', () => {
    const capacity = new GenomeSearchQueryCapacity(3, 4);
    const annotation = new AssemblyAnnotationSearchQueryLifecycle(capacity);
    const protein = new AssemblyAnnotationSearchQueryLifecycle(capacity);
    const sequence = new AssemblyAnnotationSearchQueryLifecycle(capacity);

    const first = annotation.begin(21, 'find-a', 'annotation-1');
    const second = protein.begin(21, 'find-a', 'protein-1');
    const successor = annotation.begin(21, 'find-a', 'annotation-2');
    expect(first.signal.aborted).toBe(true);
    expect(successor.signal.aborted).toBe(false);
    expect(capacity.activeCountForTests()).toBe(3);
    expect(() => sequence.begin(21, 'find-a', 'sequence-1')).toThrow(
      'Renderer search query capacity is full'
    );

    const otherWindow = sequence.begin(22, 'find-a', 'sequence-1');
    expect(() => sequence.begin(23, 'find-a', 'sequence-1')).toThrow(
      'Active search query capacity is full'
    );

    first.complete();
    const admitted = sequence.begin(23, 'find-a', 'sequence-2');
    expect(capacity.activeCountForTests()).toBe(4);

    successor.complete();
    second.complete();
    otherWindow.complete();
    admitted.complete();
    expect(capacity.activeCountForTests()).toBe(0);
  });
});
