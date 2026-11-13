/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceViewer1D } from '../SequenceViewer1D';
import type { SequenceScrollPresentation } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const sequence = {
  id: 'tracks-arrival-template',
  name: 'tracks-arrival-template',
  sequence: 'ACGT'.repeat(1000),
  length: 4000,
  circular: false,
  annotations: [],
};

let visible = true;
let height = 600;

beforeEach(() => {
  visible = true;
  height = 600;
  installRecordingCanvas();
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() =>
    visible ? 'visible' : 'hidden'
  );
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(position: number): SequenceScrollPresentation {
  return { position, presented: vi.fn() };
}

describe('SequenceViewer1D owned visible target presentation', () => {
  it('acknowledges a painted current target once across repeated draws', async () => {
    const target = request(20);
    const { container, rerender } = render(
      <SequenceViewer1D sequence={sequence} scrollPresentation={target} />
    );
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('actual Tracks canvas missing');
    await waitFor(() => expect(target.presented).toHaveBeenCalledTimes(1));
    expect(getRecordingLog(canvas).some((op) => op.op === 'fillText')).toBe(true);
    rerender(
      <SequenceViewer1D sequence={sequence} scrollPresentation={target} showRuler={false} />
    );
    expect(target.presented).toHaveBeenCalledTimes(1);
  });

  it('waits for the target cell to be visible instead of accepting an offscreen draw', async () => {
    const target = request(2000);
    const { rerender } = render(
      <SequenceViewer1D sequence={sequence} scrollPresentation={target} />
    );
    expect(target.presented).not.toHaveBeenCalled();
    rerender(
      <SequenceViewer1D
        sequence={sequence}
        scrollPresentation={target}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
      />
    );
    await waitFor(() => expect(target.presented).toHaveBeenCalledTimes(1));
  });

  it('retires a source-replaced owner and admits a new owner on the current source', async () => {
    const old = request(2000);
    const replacement = { ...sequence, id: 'replacement-source' };
    const { rerender } = render(<SequenceViewer1D sequence={sequence} scrollPresentation={old} />);
    rerender(
      <SequenceViewer1D
        sequence={replacement}
        scrollPresentation={old}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
      />
    );
    expect(old.presented).not.toHaveBeenCalled();
    const current = request(2000);
    rerender(
      <SequenceViewer1D
        sequence={replacement}
        scrollPresentation={current}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
      />
    );
    await waitFor(() => expect(current.presented).toHaveBeenCalledTimes(1));
    expect(old.presented).not.toHaveBeenCalled();
  });

  it('keeps same-position replacement requests distinct', async () => {
    const old = request(2000);
    const current = request(2000);
    const { rerender } = render(<SequenceViewer1D sequence={sequence} scrollPresentation={old} />);
    rerender(
      <SequenceViewer1D
        sequence={sequence}
        scrollPresentation={current}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
      />
    );
    await waitFor(() => expect(current.presented).toHaveBeenCalledTimes(1));
    expect(old.presented).not.toHaveBeenCalled();
  });

  it.each(['hidden document', 'zero viewport'] as const)(
    'does not acknowledge a draw in a %s',
    async (boundary) => {
      if (boundary === 'hidden document') visible = false;
      else height = 0;
      const old = request(20);
      const { rerender } = render(
        <SequenceViewer1D sequence={sequence} scrollPresentation={old} />
      );
      expect(old.presented).not.toHaveBeenCalled();
      visible = true;
      height = 600;
      const current = request(20);
      rerender(<SequenceViewer1D sequence={sequence} scrollPresentation={current} />);
      await waitFor(() => expect(current.presented).toHaveBeenCalledTimes(1));
      expect(old.presented).not.toHaveBeenCalled();
    }
  );
});
