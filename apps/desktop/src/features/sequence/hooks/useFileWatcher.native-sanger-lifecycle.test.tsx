import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSequenceDocumentModel } from '../sequence-document-model';
import { SequenceDocumentClientBridge } from '../sequence-document-client';
import { useSequenceStore } from '../store';
import { parseBinarySequenceFileAsAnnotated } from '../../../shared/parse-sequence-file';
import type {
  SequenceDocumentRequest,
  SequenceDocumentSnapshot,
} from '../../../shared/sequence-document';
import { useFileWatcher } from './useFileWatcher';

const boundary = vi.hoisted(() => ({
  native: undefined as SequenceDocumentClientBridge | undefined,
  ready: true,
  generation: 17,
  execute: vi.fn<(request: SequenceDocumentRequest) => Promise<SequenceDocumentSnapshot>>(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  track: vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>(() => false),
}));

vi.mock('../sequence-document-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sequence-document-client')>()),
  getNativeSequenceDocumentClient: () => boundary.native,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      sequenceDocument: boundary.execute,
      isSequenceDocumentAvailable: async () => true,
      readFile: boundary.readFile,
      readTextFile: boundary.readTextFile,
      watchFile: async () => {},
      unwatchFile: async () => {},
    },
    on: () => () => {},
  }),
}));
vi.mock('../../../db/workspace-catalog', () => ({ findWorkspaceRootForPath: () => null }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('../../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => boundary.generation,
  isAnalyticsCaptureReady: () => boundary.ready,
  trackRendererEvent: boundary.track,
}));

