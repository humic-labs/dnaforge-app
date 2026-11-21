import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  type RenderOptions,
} from '@testing-library/react';
import { StrictMode, useLayoutEffect, useMemo, type PropsWithChildren } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import type { Genome, IndexedPixiLinearRenderer, RenderState } from '@waypoint/genome-renderer';
import type { PixiMapHandle, UseIndexedPixiMapOptions } from '@waypoint/genome-renderer/react';
type PixiPresentedFrame = Parameters<Parameters<PixiMapHandle['subscribeToPresentedFrames']>[0]>[0];
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { TrackStoreBridge } from '../../../shared/track-store';

interface Boundary {
  native: SequenceDocumentClientBridge | undefined;
  nativeTransportEnabled: boolean;
  execute: ReturnType<
    typeof vi.fn<(request: SequenceDocumentRequest) => Promise<SequenceDocumentSnapshot>>
  >;
  clock: { now: number };
  dateNow: { mockRestore(): void };
  ready: boolean;
  renderer: IndexedPixiLinearRenderer | null;
  state: RenderState | null;
  options: UseIndexedPixiMapOptions | null;
  containerRef: { current: HTMLDivElement | null };
  listeners: Set<(frame: PixiPresentedFrame) => void>;
  frameEpoch: number;
  generation: number;
  captureReady: boolean;
  readFile: ReturnType<typeof vi.fn<(path: string) => Promise<Uint8Array>>>;
  track: ReturnType<typeof vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>>;
}
const boundary = vi.hoisted(() => {
  const clock = { now: 1_000 };
  const value: Boundary = {
    native: undefined,
    nativeTransportEnabled: false,
    execute: vi.fn<(request: SequenceDocumentRequest) => Promise<SequenceDocumentSnapshot>>(),
    clock,
    dateNow: vi.spyOn(Date, 'now').mockImplementation(() => clock.now),
    ready: false,
    renderer: null,
    state: null,
    options: null,
    containerRef: { current: null },
    listeners: new Set(),
    frameEpoch: 0,
    generation: 11,
    captureReady: true,
    readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
    track: vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>(() => false),
  };
  return value;
});

vi.mock('../sequence-document-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sequence-document-client')>()),
  getNativeSequenceDocumentClient: () => boundary.native,
}));
vi.mock('../../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform')>();
  return {
    ...actual,
    platform: () =>
      boundary.nativeTransportEnabled
        ? {
            fs: {
              sequenceDocument: boundary.execute,
              isSequenceDocumentAvailable: async () => true,
              readFile: boundary.readFile,
              readTextFile: vi.fn(),
              watchFile: async () => {},
              unwatchFile: async () => {},
            },
            on: () => () => {},
          }
        : actual.platform(),
  };
});

vi.mock('@waypoint/sequence-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@waypoint/sequence-utils')>()),
  loadAllEnzymes: async () => [],
}));
vi.mock('../annotation-catalog/annotation-catalog-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../annotation-catalog/annotation-catalog-registry')>();
  const emptyCatalogStore: TrackStoreBridge = {
    root: async () => '/owned-synthetic/empty-annotation-store',
    listAssemblies: async () => [],
    listTracks: async () => [],
    readMeta: async () => {
      throw new Error('UNEXPECTED_ANNOTATION_META_READ');
    },
    readTrackFile: async () => {
      throw new Error('UNEXPECTED_ANNOTATION_FILE_READ');
    },
    refresh: async () => ({ seeded: 0 }),
  };
  return {
    ...actual,
    loadAnnotationCatalogs: (bridge: TrackStoreBridge = emptyCatalogStore) =>
      actual.loadAnnotationCatalogs(bridge),
  };
});

vi.mock('./SequenceToolbarSidebar', () => ({ SequenceToolbarSidebar: () => null }));
vi.mock('./WorkspaceViewerContextMenu', () => ({ WorkspaceViewerContextMenu: () => null }));

vi.mock('../../../hooks/useMockedFileSystem', () => ({
  getFileSystem: async () => ({ readFile: boundary.readFile }),
}));
vi.mock('../../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => boundary.generation,
  isAnalyticsCaptureReady: () => boundary.captureReady,
  trackRendererEvent: boundary.track,
}));
vi.mock('@waypoint/genome-renderer/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/genome-renderer/react')>();
  const handle = {
    getState: () => boundary.state,
    getLinearRenderer: () => (boundary.ready ? boundary.renderer : null),
    requestRender: () => {},
    getViewCenter: () =>
      boundary.state && boundary.renderer
        ? boundary.renderer.getViewCenterBp(boundary.state)
        : null,
    getViewportRange: () => {
      const range = boundary.state?.viewportRange;
      return range ? { start: range[0], end: range[1] } : null;
    },
    setCameraViewport: (start: number, end: number) => ({ start, end }),
    setViewCenter: (center: number) => {
      if (boundary.state) boundary.renderer?.setViewCenterBp(center, boundary.state);
    },
    setDisplaySize: () => {},
    getComparisonCamera: () => null,
    setComparisonCamera: () => null,
    getContactCamera: () => null,
    setContactCamera: () => null,
    subscribeToPresentedFrames: (listener: (frame: PixiPresentedFrame) => void) => {
      boundary.listeners.add(listener);
      return () => {
        boundary.listeners.delete(listener);
      };
    },
    schedulePostPresentWork: (work: () => void) => work(),
  };
  return {
    ...actual,
    useIndexedPixiMap: (options: UseIndexedPixiMapOptions) => {
      boundary.options = options;
      return { containerRef: boundary.containerRef, handle };
    },
  };
});

import { useFileContent } from '../../../hooks/useFileContent';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { resetWorkspaceSyncRendererGenerationsForTest } from '../../../services/workspace-sync-renderer-generation';
import { annotatedSequenceToParsedPlasmid } from '../adapters';
import { SharedSequenceReadViewer } from './SharedSequenceReadViewer';
import { useSequence } from '../hooks/useSequence';
import { useSequenceStore } from '../store';
import {
  getNativeSequenceDocumentClient,
  SequenceDocumentClientBridge,
} from '../sequence-document-client';
import { createSequenceDocumentModel } from '../sequence-document-model';
import { parseBinarySequenceFileAsAnnotated } from '../../../shared/parse-sequence-file';
import type {
  SequenceDocumentRequest,
  SequenceDocumentSnapshot,
} from '../../../shared/sequence-document';
import { useFileWatcher } from '../hooks/useFileWatcher';
import { useCanvasStore } from '../../canvas/public/store';
import { useSequenceViewState } from '../view-state/useSequenceViewState';
import {
  clearSequenceViewMemory,
  writeSequenceViewMemory,
} from '../view-state/sequence-view-state';

