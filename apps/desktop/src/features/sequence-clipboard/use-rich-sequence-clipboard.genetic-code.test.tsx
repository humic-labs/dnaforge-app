import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { useToastStore } from '../../stores/toast-store';
import { useRichSequenceClipboardStore } from './store';
import { buildRichSequenceFragmentFromSelection } from './rich-sequence-clipboard';
import { useRichSequenceClipboard } from './use-rich-sequence-clipboard';

const BASES = 'ATGTGAAAATTTGGGCCCAAATTTGGGTAA';

function cds(overrides: Partial<Annotation> = {}): Annotation {
  return { name: 'cox1', type: 'CDS', start: 1, end: 30, direction: 1, ...overrides };
}

function destination(geneticCode?: number): AnnotatedSequence {
  return {
    id: 'dest',
    name: 'plasmid',
    sequence: BASES,
    length: BASES.length,
    annotations: geneticCode ? [cds({ qualifiers: { transl_table: [String(geneticCode)] } })] : [],
    circular: false,
  };
}

function cacheMitochondrialCopy(): string {
  const { fragment } = buildRichSequenceFragmentFromSelection({
    sourceId: 'src',
    sourceName: 'yeast chrMT',
    sourceSequence: BASES,
    sourceAnnotations: [cds()],
    sourceGeneticCode: 3,
    range: { start: 0, end: BASES.length },
    orientation: 'forward',
  });
  useRichSequenceClipboardStore.getState().setCopiedRegion(fragment);
  return fragment.sequence;
}

function renderClipboard(
  sequence: AnnotatedSequence,
  onReReadPastedFeatures?: (rewrite: unknown) => void
) {
  return renderHook(() =>
    useRichSequenceClipboard({
      documentId: 'dest',
      displayName: 'plasmid',
      sequence,
      primerRecords: [],
      ...(onReReadPastedFeatures
        ? { onReReadPastedFeatures: onReReadPastedFeatures as never }
        : {}),
    })
  );
}

describe('pasting across a genetic-code boundary', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
    useRichSequenceClipboardStore.getState().clear();
  });

  it('warns, naming both codes, and still inserts the fragment', () => {
    const text = cacheMitochondrialCopy();
    const { result } = renderClipboard(destination(1), vi.fn());

    const fragment = result.current.resolvePasteFragment(text);

    expect(fragment).not.toBeNull();
    expect(fragment!.sequence).toBe(text);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.type).toBe('warning');
    expect(toast.message).toContain('3 — Yeast Mitochondrial');
    expect(toast.message).toContain('1 — Standard');
    expect(toast.duration).toBe(0);
  });

  it('keeps the source code on the pasted feature so the protein is unchanged', () => {
    const text = cacheMitochondrialCopy();
    const { result } = renderClipboard(destination(1), vi.fn());
    const fragment = result.current.resolvePasteFragment(text);
    expect(fragment!.annotations[0].qualifiers?.transl_table).toEqual(['3']);
  });

  it('offers the re-read action, which reaches the caller with a working rewrite', () => {
    const text = cacheMitochondrialCopy();
    const applyRewrite = vi.fn();
    const { result } = renderClipboard(destination(1), applyRewrite);
    result.current.resolvePasteFragment(text);

    const [toast] = useToastStore.getState().toasts;
    expect(toast.actions?.[0]?.label).toBe("Re-read under this file's code");
    toast.actions![0].onClick();

    expect(applyRewrite).toHaveBeenCalledTimes(1);
    const rewrite = applyRewrite.mock.calls[0][0] as (
      annotations: readonly Annotation[],
      range: { start: number; end: number } | null
    ) => Annotation[] | null;
    const rewritten = rewrite(
      [{ ...cds({ start: 1, end: 30 }), qualifiers: { transl_table: ['3'] } }],
      { start: 0, end: 30 }
    );
    expect(rewritten![0].qualifiers).toBeUndefined();
  });

  it('omits the action when the surface cannot apply it', () => {
    const text = cacheMitochondrialCopy();
    const { result } = renderClipboard(destination(1));
    result.current.resolvePasteFragment(text);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.actions).toBeUndefined();
    expect(toast.message).toContain('3 — Yeast Mitochondrial');
  });

  it('says nothing when the destination reads by the same code', () => {
    const text = cacheMitochondrialCopy();
    const { result } = renderClipboard(destination(3), vi.fn());
    expect(result.current.resolvePasteFragment(text)).not.toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('exposes the destination code it resolved', () => {
    const { result } = renderClipboard(destination(3));
    expect(result.current.geneticCode).toBe(3);
  });
});
