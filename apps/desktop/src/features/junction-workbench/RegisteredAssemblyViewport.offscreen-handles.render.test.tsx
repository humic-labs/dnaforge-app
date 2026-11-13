/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import { createAssemblyWorkbenchSession } from './AssemblyWorkbenchSession';
import { RegisteredAssemblyViewport } from './RegisteredAssemblyViewport';
import { buildJunctionWorkbenchModels } from './model';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';

const STRIP_WIDTH = 466;
type FixtureDesign = Parameters<typeof ensureAssemblyWorkbenchIdentity>[0];
const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../../e2e/electron/fixtures/dna-4553-four-part-gibson-long-tails.json'
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STRIP_WIDTH;
    },
  });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

beforeEach(() => {
  installRecordingCanvas();
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const width =
      (this as HTMLElement).dataset.testid === 'junction-handle-overlay' ? STRIP_WIDTH : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width,
      height: 0,
      right: width,
      bottom: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RegisteredAssemblyViewport off-screen handles', () => {
  it('parks the long primer ends of a spacer junction at the strip edges and keeps overlap guides on their boundaries', async () => {
    await renderJunction(1);

    expect(handleFacts()).toEqual([
      { label: 'J2 left homology overlap start', placement: 'boundary', raw: 81, center: 81 },
      { label: 'J2 right homology overlap end', placement: 'boundary', raw: 385, center: 385 },
      { label: 'reverse primer PBS PBS start', placement: 'offscreen-left', raw: -135, center: 14 },
      { label: 'forward primer PBS PBS end', placement: 'offscreen-right', raw: 497, center: 452 },
    ]);
    expect(guideCount()).toBe(2);
  });

  it('gives every control its own target when a pan moves all four boundaries off the same edge', async () => {
    await renderJunction(2);

    expect(handleFacts().map((handle) => [handle.label, handle.placement, handle.raw])).toEqual([
      ['J3 left homology overlap start', 'boundary', 113],
      ['J3 right homology overlap end', 'boundary', 353],
      ['reverse primer PBS PBS start', 'offscreen-left', -159],
      ['forward primer PBS PBS end', 'boundary', 433],
    ]);

    panBy(439);
    await settle();

    expect(handleFacts()).toEqual([
      {
        label: 'J3 left homology overlap start',
        placement: 'offscreen-left',
        raw: -326,
        center: 42,
      },
      { label: 'J3 right homology overlap end', placement: 'offscreen-left', raw: -86, center: 70 },
      { label: 'reverse primer PBS PBS start', placement: 'offscreen-left', raw: -598, center: 14 },
      { label: 'forward primer PBS PBS end', placement: 'offscreen-left', raw: -6, center: 98 },
    ]);
    expect(guideCount()).toBe(0);
  });

  it('brings a parked overlap end into view on click and then edits only that overlap arm', async () => {
    const { fields, commit, cancel } = await renderJunction(2);
    panBy(439);
    await settle();

    fireEvent.click(handle('J3 left homology overlap start'));
    await settle();

    expect(viewport()).toHaveAttribute('data-registered-side-scroll-offset', '17');
    expect(handleFacts()[0]).toEqual({
      label: 'J3 left homology overlap start',
      placement: 'boundary',
      raw: 96,
      center: 96,
    });
    expect(commit).not.toHaveBeenCalled();

    const revealed = handle('J3 left homology overlap start');
    fireEvent.mouseDown(revealed, { button: 0, buttons: 1, clientX: 96, clientY: 120 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 96 - 24, clientY: 120 });
    fireEvent.mouseUp(window, { button: 0, clientX: 96 - 24, clientY: 120 });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(homologyField(fields, 'left'), 18);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('brings a parked primer end into view from the keyboard and steps only its binding length', async () => {
    const { fields, commit } = await renderJunction(1);

    act(() => handle('forward primer PBS PBS end').focus());
    await settle();

    expect(viewport()).toHaveAttribute('data-registered-side-scroll-offset', '127');
    expect(handleFacts()[3]).toEqual({
      label: 'forward primer PBS PBS end',
      placement: 'boundary',
      raw: 370,
      center: 370,
    });

    fireEvent.keyDown(handle('forward primer PBS PBS end'), { key: 'ArrowRight' });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      fields.find((field) => field.kind === 'primerPbs' && field.target.side === 'right'),
      30
    );
  });

  it('leaves the design untouched when a drag is cancelled with Escape', async () => {
    const { commit, cancel } = await renderJunction(1);

    const overlapEnd = handle('J2 right homology overlap end');
    fireEvent.mouseDown(overlapEnd, { button: 0, buttons: 1, clientX: 385, clientY: 120 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 385 + 40, clientY: 120 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseUp(window, { button: 0, clientX: 385 + 40, clientY: 120 });

    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

async function renderJunction(junctionIndex: number) {
  const design = ensureAssemblyWorkbenchIdentity(loadFixtureDesign());
  const model = buildJunctionWorkbenchModels(design).find(
    (candidate) => candidate.junctionIndex === junctionIndex
  );
  if (!model) throw new Error(`junction ${junctionIndex} is missing from the fixture`);
  const fields = createAssemblyWorkbenchSession(design).editableFields.filter(
    (field) => field.target.junctionIndex === junctionIndex
  );
  const commit = vi.fn();
  const cancel = vi.fn();
  render(
    <RegisteredAssemblyViewport
      rows={model.rows}
      editableFields={fields}
      onFieldCommit={commit}
      onFieldCancel={cancel}
      onFieldLivePreview={vi.fn()}
      onFieldLivePreviewEnd={vi.fn()}
    />
  );
  await settle();
  return { fields, commit, cancel };
}

function loadFixtureDesign(): FixtureDesign {
  const saved: { design: FixtureDesign } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  return {
    ...saved.design,
    createdAt: new Date(saved.design.createdAt),
    updatedAt: new Date(saved.design.updatedAt),
  };
}

function homologyField(
  fields: AssemblyWorkbenchEditableField[],
  side: 'left' | 'right'
): AssemblyWorkbenchEditableField | undefined {
  return fields.find((field) => field.kind === 'homologyArm' && field.target.side === side);
}

function viewport(): HTMLElement {
  return screen.getByTestId('registered-assembly-viewport');
}

function productHandles(): HTMLElement[] {
  return Array.from(
    screen
      .getByTestId('junction-row-product')
      .querySelectorAll<HTMLElement>('[data-testid^="junction-field-handle-"][data-field-id]')
  );
}

function handle(label: string): HTMLElement {
  const match = productHandles().find((element) => element.getAttribute('aria-label') === label);
  if (!match) throw new Error(`no handle labelled ${label}`);
  return match;
}

function handleFacts() {
  return productHandles().map((element) => ({
    label: element.getAttribute('aria-label'),
    placement: element.getAttribute('data-handle-placement'),
    raw: Number(element.getAttribute('data-handle-raw-center-x')),
    center: Number(element.getAttribute('data-handle-center-x')),
  }));
}

function guideCount(): number {
  return screen
    .getByTestId('junction-row-product')
    .querySelectorAll('[data-testid^="junction-field-handle-line-"]').length;
}

function panBy(deltaX: number): void {
  fireEvent.wheel(screen.getByTestId('registered-assembly-pan-surface-product'), {
    deltaX,
    deltaY: 0,
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 0));
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 20));
  });
}
