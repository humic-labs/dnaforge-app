import { describe, expect, it, vi } from 'vitest';
import { canReactivateToolResult } from './can-reactivate-tool-result';
import { createToolResultReactivator } from './reactivate-tool-result';

describe('tool result history reactivation', () => {
  const documentId = 'catalog-puc19';

  it('only advertises receipts that can pass the saved tool schema', () => {
    expect(
      canReactivateToolResult('open_tab', {
        input: { type: 'sequence', entityId: '/workspace/pUC19.gb', label: 'pUC19.gb' },
        output: { tabId: 'tab-1' },
      })
    ).toBe(true);
    expect(
      canReactivateToolResult('open_tab', {
        input: {},
        output: { tabId: 'tab-1' },
      })
    ).toBe(false);
    expect(
      canReactivateToolResult('highlight_range', {
        input: { documentId, start: 683, end: 688 },
        output: { ok: false, error: 'invalid range' },
      })
    ).toBe(false);
    expect(
      canReactivateToolResult('highlight_range', {
        input: { documentId },
        output: { ok: true },
      })
    ).toBe(false);
    expect(
      canReactivateToolResult('highlight_range', {
        input: { documentId, regions: [] },
        output: { ok: true },
      })
    ).toBe(false);
  });

  it('restores open_tab through the local presentation handler', async () => {
    const openTab = vi.fn().mockResolvedValue({ tabId: 'tab-1' });
    const reactivate = createToolResultReactivator({
      openTab,
      highlightRange: vi.fn(),
    });

    await expect(
      reactivate('open_tab', {
        input: { type: 'sequence', entityId: '/workspace/pUC19.gb', label: 'pUC19.gb' },
      })
    ).resolves.toEqual({ ok: true });
    expect(openTab).toHaveBeenCalledWith({
      type: 'sequence',
      entityId: '/workspace/pUC19.gb',
      label: 'pUC19.gb',
    });
  });

  it('restores highlight_range through the local presentation handler', async () => {
    const highlightRange = vi.fn().mockResolvedValue({ ok: true });
    const reactivate = createToolResultReactivator({
      openTab: vi.fn(),
      highlightRange,
    });

    await expect(
      reactivate('highlight_range', {
        input: { documentId, start: 683, end: 688 },
      })
    ).resolves.toEqual({ ok: true });
    expect(highlightRange).toHaveBeenCalledWith({
      documentId,
      start: 683,
      end: 688,
    });
  });

  it('does not replay mutations, failed calls, or malformed receipts', async () => {
    const handlers = { openTab: vi.fn(), highlightRange: vi.fn() };
    const reactivate = createToolResultReactivator(handlers);

    await expect(reactivate('finalize_design_assembly', { input: {} })).resolves.toEqual({
      ok: false,
      error: 'This tool result is inspect-only.',
    });
    await expect(reactivate('open_tab', { input: {}, isError: true })).resolves.toEqual({
      ok: false,
      error: 'Failed tool calls cannot be shown again.',
    });
    await expect(
      reactivate('highlight_range', {
        input: { documentId, start: 683, end: 688 },
        output: { ok: false, error: 'range was not shown' },
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Failed tool calls cannot be shown again.',
    });
    await expect(
      reactivate('highlight_range', { input: { documentId, start: 'bad', end: 2 } })
    ).resolves.toEqual({
      ok: false,
      error: 'The saved sequence range is invalid.',
    });
    expect(handlers.openTab).not.toHaveBeenCalled();
    expect(handlers.highlightRange).not.toHaveBeenCalled();
  });
});
