import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  ready: true,
  visible: true,
  captures: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
  changed: [] as Array<() => void>,
}));
vi.mock('../../lib/analytics', () => ({
  isAnalyticsCaptureReady: () => state.ready,
  subscribeAnalyticsCaptureReady: (callback: () => void) => {
    state.changed.push(callback);
    return () => {};
  },
  trackRendererEvent: (event: string, properties: Record<string, unknown>) =>
    state.captures(event, properties),
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: { a: { activeTabId: state.visible ? 'controlled-tab' : 'other' } },
    }),
  },
}));
import { beginPdfRead, claimPdfRead } from './telemetry';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';

describe('PDF operation scope', () => {
  beforeEach(() => {
    state.ready = true;
    state.visible = true;
    state.captures.mockClear();
  });
  it('correlates an explicit accepted read with distinct parse and current presentation milestones', () => {
    beginPdfRead('controlled-tab');
    const op = claimPdfRead('controlled-tab', false);
    const generation = crypto.randomUUID();
    op.emit('parsed', generation);
    op.emit('canvas_complete', generation);
    op.emit('text_ready', generation);
    op.emit('page_presented', generation);
    op.emit('page_presented', generation);
    op.cancel(generation, 'closed');
    expect(state.captures.mock.calls.map((call) => call[1].pdf_stage)).toEqual([
      'accepted',
      'parsed',
      'canvas_complete',
      'text_ready',
      'page_presented',
    ]);
    for (const call of state.captures.mock.calls)
      expect(call[1]).toMatchObject({
        operation_id: op.id,
        pdf_origin: 'explicit',
        pdf_visibility: 'foreground',
      });
  });
  it('does not manufacture accepted opens from restores, reloads or background mounts', () => {
    state.visible = false;
    const restored = claimPdfRead('controlled-tab', false);
    restored.emit('parsed', crypto.randomUUID());
    const reload = claimPdfRead('controlled-tab', true);
    reload.emit('page_presented', crypto.randomUUID());
    expect(
      state.captures.mock.calls.map((call) => [
        call[1].pdf_stage,
        call[1].pdf_origin,
        call[1].pdf_visibility,
      ])
    ).toEqual([
      ['parsed', 'restored', 'background'],
      ['page_presented', 'reload', 'background'],
    ]);
  });
  it('invalidates an existing origin through account or consent transitions and never revives an opted-out origin', () => {
    const old = claimPdfRead('controlled-tab', false);
    state.ready = false;
    state.changed.forEach((callback) => callback());
    const denied = claimPdfRead('controlled-tab', false);
    state.ready = true;
    state.changed.forEach((callback) => callback());
    old.emit('page_presented', crypto.randomUUID());
    denied.emit('page_presented', crypto.randomUUID());
    expect(state.captures).not.toHaveBeenCalled();
  });
  it('keeps close/supersession and bounded failure distinct from successful presentation', () => {
    const old = claimPdfRead('controlled-tab', false);
    old.emit('parsed', crypto.randomUUID());
    old.cancel(crypto.randomUUID(), 'superseded');
    const failed = claimPdfRead('controlled-tab', false);
    failed.emit('failed', crypto.randomUUID(), 'text');
    expect(
      state.captures.mock.calls.map((call) => [call[1].pdf_stage, call[1].pdf_reason])
    ).toEqual([
      ['parsed', 'none'],
      ['cancelled', 'superseded'],
      ['failed', 'text'],
    ]);
  });
  it('strips scientific content, identities, digests, source locations and geometry at the real sanitizer', () => {
    const result = sanitizeClosedBetaProperties({
      pdf_stage: 'citation_arrived',
      pdf_origin: 'explicit',
      pdf_visibility: 'foreground',
      pdf_reason: 'none',
      pdf_generation_id: crypto.randomUUID(),
      pdf_citation_id: crypto.randomUUID(),
      source_path: '/private/decoy.pdf',
      quote: 'harmless controlled text',
      sha256: 'a'.repeat(64),
      page: 2,
      rect: { x: 0.5 },
    });
    expect(result).toMatchObject({ pdf_stage: 'citation_arrived' });
    for (const key of ['source_path', 'quote', 'sha256', 'page', 'rect'])
      expect(result).not.toHaveProperty(key);
  });
});