const documentId = 'PRIVATE_NATIVE_DOCUMENT_CANARY';
const filePath = '/owned-synthetic/PRIVATE_NATIVE_FILE_CANARY.ab1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ab1() {
  const text = (value: string) => Uint8Array.from(value, (character) => character.charCodeAt(0));
  const shorts = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, false));
    return bytes;
  };
  const entries = [
    { tag: 'PBAS', number: 2, size: 1, data: text('ACGTAC') },
    { tag: 'PCON', number: 2, size: 1, data: new Uint8Array(6).fill(40) },
    { tag: 'PLOC', number: 2, size: 2, data: shorts([1, 3, 5, 7, 9, 11]) },
    { tag: 'FWO_', number: 1, size: 1, data: text('ACGT') },
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
    bytes.set(text(entry.tag), offset);
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

function snapshot(version: number, bases = 'ACGTAC', id = documentId): SequenceDocumentSnapshot {
  const decoded = parseBinarySequenceFileAsAnnotated(ab1(), filePath);
  if (decoded.format !== 'ab1') throw new Error('ACTUAL_AB1_FIXTURE_REQUIRED');
  const sequence = {
    ...decoded.sequence,
    id,
    name: 'PRIVATE_NATIVE_SEQUENCE_CANARY',
    sequence: bases,
    length: bases.length,
  };
  const model = createSequenceDocumentModel();
  model.getState().setSequence(id, sequence);
  const state = model.getState();
  const draft = state.drafts[id];
  const lineage = state.draftLineages[id];
  if (!draft || !lineage) throw new Error('ACTUAL_NATIVE_COPY_LINEAGE_REQUIRED');
  return {
    documentId: id,
    path: filePath,
    workspaceRoot: '/owned-synthetic',
    revision: `native-revision-${version}`,
    persistedRevision: `native-revision-${version}`,
    version,
    savedVersion: version,
    ready: true,
    readOnly: true,
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    length: sequence.length,
    annotationCount: 0,
    capabilities: [],
    copy: { sequence, savedSequence: sequence, draft, lineage, version, savedVersion: version },
  };
}

type Pending = {
  request: SequenceDocumentRequest;
  resolve: (result: SequenceDocumentSnapshot) => void;
  reject: (reason: Error) => void;
};
const pending: Pending[] = [];

function events() {
  return boundary.track.mock.calls
    .filter(([event]) => event === 'sanger_read_stage')
    .map(([, properties]) => properties ?? {});
}

function stage(name: string, operation?: unknown) {
  const matching = events().filter(
    (event) =>
      event.sanger_stage === name && (operation === undefined || event.operation_id === operation)
  );
  expect(matching, `NATIVE_AB1_${name.toUpperCase()}_LIFECYCLE_REQUIRED`).toHaveLength(1);
  const event = matching[0];
  if (!event) throw new Error('ACTUAL_NATIVE_RELOAD_LIFECYCLE_REQUIRED');
  return event;
}

function currentRequest(index: number) {
  const value = pending[index];
  if (!value) throw new Error('ACTUAL_NATIVE_RELOAD_REQUEST_REQUIRED');
  return value;
}

function mount(path = filePath) {
  const onReload = vi.fn();
  const hook = renderHook(
    ({ currentPath }) =>
      useFileWatcher({ filePath: currentPath, documentId, isDirty: false, onReload }),
    { initialProps: { currentPath: path } }
  );
  return { ...hook, onReload };
}

async function start(hook: ReturnType<typeof mount>, count = 1) {
  let result: Promise<void> = Promise.resolve();
  act(() => {
    result = hook.result.current.reloadFromDisk();
  });
  await waitFor(() => expect(boundary.execute).toHaveBeenCalledTimes(count));
  return { result };
}

async function finish(index: number, result: Promise<void>, value = snapshot(index + 2)) {
  await act(async () => {
    currentRequest(index).resolve(value);
    await result;
  });
}

function assertPrivateEvents() {
  const keys = new Set([
    'feature_area',
    'operation_id',
    'sanger_stage',
    'sanger_origin',
    'sanger_classification',
    'sanger_started_at_ms',
    'sanger_read_revision_id',
    'sanger_reason',
    'occurred_at_ms',
  ]);
  for (const event of events()) {
    for (const [key, value] of Object.entries(event)) {
      if (value !== undefined)
        expect(keys.has(key), `UNDECLARED_NATIVE_READ_PROPERTY:${key}`).toBe(true);
    }
    expect(event.sanger_origin).toBe('native_reload');
    expect(event.operation_id).toMatch(uuid);
    expect(event.sanger_parse_started_at_ms).toBeUndefined();
    const encoded = JSON.stringify(event);
    for (const secret of [
      documentId,
      filePath,
      'PRIVATE_NATIVE_SEQUENCE_CANARY',
      'ACGTAC',
      'TTTTAC',
      'native-revision-',
    ]) {
      expect(encoded).not.toContain(secret);
    }
  }
  expect(
    events().filter((event) => ['parse_started', 'parsed'].includes(String(event.sanger_stage)))
  ).toEqual([]);
  expect(boundary.readFile).not.toHaveBeenCalled();
  expect(boundary.readTextFile).not.toHaveBeenCalled();
}

beforeEach(async () => {
  delete document.documentElement.dataset.dnaforgeRuntime;
  boundary.ready = true;
  boundary.generation = 17;
  boundary.track.mockReset().mockReturnValue(false);
  boundary.readFile.mockReset();
  boundary.readTextFile.mockReset();
  useSequenceStore.getState().clearAll();
  const initial = snapshot(1);
  if (!initial.copy) throw new Error('ACTUAL_NATIVE_INITIAL_COPY_REQUIRED');
  useSequenceStore.getState().setSequence(documentId, initial.copy.sequence);
  const bridge = new SequenceDocumentClientBridge(useSequenceStore);
  boundary.execute.mockReset().mockResolvedValue(initial);
  await bridge.execute(documentId, { kind: 'reload' }, { expectedVersion: 1 });
  boundary.native = bridge;
  boundary.execute.mockReset().mockImplementation(
    (request) =>
      new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject });
      })
  );
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const item of pending.splice(0)) item.resolve(snapshot(50));
    await boundary.native?.flush('discard');
  });
  boundary.native = undefined;
  useSequenceStore.getState().clearAll();
  vi.restoreAllMocks();
});