let rendererModule: typeof import('@waypoint/genome-renderer');
let pixi: typeof import('pixi.js');
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalContextType = globalThis.CanvasRenderingContext2D;
const originalResizeObserver = globalThis.ResizeObserver;
const noChange = () => {};
const filePath = '/owned-synthetic/PRIVATE_CALLER_CANARY.ab1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventKeys = new Set([
  'feature_area',
  'operation_id',
  'sanger_read_revision_id',
  'sanger_view_id',
  'viewport_operation_id',
  'sanger_stage',
  'sanger_origin',
  'sanger_classification',
  'sanger_reason',
  'sanger_started_at_ms',
  'sanger_parse_started_at_ms',
  'sanger_view_started_at_ms',
  'viewport_started_at_ms',
  'sanger_viewport_kind',
  'sanger_trace_available',
  'sanger_quality_available',
  'sanger_trace_visible',
  'sanger_quality_visible',
  'sanger_bases_visible',
  'occurred_at_ms',
]);

function syntheticAb1(qualityCount = 6): Uint8Array {
  const shorts = (values: number[]) => {
    const result = new Uint8Array(values.length * 2);
    const view = new DataView(result.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, false));
    return result;
  };
  const characters = (text: string) =>
    Uint8Array.from(text, (character) => character.charCodeAt(0));
  const entries = [
    { tag: 'PBAS', number: 2, size: 1, data: characters('ACGTAC') },
    { tag: 'PCON', number: 2, size: 1, data: new Uint8Array(qualityCount).fill(40) },
    { tag: 'PLOC', number: 2, size: 2, data: shorts([1, 3, 5, 7, 9, 11]) },
    { tag: 'FWO_', number: 1, size: 1, data: characters('ACGT') },
    ...[9, 10, 11, 12].map((number) => ({
      tag: 'DATA',
      number,
      size: 2,
      data: shorts(Array.from({ length: 16 }, (_, index) => (index % 4 === number % 4 ? 30 : 0))),
    })),
  ];
  const directoryOffset = 128;
  let dataOffset = directoryOffset + entries.length * 28;
  const bytes = new Uint8Array(
    dataOffset +
      entries.reduce((count, entry) => count + (entry.data.length > 4 ? entry.data.length : 0), 0)
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x41424946, false);
  view.setInt16(4, 101, false);
  view.setInt32(18, entries.length, false);
  view.setInt32(26, directoryOffset, false);
  entries.forEach((entry, index) => {
    const offset = directoryOffset + index * 28;
    bytes.set(characters(entry.tag), offset);
    view.setInt32(offset + 4, entry.number, false);
    view.setInt16(offset + 8, entry.size === 2 ? 4 : 2, false);
    view.setInt16(offset + 10, entry.size, false);
    view.setInt32(offset + 12, entry.data.length / entry.size, false);
    view.setInt32(offset + 16, entry.data.length, false);
    if (entry.data.length <= 4) bytes.set(entry.data, offset + 20);
    else {
      view.setInt32(offset + 20, dataOffset, false);
      bytes.set(entry.data, dataOffset);
      dataOffset += entry.data.length;
    }
  });
  return bytes;
}

function events(stage?: string) {
  return boundary.track.mock.calls
    .filter(([event]) => event === 'sanger_read_stage')
    .map(([, properties]) => properties ?? {})
    .filter((event) => stage === undefined || event.sanger_stage === stage);
}
function oneEvent(stage: string) {
  const found = events(stage);
  expect(found, `READ_OWNED_${stage.toUpperCase()}_MISSING_OR_DUPLICATED`).toHaveLength(1);
  const event = found[0];
  if (!event) throw new Error('ACTUAL_READ_OWNED_CALLER_EVENT_REQUIRED');
  return event;
}
function options() {
  const current = boundary.options;
  if (!current?.genome) throw new Error('ACTUAL_VIEWER_GENOME_REQUIRED');
  return { ...current, genome: current.genome };
}
function state() {
  if (!boundary.state) throw new Error('OWNED_RENDER_STATE_REQUIRED');
  return boundary.state;
}
function frame(genome: Genome) {
  const receipt: PixiPresentedFrame = {
    frameEpoch: ++boundary.frameEpoch,
    presentedAtMs: performance.now(),
    content: { genome, orfsDrawn: false },
  };
  act(() => {
    for (const listener of [...boundary.listeners]) listener(receipt);
  });
}
function viewer(sequence: AnnotatedSequence) {
  return (
    <SharedSequenceReadViewer
      sequence={sequence}
      plasmid={annotatedSequenceToParsedPlasmid(sequence)}
      selection={null}
      onSelectionChange={noChange}
      onViewportChange={noChange}
      zoomPercent={100}
    />
  );
}

type DataCalls = ReadonlyArray<Parameters<IndexedPixiLinearRenderer['setTrackData']>>;
function lane(calls: DataCalls) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const entry = calls[index];
    if (!entry) continue;
    const [id, data] = entry;
    if (data && typeof data === 'object' && 'kind' in data && data.kind === 'sanger') {
      return { id, data };
    }
  }
  throw new Error('ACTUAL_ADMITTED_SANGER_LANE_REQUIRED');
}
function paintReceipt(renderer: IndexedPixiLinearRenderer, calls: DataCalls) {
  const current = lane(calls);
  const receipt: unknown = Reflect.apply(renderer.getSequenceReadPaintReceipt, renderer, [
    current.id,
    current.data,
  ]);
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('paintCount' in receipt) ||
    typeof receipt.paintCount !== 'number'
  ) {
    throw new Error('ACTUAL_EXACT_LANE_PAINT_RECEIPT_REQUIRED');
  }
  return { receipt, paintCount: receipt.paintCount };
}

