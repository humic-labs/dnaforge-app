import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => {
  const clock = { now: 1_000 };
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  return {
    clock,
    dateNow,
    ready: true,
    generation: 11,
    readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
    readTextFile: vi.fn<(path: string) => Promise<string>>(),
    track: vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>(() => false),
  };
});

vi.mock('./useMockedFileSystem', () => ({
  getFileSystem: async () => ({
    readFile: boundary.readFile,
    readTextFile: boundary.readTextFile,
  }),
}));
vi.mock('../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => boundary.generation,
  isAnalyticsCaptureReady: () => boundary.ready,
  trackRendererEvent: boundary.track,
}));

import { useFileContent } from './useFileContent';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { resetWorkspaceSyncRendererGenerationsForTest } from '../services/workspace-sync-renderer-generation';

const path = '/owned-synthetic/PRIVATE_READ_CANARY.ab1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pendingRead() {
  let finish: (bytes: Uint8Array) => void = () => {
    throw new Error('OWNED_FILE_READ_NOT_ARMED');
  };
  const promise = new Promise<Uint8Array>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: (bytes: Uint8Array) => finish(bytes) };
}

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
  expect(
    matching,
    `INITIAL_AB1_${name.toUpperCase()}_OWNERSHIP_MISSING_OR_DUPLICATED`
  ).toHaveLength(1);
  const result = matching[0];
  if (!result) throw new Error('INITIAL_AB1_READ_LIFECYCLE_MISSING');
  return result;
}

async function settle(read: ReturnType<typeof pendingRead>, bytes = syntheticAb1()) {
  await act(async () => {
    read.resolve(bytes);
    await read.promise;
  });
}

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

function syntheticSnapGene(): Uint8Array {
  const bytes = new Uint8Array(31);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x09;
  view.setUint32(1, 14, false);
  bytes.set(
    Uint8Array.from('SnapGene', (character) => character.charCodeAt(0)),
    5
  );
  view.setUint32(20, 7, false);
  bytes[24] = 0x02;
  bytes.set(
    Uint8Array.from('ACGTAC', (character) => character.charCodeAt(0)),
    25
  );
  return bytes;
}

beforeEach(() => {
  boundary.clock.now = 1_000;
  boundary.ready = true;
  boundary.generation = 11;
  boundary.readFile.mockReset();
  boundary.readTextFile.mockReset();
  boundary.track.mockReset().mockReturnValue(false);
  useWorkspaceStore.setState({ folders: [] });
  resetWorkspaceSyncRendererGenerationsForTest();
});

afterEach(() => {
  resetWorkspaceSyncRendererGenerationsForTest();
});

afterAll(() => boundary.dateNow.mockRestore());

