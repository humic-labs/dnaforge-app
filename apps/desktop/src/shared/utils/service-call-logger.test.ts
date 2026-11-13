// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createServiceCallLogger,
  type ServiceCallEntry,
  type ServiceCallLogger,
} from './service-call-logger';

describe('ServiceCallLogger', () => {
  let mockWriteFile: (path: string, content: string) => Promise<void>;
  let mockReadFile: (path: string) => Promise<string>;
  let logger: ServiceCallLogger;

  beforeEach(() => {
    mockWriteFile = vi.fn().mockResolvedValue(undefined);
    mockReadFile = vi.fn().mockResolvedValue('');
    logger = createServiceCallLogger({
      logFilePath: '/test/logs/service-calls.jsonl',
      maxEntries: 50,
      fileOps: {
        writeFile: mockWriteFile,
        readFile: mockReadFile,
      },
    });
  });

  describe('log', () => {
    it('writes service call entry to file as JSONL', async () => {
      const entry: Omit<ServiceCallEntry, 'timestamp'> = {
        service: 'plannotate_service',
        request: { sequence: 'ATCG', linear: false },
        response: { features: [], sequence_length: 4 },
        durationMs: 150,
      };

      await logger.log(entry);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path, content] = mockWriteFile.mock.calls[0];
      expect(path).toBe('/test/logs/service-calls.jsonl');

      const logged = JSON.parse(content.trim());
      expect(logged.service).toBe('plannotate_service');
      expect(logged.request).toEqual({ sequence: 'ATCG', linear: false });
      expect(logged.response).toEqual({ features: [], sequence_length: 4 });
      expect(logged.durationMs).toBe(150);
      expect(logged.timestamp).toBeDefined();
    });

    it('appends to existing log file', async () => {
      const existingContent = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        service: 'old_service',
        request: {},
        response: {},
      });
      mockReadFile.mockResolvedValue(existingContent + '\n');

      await logger.log({
        service: 'new_service',
        request: { foo: 'bar' },
        response: { result: 'ok' },
        durationMs: 100,
      });

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [, content] = mockWriteFile.mock.calls[0];
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).service).toBe('old_service');
      expect(JSON.parse(lines[1]).service).toBe('new_service');
    });

    it('logs errors when service call fails', async () => {
      await logger.log({
        service: 'plannotate_service',
        request: { sequence: 'ATCG' },
        error: 'Connection refused',
        durationMs: 50,
      });

      const [, content] = mockWriteFile.mock.calls[0];
      const logged = JSON.parse(content.trim());
      expect(logged.error).toBe('Connection refused');
      expect(logged.response).toBeUndefined();
    });
  });

  describe('truncation', () => {
    it('truncates to maxEntries when log exceeds limit', async () => {
      const existingEntries = Array.from({ length: 50 }, (_, i) => ({
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        service: `service_${i}`,
        request: {},
        response: {},
        durationMs: 100,
      }));
      mockReadFile.mockResolvedValue(
        existingEntries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      );

      await logger.log({
        service: 'newest_service',
        request: {},
        response: {},
        durationMs: 100,
      });

      const [, content] = mockWriteFile.mock.calls[0];
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(50);
      expect(JSON.parse(lines[0]).service).toBe('service_1');
      expect(JSON.parse(lines[49]).service).toBe('newest_service');
    });
  });

  describe('getRecentCalls', () => {
    it('returns recent service calls', async () => {
      const entries = [
        {
          timestamp: '2024-01-01T00:00:00.000Z',
          service: 'a',
          request: {},
          response: {},
          durationMs: 10,
        },
        {
          timestamp: '2024-01-01T00:00:01.000Z',
          service: 'b',
          request: {},
          response: {},
          durationMs: 20,
        },
        {
          timestamp: '2024-01-01T00:00:02.000Z',
          service: 'c',
          request: {},
          response: {},
          durationMs: 30,
        },
      ];
      mockReadFile.mockResolvedValue(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const recent = await logger.getRecentCalls(2);

      expect(recent).toHaveLength(2);
      expect(recent[0].service).toBe('b');
      expect(recent[1].service).toBe('c');
    });

    it('returns all calls if count exceeds available', async () => {
      const entries = [
        {
          timestamp: '2024-01-01T00:00:00.000Z',
          service: 'a',
          request: {},
          response: {},
          durationMs: 10,
        },
      ];
      mockReadFile.mockResolvedValue(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const recent = await logger.getRecentCalls(10);

      expect(recent).toHaveLength(1);
    });

    it('returns empty array when log file is empty', async () => {
      mockReadFile.mockResolvedValue('');

      const recent = await logger.getRecentCalls(10);

      expect(recent).toEqual([]);
    });
  });
});
