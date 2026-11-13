/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';
import {
  WorkbenchPrimerOverlay,
  type WorkbenchPrimerOverlayHandle,
} from './WorkbenchPrimerOverlay';

const VIEWPORT_WIDTH = 640;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH;
    },
  });
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

describe('WorkbenchPrimerOverlay', () => {
  it('keeps a live drag primer override across prop redraws until explicitly cleared', async () => {
    const ref = createRef<WorkbenchPrimerOverlayHandle>();
    const canonical = primer('AAAAAA');
    const live = { ...canonical, bases: 'CCCCCC' };

    const { rerender } = render(
      <WorkbenchPrimerOverlay
        ref={ref}
        sequence={'A'.repeat(80)}
        annotations={[]}
        primers={[canonical]}
        pxPerBase={8}
        isCircular={false}
        showReverseComplement={true}
        showPrimers={true}
        scrollLeft={0}
        rowId="primer-live-override"
      />
    );
    await act(async () => {});

    expect(readDrawnBases()).toEqual(['AAAAAA']);

    act(() => {
      ref.current?.applyLiveOverride([live]);
    });
    expect(readDrawnBases()).toEqual(['CCCCCC']);

    rerender(
      <WorkbenchPrimerOverlay
        ref={ref}
        sequence={`T${'A'.repeat(79)}`}
        annotations={[]}
        primers={[canonical]}
        pxPerBase={8}
        isCircular={false}
        showReverseComplement={true}
        showPrimers={true}
        scrollLeft={8}
        rowId="primer-live-override"
      />
    );
    await act(async () => {});

    expect(readDrawnBases()).toEqual(['CCCCCC']);

    act(() => {
      ref.current?.applyLiveOverride(null);
    });
    expect(readDrawnBases()).toEqual(['AAAAAA']);
  });
});

function primer(bases: string): PrimerDisplay {
  return {
    id: 'primer-1',
    name: 'primer 1',
    start: 2,
    end: 2 + bases.length,
    direction: 'forward',
    bases,
    tm: 60,
    gc: 50,
  };
}

function readDrawnBases(): string[] {
  const overlay = screen.getByTestId('workbench-primer-overlay-primer-live-override');
  const raw = overlay.dataset.workbenchPrimerOverlayDrawnBases ?? '[]';
  return (JSON.parse(raw) as Array<{ bases: string }>).map((item) => item.bases);
}
