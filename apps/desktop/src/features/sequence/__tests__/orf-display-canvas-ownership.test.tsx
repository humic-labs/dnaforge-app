import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findORFs } from '@waypoint/sequence-utils';
import { SequenceViewer } from '../../../../../../packages/core/workspace-editor/src/SequenceViewer';
import { useORFs } from '../../../../../../packages/core/workspace-editor/src/orfs/useORFs';
import type {
  ORFWorkerRequest,
  ORFWorkerResponse,
} from '../../../../../../packages/core/workspace-editor/src/orfs/orf-worker-protocol';
import type { OrfPresentation } from '../../../../../../packages/core/workspace-editor/src/orfs/orf-observation';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';
import * as correlation from '../../../lib/telemetry-correlation';
import { abandonOpenWorkflowActions } from '../../../lib/workflow-telemetry';
import { createOrfDetectionObserver, ORF_DETECTION_OBSERVED } from '../orf-detection-observation';
import { createOrfDisplayObserver, ORF_DISPLAY_OBSERVED } from '../orf-display-observation';

type Fact = Parameters<OrfPresentation['presented']>[0];
const paints = vi.hoisted(() => ({
  frames: [] as Array<{
    owner: OrfPresentation['presented'];
    fact: Fact;
    sequenceLength: number;
    deliver(): void;
  }>,
}));
const workerMock = vi.hoisted(() => {
  class MockWorker extends EventTarget {
    static instances: MockWorker[] = [];
    messages: ORFWorkerRequest[] = [];
    constructor() {
      super();
      MockWorker.instances.push(this);
    }
    postMessage(message: ORFWorkerRequest) {
      this.messages.push(message);
    }
    terminate() {}
    emit(message: ORFWorkerResponse) {
      this.dispatchEvent(new MessageEvent('message', { data: message }));
    }
  }
  return { MockWorker };
});
vi.mock(
  '../../../../../../packages/core/workspace-editor/src/orfs/orf-worker?worker&inline',
  () => ({
    default: workerMock.MockWorker,
  })
);
vi.mock('../../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => 0,
}));
vi.mock(
  '../../../../../../packages/core/workspace-editor/src/rendering/webgl-drawing-context',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../../../packages/core/workspace-editor/src/rendering/webgl-drawing-context')
    >()),
    getSequenceWebGLContext(canvas: HTMLCanvasElement) {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Recording canvas is unavailable');
      return Object.assign(context, {
        beginFrame: () => true,
        endFrame: () => undefined,
        setPresentationShiftBounds: () => undefined,
        capturePresentationScene: () => undefined,
        presentRows: () => undefined,
      });
    },
  })
);
vi.mock(
  '../../../../../../packages/core/workspace-editor/src/hooks/useCanvasWorkerDraw',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../../../../../packages/core/workspace-editor/src/hooks/useCanvasWorkerDraw')
      >();
    return {
      ...original,
      useCanvasWorkerDraw(params: Parameters<typeof original.useCanvasWorkerDraw>[0]) {
        const owner = params.onOrfsPresented;
        original.useCanvasWorkerDraw({
          ...params,
          onOrfsPresented: owner
            ? (fact) => {
                paints.frames.push({
                  owner,
                  fact,
                  sequenceLength: params.fullSequence.length,
                  deliver: () => owner(fact),
                });
              }
            : undefined,
        });
      },
    };
  }
);

const positive = 'ATG'.repeat(40) + 'TAA';
const empty = 'ATGAAATAA';
function observation() {
  let id = 10;
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const storePending = vi.fn(async () => undefined);
  const dependencies = {
    track(event: string, properties: Record<string, unknown>) {
      events.push({ event, properties });
      return true;
    },
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => true,
    storePending,
  };
  const observeDisplay = createOrfDisplayObserver(dependencies);
  const observeDetection = createOrfDetectionObserver({ ...dependencies, observeDisplay });
  return {
    events,
    storePending,
    observeDetection,
    detectorStarts: () =>
      events.filter(
        (event) =>
          event.event === ORF_DETECTION_OBSERVED && event.properties.action_phase === 'start'
      ),
    display: (parent: unknown) =>
      events.filter(
        (event) =>
          event.event === ORF_DISPLAY_OBSERVED && event.properties.parent_action_id === parent
      ),
  };
}
function Harness({
  bases,
  observe,
}: {
  bases: string;
  observe: ReturnType<typeof createOrfDetectionObserver>;
}) {
  const detection = useORFs(bases, 1, { observationVisible: true, observeDetection: observe });
  return (
    <>
      <button onClick={detection.toggleVisibility}>Toggle ORFs</button>
      <SequenceViewer
        sequence={{
          id: `paint-source-${bases.length}`,
          name: 'paint-source',
          sequence: bases,
          length: bases.length,
          circular: false,
          annotations: [],
        }}
        config={{ charsPerLine: 100 }}
        orfs={detection.detectedORFs}
        onOrfsPresented={detection.onOrfsPresented}
      />
    </>
  );
}
function completeCurrentDetection(expectedCount: number) {
  const worker = workerMock.MockWorker.instances.at(-1);
  const request = worker?.messages.filter((message) => message.type === 'detect').at(-1);
  if (!worker || request?.type !== 'detect') throw new Error('Expected a current detector request');
  const orfs = findORFs(request.sequence, request.minLength, { geneticCode: request.geneticCode });
  expect(orfs).toHaveLength(expectedCount);
  act(() => worker.emit({ type: 'done', jobId: request.jobId, orfs }));
}
async function takeFrame(predicate: (frame: (typeof paints.frames)[number]) => boolean) {
  await waitFor(() => expect(paints.frames.some(predicate)).toBe(true));
  const frame = paints.frames.find(predicate);
  if (!frame) throw new Error('Expected an actual main-thread paint');
  return frame;
}
function assertNoValueProjection(o: ReturnType<typeof observation>) {
  expect(o.storePending).not.toHaveBeenCalled();
  expect(o.events.some((event) => event.event === 'meaningful_activity_completed')).toBe(false);
  for (const { properties } of o.events) {
    for (const key of [
      'sequence',
      'name',
      'path',
      'filename',
      'orfs',
      'coordinates',
      'usable_result',
      'value_delivered',
    ])
      expect(properties).not.toHaveProperty(key);
  }
}

