// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDebugSnapshot, type DebugSnapshotConfig } from './debug-snapshot';

describe('DebugSnapshot', () => {
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let mockGetRecentCalls: ReturnType<typeof vi.fn>;
  let config: DebugSnapshotConfig;

  beforeEach(() => {
    mockWriteFile = vi.fn().mockResolvedValue(undefined);
    mockGetRecentCalls = vi.fn().mockResolvedValue([]);
    config = {
      snapshotDir: '/test/snapshots',
      fileOps: {
        writeFile: mockWriteFile,
        ensureDir: vi.fn().mockResolvedValue(undefined),
      },
      getRecentServiceCalls: mockGetRecentCalls,
      getAppState: vi.fn().mockReturnValue({}),
    };
  });

  describe('capture', () => {
    it('creates snapshot file with timestamp in filename', async () => {
      const snapshot = createDebugSnapshot(config);

      const mockDate = new Date('2024-01-15T10:30:45.123Z');
      vi.setSystemTime(mockDate);

      await snapshot.capture();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path] = mockWriteFile.mock.calls[0];
      expect(path).toMatch(/\/test\/snapshots\/debug-2024-01-15T.*\.json$/);

      vi.useRealTimers();
    });

    it('includes recent service calls in snapshot', async () => {
      const recentCalls = [
        {
          timestamp: '2024-01-15T10:30:00.000Z',
          service: 'plannotate_service',
          request: { sequence: 'ATCG' },
          response: { features: [{ name: 'AmpR', confidence: 0.95 }] },
          durationMs: 500,
        },
      ];
      mockGetRecentCalls.mockResolvedValue(recentCalls);

      const snapshot = createDebugSnapshot(config);
      await snapshot.capture();

      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.serviceCalls).toEqual(recentCalls);
    });

    it('includes app state in snapshot', async () => {
      const appState = {
        sequence: { id: '123', name: 'Test Plasmid' },
        annotations: { selectedId: 'ann-1' },
      };
      config.getAppState = vi.fn().mockReturnValue(appState);

      const snapshot = createDebugSnapshot(config);
      await snapshot.capture();

      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.appState).toEqual(appState);
    });

    it('includes metadata in snapshot', async () => {
      const snapshot = createDebugSnapshot(config);

      vi.setSystemTime(new Date('2024-01-15T10:30:45.123Z'));
      await snapshot.capture();

      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.metadata).toEqual({
        capturedAt: '2024-01-15T10:30:45.123Z',
        version: '1.0',
      });

      vi.useRealTimers();
    });

    it('returns the snapshot file path', async () => {
      const snapshot = createDebugSnapshot(config);

      vi.setSystemTime(new Date('2024-01-15T10:30:45.123Z'));
      const result = await snapshot.capture();

      expect(result.filePath).toMatch(/\/test\/snapshots\/debug-2024-01-15T.*\.json$/);
      vi.useRealTimers();
    });

    it('includes optional user note if provided', async () => {
      const snapshot = createDebugSnapshot(config);
      await snapshot.capture({ note: 'Low confidence on protein annotations' });

      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.metadata.note).toBe('Low confidence on protein annotations');
    });

    it('ensures snapshot directory exists before writing', async () => {
      const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
      config.fileOps.ensureDir = mockEnsureDir;

      const snapshot = createDebugSnapshot(config);
      await snapshot.capture();

      expect(mockEnsureDir).toHaveBeenCalledWith('/test/snapshots');
      expect(mockEnsureDir).toHaveBeenCalledBefore(mockWriteFile);
    });
  });

  describe('getLatestSnapshotPath', () => {
    it('returns path to most recent snapshot', async () => {
      const mockListFiles = vi
        .fn()
        .mockResolvedValue([
          'debug-2024-01-15T10:30:45.json',
          'debug-2024-01-15T11:00:00.json',
          'debug-2024-01-14T09:00:00.json',
        ]);
      config.fileOps.listFiles = mockListFiles;

      const snapshot = createDebugSnapshot(config);
      const latest = await snapshot.getLatestSnapshotPath();

      expect(latest).toBe('/test/snapshots/debug-2024-01-15T11:00:00.json');
    });

    it('returns null if no snapshots exist', async () => {
      const mockListFiles = vi.fn().mockResolvedValue([]);
      config.fileOps.listFiles = mockListFiles;

      const snapshot = createDebugSnapshot(config);
      const latest = await snapshot.getLatestSnapshotPath();

      expect(latest).toBeNull();
    });
  });
});
