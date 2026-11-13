import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { useToastStore } from '../../stores/toast-store';
import { resetGeneticCodePromptsForTest, useGeneticCodePrompt } from './use-genetic-code-prompt';

function source(qualifiers: Record<string, string[]>): Annotation {
  return { name: 'source', type: 'source', start: 1, end: 9, direction: 0, qualifiers };
}

function record(annotations: Annotation[] = []): AnnotatedSequence {
  return {
    id: 'doc',
    name: 'doc',
    sequence: 'ATGTGAAAA',
    length: 9,
    annotations,
    circular: false,
  };
}

const mitochondrialAndSilent = record([source({ organelle: ['mitochondrion'] })]);

describe('useGeneticCodePrompt', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
    resetGeneticCodePromptsForTest();
  });

  it('asks about an organellar record that declares no code', () => {
    renderHook(() => useGeneticCodePrompt('doc', mitochondrialAndSilent));
    const [toast] = useToastStore.getState().toasts;
    expect(toast.type).toBe('warning');
    expect(toast.message).toContain('mitochondrion');
    expect(toast.message).toContain('standard code');
    expect(toast.duration).toBe(0);
  });

  it('asks once per document, not on every render', () => {
    const { rerender } = renderHook(() => useGeneticCodePrompt('doc', mitochondrialAndSilent));
    rerender();
    rerender();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('does not re-ask after the user dismisses it and reopens the tab', () => {
    const first = renderHook(() => useGeneticCodePrompt('doc', mitochondrialAndSilent));
    first.unmount();
    useToastStore.getState().clearToasts();
    renderHook(() => useGeneticCodePrompt('doc', mitochondrialAndSilent));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stays quiet when the record already declares a code', () => {
    renderHook(() =>
      useGeneticCodePrompt(
        'doc',
        record([
          source({ organelle: ['mitochondrion'] }),
          {
            name: 'cox1',
            type: 'CDS',
            start: 1,
            end: 9,
            direction: 1,
            qualifiers: { transl_table: ['3'] },
          },
        ])
      )
    );
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stays quiet for an ordinary nuclear record', () => {
    renderHook(() => useGeneticCodePrompt('doc', record()));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stays quiet on a read-only document, which the user cannot answer for', () => {
    renderHook(() => useGeneticCodePrompt('doc', mitochondrialAndSilent, { enabled: false }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stays quiet while the document is still loading', () => {
    renderHook(() => useGeneticCodePrompt('doc', null));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