beforeEach(() => {
  paints.frames = [];
  workerMock.MockWorker.instances = [];
  installRecordingCanvas();
  vi.stubGlobal('Worker', workerMock.MockWorker);
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: new DOMRectReadOnly(0, 0, 800, 600),
              borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
              contentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
              devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            },
          ],
          this
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20000);
  localStorage.setItem('waypoint-orf-visible', 'true');
  localStorage.setItem('waypoint-orf-min-length', '100');
  sessionStorage.setItem(
    'dnaforge_telemetry_app_session_id',
    '550e8400-e29b-41d4-a716-446655440001'
  );
  sessionStorage.setItem(
    'dnaforge_telemetry_episode_correlation_id',
    '550e8400-e29b-41d4-a716-446655440002'
  );
  correlation.__resetTelemetryCorrelationForTests();
});
afterEach(() => {
  cleanup();
  abandonOpenWorkflowActions();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it('keeps a held positive Canvas paint with its retired source owner until current empty paint arrives', async () => {
  const o = observation();
  const view = render(<Harness bases={positive} observe={o.observeDetection} />);
  completeCurrentDetection(1);
  const old = await takeFrame((frame) => frame.sequenceLength === positive.length);
  expect(old.fact).toEqual({ kind: 'orf_drawn', surface: 'sequence_canvas' });
  const first = o.detectorStarts()[0].properties.action_id;
  expect(o.display(first).map((event) => event.properties.action_phase)).toEqual(['start']);
  view.rerender(<Harness bases={empty} observe={o.observeDetection} />);
  completeCurrentDetection(0);
  const current = await takeFrame((frame) => frame.sequenceLength === empty.length);
  expect(current.fact).toEqual({ kind: 'empty_model', surface: 'sequence_canvas' });
  const second = o.detectorStarts()[1].properties.action_id;
  expect(second).not.toBe(first);
  expect(o.display(first)[1].properties).toMatchObject({
    action_phase: 'cancel',
    orf_display_result: 'superseded',
  });
  const boundary = o.events.length;
  act(() => {
    old.deliver();
    old.deliver();
  });
  expect(o.events).toHaveLength(boundary);
  expect(o.display(second).map((event) => event.properties.action_phase)).toEqual(['start']);
  act(() => {
    current.deliver();
    current.deliver();
  });
  expect(o.display(second).map((event) => event.properties.action_phase)).toEqual([
    'start',
    'result',
  ]);
  expect(o.display(second)[1].properties).toMatchObject({
    parent_action_id: second,
    orf_display_result: 'empty',
    orf_display_surface: 'sequence_canvas',
    workflow_status: 'no_match',
  });
  const complete = o.events.length;
  act(() => old.deliver());
  expect(o.events).toHaveLength(complete);
  assertNoValueProjection(o);
});

it('readmits an empty cached generation without borrowing its held pre-hide Canvas acknowledgement', async () => {
  const o = observation();
  const view = render(<Harness bases={empty} observe={o.observeDetection} />);
  completeCurrentDetection(0);
  const old = await takeFrame(() => true);
  expect(old.fact).toEqual({ kind: 'empty_model', surface: 'sequence_canvas' });
  const first = o.detectorStarts()[0].properties.action_id;
  fireEvent.click(view.getByRole('button', { name: 'Toggle ORFs' }));
  expect(o.display(first)[1].properties).toMatchObject({
    action_phase: 'cancel',
    orf_display_result: 'view_hidden',
  });
  fireEvent.click(view.getByRole('button', { name: 'Toggle ORFs' }));
  const current = await takeFrame((frame) => frame.owner !== old.owner);
  const second = o.detectorStarts()[1].properties.action_id;
  expect(second).not.toBe(first);
  expect(o.detectorStarts()[1].properties).toMatchObject({ orf_detection_source: 'cache' });
  expect(
    workerMock.MockWorker.instances
      .flatMap((worker) => worker.messages)
      .filter((message) => message.type === 'detect')
  ).toHaveLength(1);
  expect(current.fact).toEqual({ kind: 'empty_model', surface: 'sequence_canvas' });
  const boundary = o.events.length;
  act(() => old.deliver());
  expect(o.events).toHaveLength(boundary);
  expect(o.display(second).map((event) => event.properties.action_phase)).toEqual(['start']);
  act(() => {
    current.deliver();
    current.deliver();
  });
  expect(o.display(second).map((event) => event.properties.action_phase)).toEqual([
    'start',
    'result',
  ]);
  expect(o.display(second)[1].properties).toMatchObject({
    parent_action_id: second,
    orf_display_source: 'cache',
    orf_display_result: 'empty',
    workflow_status: 'no_match',
  });
  assertNoValueProjection(o);
});