describe('native AB1 reload lifecycle ownership', () => {
  it('records the actually accepted native revision without inventing a renderer parse clock', async () => {
    const hook = mount();
    const before = Date.now();
    const run = await start(hook);
    expect(currentRequest(0).request).toMatchObject({
      documentId,
      operation: { kind: 'reload' },
      expectedVersion: 1,
      projection: 'document',
    });
    const accepted = snapshot(2);
    await finish(0, run.result, accepted);
    expect(useSequenceStore.getState().getVersion(documentId)).toBe(accepted.version);
    expect(useSequenceStore.getState().sequences[documentId]).toBe(accepted.copy?.sequence);
    expect(hook.onReload).toHaveBeenCalledTimes(1);
    const requested = stage('read_requested');
    const ready = stage('revision_ready', requested.operation_id);
    expect(events().map((event) => event.sanger_stage)).toEqual([
      'read_requested',
      'revision_ready',
    ]);
    expect(requested.sanger_classification).toBe('requested_ab1');
    expect(ready.sanger_classification).toBe('decoded_ab1');
    expect(ready.sanger_read_revision_id).toMatch(uuid);
    expect(ready.sanger_read_revision_id).not.toBe(ready.operation_id);
    expect(requested.sanger_started_at_ms).toBeGreaterThanOrEqual(before);
    expect(ready.sanger_started_at_ms).toBe(requested.sanger_started_at_ms);
    expect(ready.occurred_at_ms).toBeGreaterThanOrEqual(Number(requested.sanger_started_at_ms));
    expect(ready.occurred_at_ms).toBeLessThanOrEqual(Date.now());
    assertPrivateEvents();
  });

  it('supersedes a queued native result that was never the current accepted projection', async () => {
    const hook = mount();
    const first = await start(hook);
    let second: Promise<void> = Promise.resolve();
    act(() => {
      second = hook.result.current.reloadFromDisk();
    });
    await finish(0, first.result, snapshot(2));
    await waitFor(() => expect(boundary.execute).toHaveBeenCalledTimes(2));
    const accepted = snapshot(3, 'TTTTAC');
    await finish(1, second, accepted);
    expect(useSequenceStore.getState().getVersion(documentId)).toBe(3);
    expect(useSequenceStore.getState().sequences[documentId]).toBe(accepted.copy?.sequence);
    expect(hook.onReload).toHaveBeenCalledTimes(1);
    const requests = events().filter((event) => event.sanger_stage === 'read_requested');
    expect(requests, 'EACH_NATIVE_RELOAD_MUST_OWN_ONE_REQUEST').toHaveLength(2);
    expect(requests[0]?.operation_id).not.toBe(requests[1]?.operation_id);
    stage('read_superseded', requests[0]?.operation_id);
    stage('revision_ready', requests[1]?.operation_id);
    expect(events().filter((event) => event.sanger_stage === 'revision_ready')).toHaveLength(1);
    assertPrivateEvents();
  });

  it('withholds readiness when a newer observed native snapshot replaces the returned result', async () => {
    const hook = mount();
    const run = await start(hook);
    const newer = snapshot(3, 'TTTTAC');
    let replaced = false;
    const detach = useSequenceStore.subscribe((state) => {
      if (!replaced && state.getVersion(documentId) === 2) {
        replaced = true;
        boundary.native?.observe(newer);
      }
    });
    try {
      await finish(0, run.result, snapshot(2));
    } finally {
      detach();
    }
    expect(replaced).toBe(true);
    expect(useSequenceStore.getState().getVersion(documentId)).toBe(3);
    expect(useSequenceStore.getState().sequences[documentId]).toBe(newer.copy?.sequence);
    expect(hook.onReload).not.toHaveBeenCalled();
    const requested = stage('read_requested');
    stage('read_superseded', requested.operation_id);
    expect(events().filter((event) => event.sanger_stage === 'revision_ready')).toEqual([]);
    assertPrivateEvents();
  });

  it('never accepts a late native result after path replacement or unmount', async () => {
    for (const close of ['replace', 'unmount']) {
      boundary.track.mockClear();
      boundary.execute.mockClear();
      pending.length = 0;
      const hook = mount();
      const run = await start(hook);
      if (close === 'replace')
        hook.rerender({ currentPath: '/owned-synthetic/PRIVATE_REPLACEMENT.ab1' });
      else hook.unmount();
      await finish(0, run.result, snapshot(close === 'replace' ? 2 : 3));
      expect(hook.onReload).not.toHaveBeenCalled();
      const requested = stage('read_requested');
      const terminal = events().filter(
        (event) =>
          event.operation_id === requested.operation_id && event.sanger_stage !== 'read_requested'
      );
      expect(terminal).toHaveLength(1);
      expect(['read_cancelled', 'read_superseded']).toContain(terminal[0]?.sanger_stage);
      expect(events().filter((event) => event.sanger_stage === 'revision_ready')).toEqual([]);
      assertPrivateEvents();
      hook.unmount();
    }
  });

  it('retains native failure and keeps analytics transport errors outside accepted reload behavior', async () => {
    const hook = mount();
    const failed = await start(hook);
    await act(async () => {
      currentRequest(0).reject(new Error('PRIVATE_NATIVE_FAILURE_CANARY'));
      await failed.result;
    });
    expect(hook.onReload).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().getVersion(documentId)).toBe(1);
    expect(stage('read_failed')).toMatchObject({ sanger_reason: 'source_unavailable' });
    expect(JSON.stringify(events())).not.toContain('PRIVATE_NATIVE_FAILURE_CANARY');
    assertPrivateEvents();
    boundary.track.mockClear().mockImplementation(() => {
      throw new Error('PRIVATE_ANALYTICS_CANARY');
    });
    const accepted = await start(hook, 2);
    await finish(1, accepted.result, snapshot(2));
    expect(boundary.track).toHaveBeenCalled();
    expect(useSequenceStore.getState().getVersion(documentId)).toBe(2);
    expect(hook.onReload).toHaveBeenCalledTimes(1);
  });

  it('preserves capture eligibility and generation fences across native completion', async () => {
    for (const mode of ['not-eligible', 'generation-changed', 'disabled']) {
      boundary.track.mockClear();
      boundary.execute.mockClear();
      pending.length = 0;
      boundary.ready = mode !== 'not-eligible';
      const hook = mount();
      const nextVersion = useSequenceStore.getState().getVersion(documentId) + 1;
      const run = await start(hook);
      const requested = events().filter((event) => event.sanger_stage === 'read_requested');
      if (mode === 'not-eligible') boundary.ready = true;
      if (mode === 'generation-changed') boundary.generation += 1;
      if (mode === 'disabled') boundary.ready = false;
      await finish(0, run.result, snapshot(nextVersion));
      expect(hook.onReload).toHaveBeenCalledTimes(1);
      expect(events()).toEqual(requested);
      expect(requested).toHaveLength(mode === 'not-eligible' ? 0 : 1);
      assertPrivateEvents();
      hook.unmount();
      boundary.ready = true;
    }
  });

  it('keeps non-AB1 native reloads and dirty pre-dispatch refusals out of Sanger read intent', async () => {
    const ordinary = mount('/owned-synthetic/PRIVATE_NON_AB1.gb');
    const run = await start(ordinary);
    await finish(0, run.result, snapshot(2));
    expect(ordinary.onReload).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([]);
    ordinary.unmount();
    boundary.execute.mockClear();
    const dirty = mount();
    act(() => useSequenceStore.getState().dispatchEdit(documentId, { type: 'INSERT', text: 'T' }));
    await act(async () => {
      await dirty.result.current.reloadFromDisk();
    });
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(dirty.result.current.showExternalChangeToast).toBe(true);
    expect(dirty.onReload).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    assertPrivateEvents();
  });
});