beforeAll(async () => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    Object.assign(globalThis, { CanvasRenderingContext2D: class CanvasRenderingContext2D {} });
  }
  Object.assign(globalThis, {
    ResizeObserver: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => {},
      fillText: () => {},
      clearRect: () => {},
      measureText: (text: string) => ({
        width: text.length * 6,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  pixi = await import('pixi.js');
  rendererModule = await import('@waypoint/genome-renderer');
});
beforeEach(() => {
  boundary.clock.now = 1_000;
  boundary.generation = 11;
  boundary.captureReady = true;
  boundary.ready = false;
  boundary.renderer = null;
  boundary.state = null;
  boundary.options = null;
  boundary.frameEpoch = 0;
  boundary.listeners.clear();
  boundary.readFile.mockReset().mockResolvedValue(syntheticAb1());
  boundary.track.mockReset().mockReturnValue(false);
  useWorkspaceStore.setState({ folders: [] });
  resetWorkspaceSyncRendererGenerationsForTest();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 800, 600)
  );
});
afterEach(() => {
  cleanup();
  boundary.renderer?.destroy();
  boundary.renderer = null;
  boundary.ready = false;
  boundary.listeners.clear();
  resetWorkspaceSyncRendererGenerationsForTest();
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Object.assign(globalThis, {
    CanvasRenderingContext2D: originalContextType,
    ResizeObserver: originalResizeObserver,
  });
  boundary.dateNow.mockRestore();
});

async function mountedRead() {
  const read = renderHook(() => useFileContent(filePath));
  try {
    await waitFor(() => expect(read.result.current.loading).toBe(false));
    expect(read.result.current.format).toBe('ab1');
    const sequence = read.result.current.sequence;
    if (!sequence) throw new Error('ACTUAL_ACCEPTED_AB1_SEQUENCE_REQUIRED');
    return { read, sequence, parsed: oneEvent('parsed') };
  } catch (error) {
    read.unmount();
    throw error;
  }
}
async function mountViewer(
  sequence: AnnotatedSequence,
  wrapper?: RenderOptions['wrapper'],
  element?: Parameters<typeof render>[0]
) {
  const renderer = new rendererModule.IndexedPixiLinearRenderer();
  boundary.renderer = renderer;
  boundary.state = {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 600,
    selectedIds: new Set(),
    hoveredId: null,
    hoveredCutSiteId: null,
    viewportRange: [0, 6],
    highlightRange: null,
    cursorPosition: null,
    perfPanelVisible: false,
  };
  const data = vi.spyOn(renderer, 'setTrackData');
  const view = render(element ?? viewer(sequence), { wrapper });
  try {
    await renderer.init(
      {
        stage: new pixi.Container(),
        canvas: document.createElement('canvas'),
        renderer: {},
      } as unknown as Application,
      options().genome,
      state
    );
    boundary.ready = true;
    act(() => {
      options().onRendererReady?.(1);
      options().onRendererGenomeCommit?.(1);
    });
    await waitFor(() =>
      expect(
        data.mock.calls.some(
          ([, value]) =>
            value && typeof value === 'object' && 'kind' in value && value.kind === 'sanger'
        )
      ).toBe(true)
    );
    return { renderer, data, view };
  } catch (error) {
    view.unmount();
    renderer.destroy();
    boundary.renderer = null;
    throw error;
  }
}

