// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TabularFileViewerTab } from './TabularFileViewerTab';
import { useCanvasStore } from '../features/canvas/store';
import {
  __resetReadableContentTelemetryForTests,
  registerCanvasReadRequest,
  commitCanvasReadPlacement,
} from '../lib/readable-content-telemetry';
import type { observeWorkflowAction } from '../lib/workflow-telemetry';

const ports = vi.hoisted(() => ({
  stat: vi.fn(),
  readTextFile: vi.fn(),
  readTextFileSlice: vi.fn(),
  writeTextFile: vi.fn(),
  observe: vi.fn<typeof observeWorkflowAction>(() => true),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: ports.stat,
      readTextFile: ports.readTextFile,
      readTextFileSlice: ports.readTextFileSlice,
      writeTextFile: ports.writeTextFile,
    },
  }),
}));
vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));
vi.mock('../lib/workflow-telemetry', () => ({ observeWorkflowAction: ports.observe }));

const operation = { id: '550e8400-e29b-41d4-a716-446655440005', initiatedAtMs: 100 };
const laterOperation = { id: '550e8400-e29b-41d4-a716-446655440006', initiatedAtMs: 200 };
const path = '/synthetic/current.csv';
let tabId: string;
const receipts = () =>
  ports.observe.mock.calls.filter(([input]) => input.operationId !== undefined);
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function place(op = operation) {
  registerCanvasReadRequest({ panelId: 'main', tabId, operation: op });
  return commitCanvasReadPlacement(op);
}

beforeEach(() => {
  vi.clearAllMocks();
  ports.observe.mockReset().mockReturnValue(true);
  ports.stat.mockResolvedValue({ size: 32 });
  ports.writeTextFile.mockResolvedValue(undefined);
  useCanvasStore.getState().reset();
  __resetReadableContentTelemetryForTests();
  tabId = useCanvasStore
    .getState()
    .openTab('main', { type: 'table', entityId: path, label: 'Synthetic table' });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  __resetReadableContentTelemetryForTests();
  useCanvasStore.getState().reset();
});

describe('CV1 real table read/parse/grid generation and canvas placement', () => {
  it('does not settle while reading, then joins the committed real parsed grid to its operation', async () => {
    const read = defer<string>();
    ports.readTextFile.mockReturnValue(read.promise);
    render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    expect(place()).toBe(false);
    expect(receipts()).toHaveLength(0);
    await act(async () => {
      read.resolve('sample,value\nA,7\n');
    });
    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    await waitFor(() => expect(receipts()).toHaveLength(1));
    expect(receipts()[0][0]).toMatchObject({
      workflow: 'content',
      action: 'view',
      status: 'viewed',
      success: true,
      operationId: operation.id,
      initiator: 'system',
    });
    expect(JSON.stringify(receipts()[0][0])).not.toContain(path);
  });

  it('settles a later deliberate return to the already parsed mounted table without another read', async () => {
    ports.readTextFile.mockResolvedValue('sample,value\nA,7\n');
    render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(receipts()).toHaveLength(0);
    expect(place()).toBe(true);
    expect(place(laterOperation)).toBe(true);
    expect(ports.readTextFile).toHaveBeenCalledTimes(1);
    expect(receipts().map(([input]) => input.operationId)).toEqual([
      operation.id,
      laterOperation.id,
    ]);
    expect(receipts()[0][0].actionId).toBe(receipts()[1][0].actionId);
  });

  it('does not settle the new generation when an old same-path load completes after remount', async () => {
    const old = defer<string>();
    const current = defer<string>();
    ports.readTextFile.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    await waitFor(() => expect(ports.readTextFile).toHaveBeenCalledTimes(1));
    place();
    view.unmount();
    render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    await waitFor(() => expect(ports.readTextFile).toHaveBeenCalledTimes(2));
    place(laterOperation);
    await act(async () => {
      old.resolve('sample,value\nOLD,1\n');
    });
    expect(receipts()).toHaveLength(0);
    await act(async () => {
      current.resolve('sample,value\nCURRENT,2\n');
    });
    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    await waitFor(() => expect(receipts()).toHaveLength(1));
    expect(receipts()[0][0].operationId).toBe(laterOperation.id);
  });

  it('does not settle an inactive table after its read completes', async () => {
    const read = defer<string>();
    ports.readTextFile.mockReturnValue(read.promise);
    render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    place();
    act(() => {
      useCanvasStore
        .getState()
        .openTab('main', { type: 'text', entityId: '/synthetic/other.txt', label: 'Other' });
    });
    await act(async () => {
      read.resolve('sample,value\nA,7\n');
    });
    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(receipts()).toHaveLength(0);
  });

  it('does not call an unsupported parse fallback readable', async () => {
    render(
      <TabularFileViewerTab canvasTabId={tabId} filePath={path} sourceFileName="unsupported.bin" />
    );
    place();
    await waitFor(() => expect(receipts()).toHaveLength(1));
    expect(receipts()[0][0]).toMatchObject({ status: 'failed', success: false });
    expect(receipts().some(([input]) => input.status === 'viewed')).toBe(false);
  });

  it('does not settle the original target after its tab is retargeted during the real read', async () => {
    const read = defer<string>();
    ports.readTextFile.mockReturnValue(read.promise);
    render(<TabularFileViewerTab canvasTabId={tabId} filePath={path} />);
    place();
    act(() =>
      useCanvasStore.getState().updateTab('main', tabId, { entityId: '/synthetic/replacement.csv' })
    );
    await act(async () => {
      read.resolve('sample,value\nA,7\n');
    });
    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(receipts()).toHaveLength(0);
  });
});