describe('useFileContent initial Sanger read ownership', () => {
  it('binds actual accepted AB1 parse to fresh opaque ownership and original clocks before any view', async () => {
    const read = pendingRead();
    boundary.readFile.mockReturnValueOnce(read.promise).mockResolvedValue(syntheticAb1());
    const first = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      boundary.clock.now = 2_000;
      await settle(read);
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      expect(first.result.current.format).toBe('ab1');
      expect(first.result.current.sequence?.sequence).toBe('ACGTAC');
      expect(first.result.current.acceptedRevision).toBeNull();
      const accepted = stage('parsed');
      const requested = stage('read_requested', accepted.operation_id);
      const parsing = stage('parse_started', accepted.operation_id);
      expect(events().map((event) => event.sanger_stage)).toEqual([
        'read_requested',
        'parse_started',
        'parsed',
      ]);
      expect(requested).toMatchObject({
        feature_area: 'file',
        sanger_origin: 'initial_read',
        sanger_classification: 'requested_ab1',
        sanger_started_at_ms: 1_000,
        occurred_at_ms: 1_000,
      });
      expect(parsing).toMatchObject({
        sanger_started_at_ms: 1_000,
        sanger_parse_started_at_ms: 2_000,
      });
      expect(accepted).toMatchObject({
        sanger_classification: 'decoded_ab1',
        sanger_started_at_ms: 1_000,
        sanger_parse_started_at_ms: 2_000,
        occurred_at_ms: 2_000,
      });
      expect(accepted.operation_id).toMatch(uuid);
      expect(accepted.sanger_read_revision_id).toMatch(uuid);
      expect(accepted.operation_id).not.toBe(accepted.sanger_read_revision_id);
      first.unmount();
      boundary.clock.now = 3_000;
      const reopened = renderHook(() => useFileContent(path));
      try {
        await waitFor(() => expect(reopened.result.current.loading).toBe(false));
        expect(reopened.result.current.format).toBe('ab1');
        const parses = events().filter((event) => event.sanger_stage === 'parsed');
        expect(parses).toHaveLength(2);
        const later = parses[1];
        if (!later) throw new Error('SECOND_ACTUAL_AB1_READ_REQUIRED');
        expect(later.operation_id).toMatch(uuid);
        expect(later.sanger_read_revision_id).toMatch(uuid);
        expect(
          new Set([
            accepted.operation_id,
            accepted.sanger_read_revision_id,
            later.operation_id,
            later.sanger_read_revision_id,
          ]).size
        ).toBe(4);
        expect(later.sanger_started_at_ms).toBe(3_000);
        for (const event of events()) {
          expect(event.sanger_view_id).toBeUndefined();
          expect(event.viewport_operation_id).toBeUndefined();
          expect(event.sanger_view_started_at_ms).toBeUndefined();
          expect(String(event.sanger_stage)).not.toContain('viewport');
        }
        const serialized = JSON.stringify(events());
        expect(serialized).not.toContain(path);
        expect(serialized).not.toContain('PRIVATE_READ_CANARY');
        expect(serialized).not.toContain('ACGTAC');
        expect(serialized).not.toContain('[40,40,40,40,40,40]');
      } finally {
        reopened.unmount();
      }
    } finally {
      await settle(read);
      first.unmount();
    }
  });

  it('prevents a delayed old read from publishing parsed ownership over its replacement', async () => {
    const read = pendingRead();
    boundary.readFile.mockReturnValueOnce(read.promise).mockResolvedValueOnce(syntheticAb1());
    const hook = renderHook(({ file }) => useFileContent(file), { initialProps: { file: path } });
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      boundary.clock.now = 1_100;
      hook.rerender({ file: '/owned-synthetic/SECOND_READ_CANARY.ab1' });
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.format).toBe('ab1');
      const current = hook.result.current.sequence;
      boundary.clock.now = 2_000;
      await settle(read);
      expect(hook.result.current.sequence).toBe(current);
      const requested = events().filter((event) => event.sanger_stage === 'read_requested');
      expect(requested).toHaveLength(2);
      expect(new Set(requested.map((event) => event.operation_id)).size).toBe(2);
      const accepted = stage('parsed');
      expect(accepted.operation_id).toBe(requested[1]?.operation_id);
      expect(accepted.sanger_started_at_ms).toBe(1_100);
      expect(accepted.sanger_parse_started_at_ms).toBe(1_100);
    } finally {
      await settle(read);
      hook.unmount();
    }
  });

  it('settles a cancelled pending read once and never parses its late result', async () => {
    const read = pendingRead();
    boundary.readFile.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      boundary.clock.now = 1_100;
      hook.unmount();
      boundary.clock.now = 2_000;
      await settle(read);
      const requested = stage('read_requested');
      expect(stage('read_cancelled', requested.operation_id)).toMatchObject({
        sanger_reason: 'closed',
        sanger_started_at_ms: 1_000,
        occurred_at_ms: 1_100,
      });
      expect(events().filter((event) => event.sanger_stage === 'parsed')).toEqual([]);
      expect(events().filter((event) => event.sanger_stage === 'parse_started')).toEqual([]);
    } finally {
      await settle(read);
      hook.unmount();
    }
  });

  it('does not revive telemetry for a read begun while capture was ineligible', async () => {
    const read = pendingRead();
    boundary.ready = false;
    boundary.readFile.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      boundary.ready = true;
      boundary.generation += 1;
      await settle(read);
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.format).toBe('ab1');
      expect(events()).toEqual([]);
    } finally {
      await settle(read);
      hook.unmount();
    }
  });

  it('refuses later telemetry from an old capture generation without rejecting the accepted read', async () => {
    const read = pendingRead();
    boundary.readFile.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      boundary.generation += 1;
      await settle(read);
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.format).toBe('ab1');
      expect(events().map((event) => event.sanger_stage)).toEqual(['read_requested']);
    } finally {
      await settle(read);
      hook.unmount();
    }
  });

  it('does not relabel an actually decoded SnapGene binary as AB1', async () => {
    boundary.readFile.mockResolvedValueOnce(syntheticSnapGene());
    const hook = renderHook(() => useFileContent('/owned-synthetic/NOT_AB1_CANARY.dna'));
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.format).toBe('snapgene');
      expect(hook.result.current.sequence?.sequence).toBe('ACGTAC');
      expect(events()).toEqual([]);
    } finally {
      hook.unmount();
    }
  });

  it('keeps failed AB1 decoding in requested classification without inventing parsed ownership', async () => {
    boundary.readFile.mockResolvedValueOnce(new Uint8Array([0]));
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.sequence).toBeNull();
      expect(hook.result.current.errorClass).toBe('parse_failed');
      expect(stage('read_failed')).toMatchObject({
        sanger_classification: 'requested_ab1',
        sanger_reason: 'decode',
      });
      expect(events().filter((event) => event.sanger_classification === 'decoded_ab1')).toEqual([]);
      expect(events().filter((event) => event.sanger_stage === 'parsed')).toEqual([]);
    } finally {
      hook.unmount();
    }
  });

  it('keeps the accepted read and cleanup intact when the existing analytics transport throws', async () => {
    const read = pendingRead();
    boundary.readFile.mockReturnValueOnce(read.promise);
    boundary.track.mockImplementation(() => {
      throw new Error('UNIT_ANALYTICS_TRANSPORT_CANARY');
    });
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(boundary.readFile).toHaveBeenCalledTimes(1));
      await settle(read);
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(boundary.track).toHaveBeenCalledWith('sanger_read_stage', expect.any(Object));
      expect(hook.result.current.format).toBe('ab1');
      expect(hook.result.current.sequence?.sequence).toBe('ACGTAC');
      expect(hook.result.current.acceptedRevision).toBeNull();
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.errorClass).toBeNull();
      expect(() => hook.unmount()).not.toThrow();
    } finally {
      await settle(read);
      hook.unmount();
    }
  });

  it('labels the existing explicit reload as local_reload with a fresh read clock and identity', async () => {
    boundary.readFile.mockResolvedValue(syntheticAb1());
    const hook = renderHook(() => useFileContent(path));
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.format).toBe('ab1');
      const first = stage('parsed');
      expect(first.sanger_origin).toBe('initial_read');
      boundary.clock.now = 3_000;
      let reloadResult: unknown;
      await act(async () => {
        reloadResult = await hook.result.current.reload();
      });
      expect(reloadResult).toBeUndefined();
      expect(boundary.readFile).toHaveBeenCalledTimes(2);
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.format).toBe('ab1');
      expect(hook.result.current.sequence?.sequence).toBe('ACGTAC');
      expect(hook.result.current.error).toBeNull();
      const accepted = events().filter((event) => event.sanger_stage === 'parsed');
      expect(accepted).toHaveLength(2);
      const reloaded = accepted[1];
      if (!reloaded) throw new Error('ACTUAL_EXPLICIT_AB1_RELOAD_REQUIRED');
      expect(reloaded).toMatchObject({
        sanger_origin: 'local_reload',
        sanger_classification: 'decoded_ab1',
        sanger_started_at_ms: 3_000,
        sanger_parse_started_at_ms: 3_000,
      });
      expect(stage('read_requested', reloaded.operation_id).sanger_origin).toBe('local_reload');
      expect(reloaded.operation_id).toMatch(uuid);
      expect(reloaded.sanger_read_revision_id).toMatch(uuid);
      expect(
        new Set([
          first.operation_id,
          first.sanger_read_revision_id,
          reloaded.operation_id,
          reloaded.sanger_read_revision_id,
        ]).size
      ).toBe(4);
      expect(reloaded.sanger_view_id).toBeUndefined();
      expect(reloaded.viewport_operation_id).toBeUndefined();
    } finally {
      hook.unmount();
    }
  });
});