describe('Sanger read caller presentation', () => {
  it('joins the actual accepted read and fresh exact lane paint to its current-genome frame', async () => {
    const loaded = await mountedRead();
    boundary.clock.now = 2_000;
    const f = await mountViewer(loaded.sequence);
    try {
      expect(events('first_viewport_presented')).toEqual([]);
      f.renderer.render(state());
      const painted = paintReceipt(f.renderer, f.data.mock.calls);
      expect(painted.receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      expect(events('first_viewport_presented')).toEqual([]);
      boundary.clock.now = 3_000;
      frame({ ...options().genome });
      expect(events('first_viewport_presented')).toEqual([]);
      frame(options().genome);
      const presented = oneEvent('first_viewport_presented');
      expect(presented).toMatchObject({
        operation_id: loaded.parsed.operation_id,
        sanger_read_revision_id: loaded.parsed.sanger_read_revision_id,
        sanger_started_at_ms: 1_000,
        sanger_parse_started_at_ms: 1_000,
        sanger_view_started_at_ms: 2_000,
        occurred_at_ms: 3_000,
        sanger_trace_available: true,
        sanger_quality_available: true,
        sanger_trace_visible: true,
        sanger_quality_visible: true,
        sanger_bases_visible: true,
      });
      const admitted = oneEvent('scene_admitted');
      expect(admitted.operation_id).toBe(presented.operation_id);
      expect(admitted.sanger_read_revision_id).toBe(presented.sanger_read_revision_id);
      expect(admitted.sanger_view_id).toBe(presented.sanger_view_id);
      expect(presented.sanger_view_id).toMatch(uuid);
      expect(
        new Set([
          presented.operation_id,
          presented.sanger_read_revision_id,
          presented.sanger_view_id,
        ]).size
      ).toBe(3);
      frame(options().genome);
      expect(events('first_viewport_presented')).toHaveLength(1);
      expect(paintReceipt(f.renderer, f.data.mock.calls).paintCount).toBe(painted.paintCount);
      for (const event of events()) {
        expect(Object.keys(event).filter((key) => !eventKeys.has(key))).toEqual([]);
      }
      expect(JSON.stringify(events())).not.toContain('PRIVATE_CALLER_CANARY');
      expect(JSON.stringify(events())).not.toContain('ACGTAC');
    } finally {
      f.view.unmount();
      loaded.read.unmount();
      expect(boundary.listeners.size).toBe(0);
    }
  });

  it('refuses an obsolete accepted read and does not credit an unchanged paint for a new pan', async () => {
    const loaded = await mountedRead();
    await act(async () => {
      await loaded.read.result.current.reload();
    });
    const current = loaded.read.result.current.sequence;
    if (!current) throw new Error('ACTUAL_RELOADED_SEQUENCE_REQUIRED');
    expect(current).not.toBe(loaded.sequence);
    const parses = events('parsed');
    expect(parses).toHaveLength(2);
    const accepted = parses[1];
    if (!accepted) throw new Error('ACTUAL_CURRENT_READ_OPERATION_REQUIRED');
    boundary.clock.now = 2_000;
    const f = await mountViewer(loaded.sequence);
    try {
      f.renderer.render(state());
      expect(paintReceipt(f.renderer, f.data.mock.calls).receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      const obsoleteLaneData = lane(f.data.mock.calls).data;
      frame(options().genome);
      expect(events('first_viewport_presented')).toEqual([]);
      f.view.rerender(viewer(current));
      await f.renderer.loadGenome(options().genome);
      act(() => options().onRendererGenomeCommit?.(2));
      await waitFor(() => expect(lane(f.data.mock.calls).data).not.toBe(obsoleteLaneData));
      f.renderer.render(state());
      expect(paintReceipt(f.renderer, f.data.mock.calls).receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      frame(options().genome);
      expect(oneEvent('first_viewport_presented').operation_id).toBe(accepted.operation_id);
      const baseline = paintReceipt(f.renderer, f.data.mock.calls).paintCount;
      boundary.clock.now = 4_000;
      state().zoom = 2;
      state().viewportRange = [1, 4];
      f.renderer.setViewCenterBp(2.5, state());
      act(() => options().onCameraChange?.(2.5, 'scroll', 2, { start: 1, end: 4 }));
      const pending = oneEvent('viewport_accepted');
      frame(options().genome);
      expect(events('viewport_presented')).toEqual([]);
      expect(paintReceipt(f.renderer, f.data.mock.calls).paintCount).toBe(baseline);
      f.renderer.render(state());
      expect(paintReceipt(f.renderer, f.data.mock.calls).paintCount).toBeGreaterThan(baseline);
      boundary.clock.now = 5_000;
      frame({ ...options().genome });
      expect(events('viewport_presented')).toEqual([]);
      frame(options().genome);
      expect(oneEvent('viewport_presented')).toMatchObject({
        operation_id: accepted.operation_id,
        sanger_read_revision_id: accepted.sanger_read_revision_id,
        sanger_view_id: pending.sanger_view_id,
        viewport_operation_id: pending.viewport_operation_id,
        viewport_started_at_ms: 4_000,
        occurred_at_ms: 5_000,
        sanger_viewport_kind: 'pan',
      });
      frame(options().genome);
      expect(events('viewport_presented')).toHaveLength(1);
    } finally {
      f.view.unmount();
      loaded.read.unmount();
      expect(boundary.listeners.size).toBe(0);
    }
  });

  it('preserves presentation through the real useSequence store handoff and rejects a replaced store version', async () => {
    const documentKey = 'owned-c1-store-document';
    expect(getNativeSequenceDocumentClient()).toBeUndefined();
    useSequenceStore.getState().clearAll();
    const loaded = renderHook(() => useSequence(filePath, documentKey));
    try {
      await waitFor(() => expect(loaded.result.current.isLoading).toBe(false));
      await waitFor(() => expect(loaded.result.current.data?.id).toBe(documentKey));
      await act(async () => {
        await Promise.resolve();
      });
      expect(boundary.readFile).toHaveBeenCalledTimes(1);
      const stored = loaded.result.current.data;
      if (!stored) throw new Error('ACTUAL_STORED_READ_REQUIRED');
      expect(useSequenceStore.getState().sequences[documentKey]).toBe(stored);
      const version = useSequenceStore.getState().getVersion(documentKey);
      const accepted = oneEvent('parsed');
      boundary.clock.now = 2_000;
      const f = await mountViewer(stored);
      try {
        f.renderer.render(state());
        expect(paintReceipt(f.renderer, f.data.mock.calls).receipt).toMatchObject({
          traceVisible: true,
          qualityVisible: true,
          basesVisible: true,
        });
        frame(options().genome);
        expect(oneEvent('first_viewport_presented')).toMatchObject({
          operation_id: accepted.operation_id,
          sanger_read_revision_id: accepted.sanger_read_revision_id,
          sanger_started_at_ms: 1_000,
        });
        const replacement = renderHook(() => useFileContent(filePath));
        try {
          await waitFor(() => expect(replacement.result.current.loading).toBe(false));
          expect(replacement.result.current.format).toBe('ab1');
          const next = replacement.result.current.sequence;
          if (!next) throw new Error('ACTUAL_REPLACEMENT_PARSER_RESULT_REQUIRED');
          expect(next).not.toBe(stored);
          expect(useSequenceStore.getState().getVersion(documentKey)).toBe(version);
          expect(useSequenceStore.getState().sequences[documentKey]).toBe(stored);
          boundary.clock.now = 4_000;
          state().zoom = 2;
          state().viewportRange = [1, 4];
          f.renderer.setViewCenterBp(2.5, state());
          act(() => options().onCameraChange?.(2.5, 'scroll', 2, { start: 1, end: 4 }));
          const pending = oneEvent('viewport_accepted');
          expect(pending.operation_id).toBe(accepted.operation_id);
          const beforePaint = paintReceipt(f.renderer, f.data.mock.calls).paintCount;
          act(() => useSequenceStore.getState().setSequence(documentKey, next));
          expect(useSequenceStore.getState().getVersion(documentKey)).not.toBe(version);
          expect(useSequenceStore.getState().sequences[documentKey]).not.toBe(stored);
          await waitFor(() =>
            expect(loaded.result.current.data).toBe(
              useSequenceStore.getState().sequences[documentKey]
            )
          );
          f.renderer.render(state());
          expect(paintReceipt(f.renderer, f.data.mock.calls).paintCount).toBeGreaterThan(
            beforePaint
          );
          boundary.clock.now = 5_000;
          frame(options().genome);
          expect(
            events('viewport_presented').filter(
              (event) => event.viewport_operation_id === pending.viewport_operation_id
            )
          ).toEqual([]);
          expect(events('first_viewport_presented')).toHaveLength(1);
        } finally {
          replacement.unmount();
        }
      } finally {
        f.view.unmount();
      }
    } finally {
      loaded.unmount();
      useSequenceStore.getState().clearAll();
      expect(boundary.listeners.size).toBe(0);
    }
  });

  it('retains one read-owned first presentation after actual StrictMode effect replay', async () => {
    const replay = { setups: 0, cleanups: 0 };
    function ReplayProbe() {
      useLayoutEffect(() => {
        replay.setups += 1;
        return () => {
          replay.cleanups += 1;
        };
      }, []);
      return null;
    }
    function StrictBoundary({ children }: PropsWithChildren) {
      return (
        <StrictMode>
          <ReplayProbe />
          {children}
        </StrictMode>
      );
    }
    const loaded = await mountedRead();
    boundary.clock.now = 2_000;
    const f = await mountViewer(loaded.sequence, StrictBoundary);
    try {
      expect(replay).toEqual({ setups: 2, cleanups: 1 });
      expect(boundary.readFile).toHaveBeenCalledTimes(1);
      expect(events('read_requested')).toHaveLength(1);
      expect(events('parsed')).toHaveLength(1);
      expect(events('first_viewport_presented')).toEqual([]);
      f.renderer.render(state());
      expect(paintReceipt(f.renderer, f.data.mock.calls).receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      expect(events('first_viewport_presented')).toEqual([]);
      boundary.clock.now = 3_000;
      frame({ ...options().genome });
      expect(events('first_viewport_presented')).toEqual([]);
      frame(options().genome);
      const presented = oneEvent('first_viewport_presented');
      expect(presented).toMatchObject({
        operation_id: loaded.parsed.operation_id,
        sanger_read_revision_id: loaded.parsed.sanger_read_revision_id,
        sanger_started_at_ms: 1_000,
        sanger_parse_started_at_ms: 1_000,
        sanger_view_started_at_ms: 2_000,
        occurred_at_ms: 3_000,
        sanger_trace_visible: true,
        sanger_quality_visible: true,
        sanger_bases_visible: true,
      });
      expect(presented.sanger_view_id).toMatch(uuid);
      frame(options().genome);
      expect(events('first_viewport_presented')).toHaveLength(1);
      expect(boundary.readFile).toHaveBeenCalledTimes(1);
    } finally {
      f.view.unmount();
      loaded.read.unmount();
      expect(boundary.listeners.size).toBe(0);
      expect(replay).toEqual({ setups: 2, cleanups: 2 });
    }
  });

  it('presents the current native read after an unchanged-version reload replaces lineage but preserves sequence identity', async () => {
    const documentId = 'owned-native-sanger-caller';
    function nativeSnapshot(): SequenceDocumentSnapshot {
      const parsed = parseBinarySequenceFileAsAnnotated(syntheticAb1(), filePath);
      if (parsed.format !== 'ab1') throw new Error('ACTUAL_NATIVE_CALLER_AB1_REQUIRED');
      const sequence = { ...parsed.sequence, id: documentId };
      const model = createSequenceDocumentModel();
      model.getState().setSequence(documentId, sequence);
      const snapshot = model.getState();
      const draft = snapshot.drafts[documentId];
      const lineage = snapshot.draftLineages[documentId];
      if (!draft || !lineage) throw new Error('ACTUAL_NATIVE_CALLER_LINEAGE_REQUIRED');
      return {
        documentId,
        path: filePath,
        workspaceRoot: '/owned-synthetic',
        revision: 'native-caller-revision-1',
        persistedRevision: 'native-caller-revision-1',
        version: 1,
        savedVersion: 1,
        ready: true,
        readOnly: true,
        dirty: false,
        saving: false,
        canUndo: false,
        canRedo: false,
        length: sequence.length,
        annotationCount: 0,
        capabilities: [],
        copy: { sequence, savedSequence: sequence, draft, lineage, version: 1, savedVersion: 1 },
      };
    }
    let renderedSequence: AnnotatedSequence | null = null;
    function NativeCaller() {
      const read = useSequence(filePath, documentId);
      renderedSequence = read.data;
      return read.data ? viewer(read.data) : null;
    }
    useSequenceStore.getState().clearAll();
    boundary.nativeTransportEnabled = true;
    const initial = nativeSnapshot();
    if (!initial.copy) throw new Error('ACTUAL_INITIAL_NATIVE_COPY_REQUIRED');
    useSequenceStore.getState().setSequence(documentId, initial.copy.sequence);
    const native = new SequenceDocumentClientBridge(useSequenceStore);
    boundary.execute.mockReset().mockResolvedValue(initial);
    let watcher:
      | { result: { current: ReturnType<typeof useFileWatcher> }; unmount(): void }
      | undefined;
    let f: Awaited<ReturnType<typeof mountViewer>> | undefined;
    try {
      await native.execute(documentId, { kind: 'reload' }, { expectedVersion: 1 });
      boundary.native = native;
      const before = useSequenceStore.getState();
      const working = before.sequences[documentId];
      if (!working) throw new Error('ACTUAL_NATIVE_WORKING_SEQUENCE_REQUIRED');
      const first = nativeSnapshot();
      if (!first.copy) throw new Error('ACTUAL_FIRST_NATIVE_COPY_REQUIRED');
      expect(first.copy.sequence).not.toBe(working);
      expect(first.copy.lineage).not.toBe(before.draftLineages[documentId]);
      boundary.execute.mockReset().mockResolvedValue(first);
      const mountedWatcher = renderHook(() =>
        useFileWatcher({ filePath, documentId, isDirty: false })
      );
      watcher = mountedWatcher;
      await act(async () => {
        await mountedWatcher.result.current.reloadFromDisk();
      });
      expect(useSequenceStore.getState().sequences[documentId]).toBe(working);
      expect(useSequenceStore.getState().getVersion(documentId)).toBe(1);
      expect(useSequenceStore.getState().draftLineages[documentId]).toBe(first.copy.lineage);
      const firstRead = oneEvent('revision_ready');
      expect(firstRead.sanger_origin).toBe('native_reload');
      expect(firstRead.sanger_parse_started_at_ms).toBeUndefined();
      boundary.clock.now = 2_000;
      f = await mountViewer(working, undefined, <NativeCaller />);
      expect(renderedSequence).toBe(working);
      f.renderer.render(state());
      expect(paintReceipt(f.renderer, f.data.mock.calls).receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      frame(options().genome);
      expect(oneEvent('first_viewport_presented')).toMatchObject({
        operation_id: firstRead.operation_id,
        sanger_read_revision_id: firstRead.sanger_read_revision_id,
      });
      const previousView = oneEvent('first_viewport_presented');
      const next = nativeSnapshot();
      if (!next.copy) throw new Error('ACTUAL_NEXT_NATIVE_COPY_REQUIRED');
      expect(next.copy.sequence).not.toBe(working);
      expect(next.copy.lineage).not.toBe(first.copy.lineage);
      boundary.execute.mockResolvedValue(next);
      boundary.clock.now = 4_000;
      await act(async () => {
        await mountedWatcher.result.current.reloadFromDisk();
      });
      const current = useSequenceStore.getState();
      expect(current.getVersion(documentId)).toBe(1);
      expect(current.savedVersions[documentId]).toBe(1);
      expect(current.sequences[documentId]).toBe(working);
      expect(current.draftLineages[documentId]).toBe(next.copy.lineage);
      expect(renderedSequence).toBe(working);
      const reads = events('revision_ready');
      expect(reads).toHaveLength(2);
      const accepted = reads[1];
      if (!accepted) throw new Error('ACTUAL_SECOND_NATIVE_READ_REQUIRED');
      expect(accepted.operation_id).not.toBe(firstRead.operation_id);
      expect(accepted.sanger_read_revision_id).not.toBe(firstRead.sanger_read_revision_id);
      expect(accepted.sanger_started_at_ms).toBe(4_000);
      expect(accepted.sanger_parse_started_at_ms).toBeUndefined();
      const priorPaintCount = paintReceipt(f.renderer, f.data.mock.calls).paintCount;
      frame(options().genome);
      expect(events('first_viewport_presented')).toHaveLength(1);
      f.renderer.render(state());
      const painted = paintReceipt(f.renderer, f.data.mock.calls);
      expect(painted.paintCount).toBeGreaterThan(priorPaintCount);
      expect(painted.receipt).toMatchObject({
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      boundary.clock.now = 5_000;
      frame(options().genome);
      const presented = events('first_viewport_presented');
      expect(presented, 'CURRENT_NATIVE_BINDING_FIRST_VIEWPORT_REQUIRED').toHaveLength(2);
      expect(presented[1]).toMatchObject({
        operation_id: accepted.operation_id,
        sanger_read_revision_id: accepted.sanger_read_revision_id,
        sanger_origin: 'native_reload',
        sanger_view_started_at_ms: 4_000,
        sanger_started_at_ms: 4_000,
        occurred_at_ms: 5_000,
        sanger_trace_visible: true,
        sanger_quality_visible: true,
        sanger_bases_visible: true,
      });
      expect(presented[1]?.sanger_view_id).toMatch(uuid);
      expect(presented[1]?.sanger_view_id).not.toBe(previousView.sanger_view_id);
      frame(options().genome);
      expect(events('first_viewport_presented')).toHaveLength(2);
      expect(events('read_requested')).toHaveLength(2);
      expect(events('parsed')).toEqual([]);
      expect(boundary.readFile).not.toHaveBeenCalled();
      for (const event of events()) {
        expect(Object.keys(event).filter((key) => !eventKeys.has(key))).toEqual([]);
      }
      for (const value of [filePath, documentId, 'native-caller-revision-1', 'ACGTAC']) {
        expect(JSON.stringify(events())).not.toContain(value);
      }
    } finally {
      f?.view.unmount();
      watcher?.unmount();
      await native.flush('discard');
      boundary.native = undefined;
      boundary.nativeTransportEnabled = false;
      useSequenceStore.getState().clearAll();
      expect(boundary.listeners.size).toBe(0);
    }
  });

  describe('WorkspaceViewer production projection', () => {
    let WorkspaceViewer: (typeof import('./WorkspaceViewer'))['WorkspaceViewer'];
    beforeAll(async () => {
      ({ WorkspaceViewer } = await import('./WorkspaceViewer'));
    });

    it('retains the accepted read through the real orientation projection and fresh current-genome paint', async () => {
      const documentKey = 'owned-workspace-sanger-projection';
      useSequenceStore.getState().clearAll();
      useCanvasStore.getState().reset();
      writeSequenceViewMemory(documentKey, {
        rendererVisibility: 'sequence',
        orientation: 'forward',
        zoom: 100,
      });
      const previousOrfVisibility = localStorage.getItem('waypoint-orf-visible');
      localStorage.setItem('waypoint-orf-visible', 'false');
      useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: documentKey,
        label: documentKey,
        sequenceDocument: { kind: 'catalog-sequence', entityId: documentKey },
        loadStatus: 'loaded',
      });
      const loaded = renderHook(() => useSequence(filePath, documentKey));
      const viewState = renderHook(() =>
        useSequenceViewState(documentKey, { circular: false, surface: 'sequence' })
      );
      let f: Awaited<ReturnType<typeof mountViewer>> | undefined;
      function WorkspaceCaller() {
        const read = useSequence(filePath, documentKey);
        return read.data ? (
          <WorkspaceViewer
            entityId={documentKey}
            sequence={read.data}
            dataLayerSourceSequence={read.data}
            plasmid={annotatedSequenceToParsedPlasmid(read.data)}
            circular={Boolean(read.data.circular)}
            surface="sequence"
            readOnly
            hideMinimap
          />
        ) : null;
      }
      try {
        await waitFor(() => expect(loaded.result.current.isLoading).toBe(false));
        const accepted = loaded.result.current.data;
        if (!accepted) throw new Error('ACTUAL_WORKSPACE_ACCEPTED_READ_REQUIRED');
        expect(accepted.id).toBe(documentKey);
        expect(accepted.sequence).toBe('ACGTAC');
        expect(boundary.readFile).toHaveBeenCalledTimes(1);
        const parsed = oneEvent('parsed');
        const version = useSequenceStore.getState().getVersion(documentKey);
        const lineage = useSequenceStore.getState().draftLineages[documentKey];
        boundary.clock.now = 2_000;
        f = await mountViewer(accepted, undefined, <WorkspaceCaller />);
        const identityGenome = options().genome;
        const identityData = lane(f.data.mock.calls).data;
        expect(identityGenome.sequence).toBe('ACGTAC');
        f.renderer.render(state());
        const identityPaint = paintReceipt(f.renderer, f.data.mock.calls);
        expect(identityPaint.receipt).toMatchObject({
          traceVisible: true,
          qualityVisible: true,
          basesVisible: true,
        });
        boundary.clock.now = 3_000;
        frame(identityGenome);
        expect(oneEvent('first_viewport_presented')).toMatchObject({
          operation_id: parsed.operation_id,
          sanger_read_revision_id: parsed.sanger_read_revision_id,
          sanger_started_at_ms: 1_000,
          sanger_parse_started_at_ms: 1_000,
          sanger_view_started_at_ms: 2_000,
          occurred_at_ms: 3_000,
        });
        const identityView = oneEvent('first_viewport_presented');
        boundary.clock.now = 4_000;
        act(() => viewState.result.current[1]({ orientation: 'reverse-complement' }));
        await waitFor(() => expect(options().genome).not.toBe(identityGenome));
        expect(viewState.result.current[0].orientation).toBe('reverse-complement');
        expect(options().genome.sequence).toBe('GTACGT');
        expect(useSequenceStore.getState().sequences[documentKey]).toBe(accepted);
        expect(accepted.sequence).toBe('ACGTAC');
        expect(useSequenceStore.getState().getVersion(documentKey)).toBe(version);
        expect(useSequenceStore.getState().draftLineages[documentKey]).toBe(lineage);
        await f.renderer.loadGenome(options().genome);
        act(() => options().onRendererGenomeCommit?.(2));
        const active = f;
        await waitFor(() => expect(lane(active.data.mock.calls).data).not.toBe(identityData));
        frame(options().genome);
        expect(events('first_viewport_presented')).toHaveLength(1);
        f.renderer.render(state());
        const projectedPaint = paintReceipt(f.renderer, f.data.mock.calls);
        expect(projectedPaint.paintCount).toBeGreaterThan(identityPaint.paintCount);
        expect(projectedPaint.receipt).toMatchObject({
          traceVisible: true,
          qualityVisible: true,
          basesVisible: true,
        });
        boundary.clock.now = 5_000;
        frame({ ...options().genome });
        expect(events('first_viewport_presented')).toHaveLength(1);
        frame(options().genome);
        const presentations = events('first_viewport_presented');
        expect(presentations, 'WORKSPACE_PROJECTED_READ_FIRST_VIEWPORT_REQUIRED').toHaveLength(2);
        expect(presentations[1]).toMatchObject({
          operation_id: parsed.operation_id,
          sanger_read_revision_id: parsed.sanger_read_revision_id,
          sanger_started_at_ms: 1_000,
          sanger_parse_started_at_ms: 1_000,
          sanger_view_started_at_ms: 4_000,
          occurred_at_ms: 5_000,
          sanger_trace_visible: true,
          sanger_quality_visible: true,
          sanger_bases_visible: true,
        });
        expect(presentations[1]?.sanger_view_id).toMatch(uuid);
        expect(presentations[1]?.sanger_view_id).not.toBe(identityView.sanger_view_id);
        frame(options().genome);
        expect(events('first_viewport_presented')).toHaveLength(2);
        expect(events('read_requested')).toHaveLength(1);
        expect(events('parsed')).toHaveLength(1);
        expect(boundary.readFile).toHaveBeenCalledTimes(1);
        for (const event of events()) {
          expect(Object.keys(event).filter((key) => !eventKeys.has(key))).toEqual([]);
        }
        for (const canary of [filePath, documentKey, 'ACGTAC', 'GTACGT']) {
          expect(JSON.stringify(events())).not.toContain(canary);
        }
      } finally {
        f?.view.unmount();
        viewState.unmount();
        loaded.unmount();
        clearSequenceViewMemory(documentKey);
        if (previousOrfVisibility === null) localStorage.removeItem('waypoint-orf-visible');
        else localStorage.setItem('waypoint-orf-visible', previousOrfVisibility);
        useCanvasStore.getState().reset();
        useSequenceStore.getState().clearAll();
        expect(boundary.listeners.size).toBe(0);
      }
    });

    it('follows a new native read through a stable nonidentity Workspace projection without reusing its previous binding', async () => {
      const documentId = 'owned-native-workspace-live-projection';
      function nativeSnapshot(): SequenceDocumentSnapshot {
        const parsed = parseBinarySequenceFileAsAnnotated(syntheticAb1(), filePath);
        if (parsed.format !== 'ab1') throw new Error('ACTUAL_NATIVE_WORKSPACE_AB1_REQUIRED');
        const sequence = { ...parsed.sequence, id: documentId };
        const model = createSequenceDocumentModel();
        model.getState().setSequence(documentId, sequence);
        const snapshot = model.getState();
        const draft = snapshot.drafts[documentId];
        const lineage = snapshot.draftLineages[documentId];
        if (!draft || !lineage) throw new Error('ACTUAL_NATIVE_WORKSPACE_LINEAGE_REQUIRED');
        return {
          documentId,
          path: filePath,
          workspaceRoot: '/owned-synthetic',
          revision: 'native-workspace-revision-1',
          persistedRevision: 'native-workspace-revision-1',
          version: 1,
          savedVersion: 1,
          ready: true,
          readOnly: true,
          dirty: false,
          saving: false,
          canUndo: false,
          canRedo: false,
          length: sequence.length,
          annotationCount: 0,
          capabilities: [],
          copy: { sequence, savedSequence: sequence, draft, lineage, version: 1, savedVersion: 1 },
        };
      }
      let renderedSequence: AnnotatedSequence | null = null;
      function NativeWorkspaceCaller() {
        const read = useSequence(filePath, documentId);
        const plasmid = useMemo(
          () => (read.data ? annotatedSequenceToParsedPlasmid(read.data) : null),
          [read.data]
        );
        renderedSequence = read.data;
        return read.data && plasmid ? (
          <WorkspaceViewer
            entityId={documentId}
            sequence={read.data}
            dataLayerSourceSequence={read.data}
            plasmid={plasmid}
            circular={Boolean(read.data.circular)}
            surface="sequence"
            readOnly
            hideMinimap
          />
        ) : null;
      }
      useSequenceStore.getState().clearAll();
      useCanvasStore.getState().reset();
      writeSequenceViewMemory(documentId, {
        rendererVisibility: 'sequence',
        orientation: 'reverse-complement',
        zoom: 100,
      });
      const previousOrfVisibility = localStorage.getItem('waypoint-orf-visible');
      localStorage.setItem('waypoint-orf-visible', 'false');
      useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: documentId,
        label: documentId,
        sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
        loadStatus: 'loaded',
      });
      boundary.nativeTransportEnabled = true;
      const initial = nativeSnapshot();
      if (!initial.copy) throw new Error('ACTUAL_NATIVE_WORKSPACE_INITIAL_COPY_REQUIRED');
      useSequenceStore.getState().setSequence(documentId, initial.copy.sequence);
      const native = new SequenceDocumentClientBridge(useSequenceStore);
      boundary.execute.mockReset().mockResolvedValue(initial);
      let watcher:
        | { result: { current: ReturnType<typeof useFileWatcher> }; unmount(): void }
        | undefined;
      let f: Awaited<ReturnType<typeof mountViewer>> | undefined;
      try {
        await native.execute(documentId, { kind: 'reload' }, { expectedVersion: 1 });
        boundary.native = native;
        const before = useSequenceStore.getState();
        const working = before.sequences[documentId];
        if (!working) throw new Error('ACTUAL_NATIVE_WORKSPACE_WORKING_READ_REQUIRED');
        const first = nativeSnapshot();
        if (!first.copy) throw new Error('ACTUAL_NATIVE_WORKSPACE_FIRST_COPY_REQUIRED');
        boundary.execute.mockReset().mockResolvedValue(first);
        const mountedWatcher = renderHook(() =>
          useFileWatcher({ filePath, documentId, isDirty: false })
        );
        watcher = mountedWatcher;
        await act(async () => {
          await mountedWatcher.result.current.reloadFromDisk();
        });
        expect(useSequenceStore.getState().sequences[documentId]).toBe(working);
        expect(useSequenceStore.getState().getVersion(documentId)).toBe(1);
        expect(useSequenceStore.getState().draftLineages[documentId]).toBe(first.copy.lineage);
        const firstRead = oneEvent('revision_ready');
        boundary.clock.now = 2_000;
        f = await mountViewer(working, undefined, <NativeWorkspaceCaller />);
        expect(renderedSequence).toBe(working);
        expect(working.sequence).toBe('ACGTAC');
        const projectedGenome = options().genome;
        expect(projectedGenome.sequence).toBe('GTACGT');
        const projectedData = lane(f.data.mock.calls).data;
        f.renderer.render(state());
        const firstPaint = paintReceipt(f.renderer, f.data.mock.calls);
        expect(firstPaint.receipt).toMatchObject({
          traceVisible: true,
          qualityVisible: true,
          basesVisible: true,
        });
        boundary.clock.now = 3_000;
        frame(projectedGenome);
        const firstPresentation = oneEvent('first_viewport_presented');
        expect(firstPresentation).toMatchObject({
          operation_id: firstRead.operation_id,
          sanger_read_revision_id: firstRead.sanger_read_revision_id,
          sanger_started_at_ms: 1_000,
          sanger_view_started_at_ms: 2_000,
          occurred_at_ms: 3_000,
        });
        const next = nativeSnapshot();
        if (!next.copy) throw new Error('ACTUAL_NATIVE_WORKSPACE_NEXT_COPY_REQUIRED');
        expect(next.copy.sequence).not.toBe(working);
        expect(next.copy.lineage).not.toBe(first.copy.lineage);
        boundary.execute.mockResolvedValue(next);
        boundary.clock.now = 4_000;
        await act(async () => {
          await mountedWatcher.result.current.reloadFromDisk();
        });
        const current = useSequenceStore.getState();
        expect(current.getVersion(documentId)).toBe(1);
        expect(current.savedVersions[documentId]).toBe(1);
        expect(current.sequences[documentId]).toBe(working);
        expect(current.draftLineages[documentId]).toBe(next.copy.lineage);
        expect(renderedSequence).toBe(working);
        expect(working.sequence).toBe('ACGTAC');
        expect(options().genome).toBe(projectedGenome);
        expect(lane(f.data.mock.calls).data).toBe(projectedData);
        const reads = events('revision_ready');
        expect(reads).toHaveLength(2);
        const accepted = reads[1];
        if (!accepted) throw new Error('ACTUAL_CURRENT_NATIVE_WORKSPACE_READ_REQUIRED');
        expect(accepted.operation_id).not.toBe(firstRead.operation_id);
        expect(accepted.sanger_read_revision_id).not.toBe(firstRead.sanger_read_revision_id);
        expect(accepted.sanger_started_at_ms).toBe(4_000);
        expect(accepted.sanger_parse_started_at_ms).toBeUndefined();
        frame(projectedGenome);
        expect(events('first_viewport_presented')).toHaveLength(1);
        f.renderer.render(state());
        const painted = paintReceipt(f.renderer, f.data.mock.calls);
        expect(painted.paintCount).toBeGreaterThan(firstPaint.paintCount);
        expect(painted.receipt).toMatchObject({
          traceVisible: true,
          qualityVisible: true,
          basesVisible: true,
        });
        boundary.clock.now = 5_000;
        frame(projectedGenome);
        const presented = events('first_viewport_presented');
        expect(presented, 'LIVE_PROJECTED_NATIVE_READ_BINDING_REQUIRED').toHaveLength(2);
        expect(presented[1]).toMatchObject({
          operation_id: accepted.operation_id,
          sanger_read_revision_id: accepted.sanger_read_revision_id,
          sanger_origin: 'native_reload',
          sanger_started_at_ms: 4_000,
          sanger_view_started_at_ms: 4_000,
          occurred_at_ms: 5_000,
          sanger_trace_visible: true,
          sanger_quality_visible: true,
          sanger_bases_visible: true,
        });
        expect(presented[1]?.sanger_view_id).toMatch(uuid);
        expect(presented[1]?.sanger_view_id).not.toBe(firstPresentation.sanger_view_id);
        frame(projectedGenome);
        expect(events('first_viewport_presented')).toHaveLength(2);
        expect(events('read_requested')).toHaveLength(2);
        expect(events('parsed')).toEqual([]);
        expect(boundary.readFile).not.toHaveBeenCalled();
        for (const event of events()) {
          expect(Object.keys(event).filter((key) => !eventKeys.has(key))).toEqual([]);
        }
        for (const canary of [
          filePath,
          documentId,
          'native-workspace-revision-1',
          'ACGTAC',
          'GTACGT',
        ]) {
          expect(JSON.stringify(events())).not.toContain(canary);
        }
      } finally {
        f?.view.unmount();
        watcher?.unmount();
        await native.flush('discard');
        boundary.native = undefined;
        boundary.nativeTransportEnabled = false;
        clearSequenceViewMemory(documentId);
        if (previousOrfVisibility === null) localStorage.removeItem('waypoint-orf-visible');
        else localStorage.setItem('waypoint-orf-visible', previousOrfVisibility);
        useCanvasStore.getState().reset();
        useSequenceStore.getState().clearAll();
        expect(boundary.listeners.size).toBe(0);
      }
    });
  });
});
