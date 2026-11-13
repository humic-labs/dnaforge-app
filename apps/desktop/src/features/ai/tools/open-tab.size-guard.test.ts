import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetCanvasStore, mockUUID, execTool } from './test-helpers';

const { mockOpen, mockResolve } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockResolve: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { stat: async () => ({ isFile: true, isDirectory: false }) } }),
}));
vi.mock('../../document-opening/compat', () => ({
  openSequenceDocument: mockOpen,
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolve,
}));

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  mockOpen.mockReset();
  mockResolve.mockReset();
  mockResolve.mockResolvedValue({
    documentId: 'catalog-sample',
    sourcePath: '/abs/path/sample.gb',
    ref: { kind: 'catalog-sequence', entityId: 'catalog-sample' },
  });
});

import { openTabTool } from './open-tab';

describe('open_tab → openSequenceDocument ', () => {
  it("type='sequence' routes by stable document ID into the adjacent content panel", async () => {
    mockOpen.mockResolvedValue('tab-123');

    const result = await execTool<{ tabId: string; warning?: string; error?: string }>(
      openTabTool,
      { type: 'sequence', entityId: 'catalog-sample', label: 'sample' }
    );

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({
      kind: 'catalog-sequence',
      entityId: 'catalog-sample',
    });
    expect(mockOpen.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        label: 'sample',
        strategy: { kind: 'panel', panelId: expect.any(String) },
      })
    );
    expect(result.tabId).toBe('tab-123');
    expect(result.error).toBeUndefined();
  });

  it("type='sequence' + split=true routes through openSequenceFile with panel strategy", async () => {
    mockOpen.mockResolvedValue('tab-split');

    const result = await execTool<{ tabId: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-big',
      label: 'big',
      split: true,
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        label: 'big',
        strategy: { kind: 'panel', panelId: expect.any(String) },
      })
    );
    expect(result.tabId).toBe('tab-split');
  });

  it("type='sequence' returns a tool-level error when guard rejects (null tabId)", async () => {
    mockOpen.mockResolvedValue(null);

    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-huge',
      label: 'huge',
    });

    expect(result.tabId).toBe('');
    expect(result.error).toMatch(/too large|unavailable/i);
  });

  it("type='sequence' + split=true also surfaces error when guard rejects", async () => {
    mockOpen.mockResolvedValue(null);

    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-huge',
      label: 'huge',
      split: true,
    });

    expect(result.tabId).toBe('');
    expect(result.error).toMatch(/too large|unavailable/i);
  });

  it("type='page' does NOT go through openSequenceDocument", async () => {
    const result = await execTool<{ tabId: string }>(openTabTool, {
      type: 'page',
      entityId: 'page-id-1',
      label: 'My Page',
    });

    expect(mockOpen).not.toHaveBeenCalled();
    expect(result.tabId).toBeTruthy();
  });

  it("type='file' does NOT go through openSequenceDocument", async () => {
    const result = await execTool<{ tabId: string }>(openTabTool, {
      type: 'file',
      entityId: '/abs/path/notes.txt',
      label: 'notes.txt',
    });

    expect(mockOpen).not.toHaveBeenCalled();
    expect(result.tabId).toBeTruthy();
  });
});
