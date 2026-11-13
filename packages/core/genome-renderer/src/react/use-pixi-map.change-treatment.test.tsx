// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AnnotationChangeDecoration, LinearSequencePresentation } from '../types';
import { usePixiMap } from './use-pixi-map';

describe('normal WebGL change presentation transport', () => {
  it('transports and clears native annotation and nucleotide presentation without replacing the document', () => {
    const changes: ReadonlyMap<number, AnnotationChangeDecoration> = new Map([
      [7, { kind: 'modified', ranges: [{ start: 2, end: 4 }] }],
    ]);
    const presentation: LinearSequencePresentation = {
      alignedQuery: 'AC--GT',
      showReverseComplement: false,
    };
    const { result, rerender } = renderHook<
      ReturnType<typeof usePixiMap>,
      {
        changes?: ReadonlyMap<number, AnnotationChangeDecoration>;
        presentation?: LinearSequencePresentation;
      }
    >(
      ({
        changes,
        presentation,
      }: {
        changes?: ReadonlyMap<number, AnnotationChangeDecoration>;
        presentation?: LinearSequencePresentation;
      }) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 240,
          annotationChangeDecorations: changes,
          sequencePresentation: presentation,
        }),
      { initialProps: { changes, presentation } }
    );
    expect(result.current.handle.getState()?.annotationChangeDecorations).toBe(changes);
    expect(result.current.handle.getState()?.sequencePresentation).toBe(presentation);
    rerender({ changes: undefined, presentation: undefined });
    expect(result.current.handle.getState()?.annotationChangeDecorations).toBeUndefined();
    expect(result.current.handle.getState()?.sequencePresentation).toBeUndefined();
  });
});