it('accepts an unchanged native version through the actual restore receipt while preserving existing sequence references', async () => {
  const hook = mount();
  const initial = useSequenceStore.getState();
  const initialWorking = initial.sequences[documentId];
  const initialSaved = initial.savedSequences[documentId];
  const returned = snapshot(1);
  if (!returned.copy) throw new Error('UNCHANGED_NATIVE_COPY_REQUIRED');
  expect(returned.copy.sequence).not.toBe(initialWorking);
  expect(returned.copy.savedSequence).not.toBe(initialSaved);
  expect(returned.copy.draft).not.toBe(initial.drafts[documentId]);
  expect(returned.copy.lineage).not.toBe(initial.draftLineages[documentId]);
  const run = await start(hook);
  await finish(0, run.result, returned);
  const current = useSequenceStore.getState();
  expect(current.getVersion(documentId)).toBe(1);
  expect(current.savedVersions[documentId]).toBe(1);
  expect(current.sequences[documentId]).toBe(initialWorking);
  expect(current.savedSequences[documentId]).toBe(initialSaved);
  expect(current.drafts[documentId]).toBe(returned.copy.draft);
  expect(current.draftLineages[documentId]).toBe(returned.copy.lineage);
  expect(hook.onReload).toHaveBeenCalledTimes(1);
  const requested = stage('read_requested');
  const accepted = stage('revision_ready', requested.operation_id);
  expect(events().map((event) => event.sanger_stage)).toEqual(['read_requested', 'revision_ready']);
  expect(accepted.sanger_classification).toBe('decoded_ab1');
  expect(accepted.sanger_read_revision_id).toMatch(uuid);
  expect(accepted.sanger_read_revision_id).not.toBe(accepted.operation_id);
  assertPrivateEvents();
});

it('uses the preceding native result version for a queued reload CAS without reusing the prequeue version', async () => {
  const hook = mount();
  const first = await start(hook);
  const acceptedFirst = snapshot(2);
  expect(currentRequest(0).request).toMatchObject({
    documentId,
    operation: { kind: 'reload' },
    expectedVersion: 1,
    projection: 'document',
  });
  let second: Promise<void> = Promise.resolve();
  act(() => {
    second = hook.result.current.reloadFromDisk();
  });
  expect(boundary.execute).toHaveBeenCalledTimes(1);
  await finish(0, first.result, acceptedFirst);
  await waitFor(() => expect(boundary.execute).toHaveBeenCalledTimes(2));
  expect(currentRequest(1).request).toMatchObject({
    documentId,
    operation: { kind: 'reload' },
    expectedVersion: acceptedFirst.version,
    projection: 'document',
  });
  const acceptedLast = snapshot(3, 'TTTTAC');
  await finish(1, second, acceptedLast);
  expect(useSequenceStore.getState().getVersion(documentId)).toBe(acceptedLast.version);
  expect(useSequenceStore.getState().sequences[documentId]).toBe(acceptedLast.copy?.sequence);
  expect(hook.onReload).toHaveBeenCalledTimes(1);
  assertPrivateEvents();
});
