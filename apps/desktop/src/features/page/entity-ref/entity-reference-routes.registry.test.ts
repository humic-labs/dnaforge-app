// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  lims: vi.fn(),
  panels: {} as Record<string, { id: string; tabs: Array<Record<string, unknown>> }>,
}));

vi.mock('../../lims/public/open-entity', () => ({
  openLimsEntity: state.lims,
  isLimsEntityOpened: (result: { status: string }) => result.status.startsWith('opened'),
}));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: { getState: () => ({ panels: state.panels }) },
}));

import { ENTITY_REFERENCE_ROUTES, type ReferenceRouteContext } from './entity-reference-routes';
import type { ReferenceIntent } from './reference-workflow';

function context() {
  return {
    folders: [],
    signal: new AbortController().signal,
    handleViewChange: vi.fn(),
    current: () => true,
    refuse: vi.fn(),
    documentResult: vi.fn(),
    registry: vi.fn(),
    openSelected: vi.fn(),
    openContained: vi.fn(),
    claimPrimerRequest: () => () => true,
  } satisfies ReferenceRouteContext;
}

const intent: ReferenceIntent = { finished: false, finish: vi.fn() };

function open(ctx: ReferenceRouteContext, entityId: string, label: string) {
  return ENTITY_REFERENCE_ROUTES.registry.beforeLocation!(
    {
      detail: { entityType: 'registry', entityId, label },
      intent,
      entityId,
      owningRoot: '/ws/beta',
      action: 'open',
    },
    ctx
  );
}

describe('a notebook link to a Registry record', () => {
  beforeEach(() => {
    state.lims.mockReset();
    state.panels = {};
  });

  it('opens the record document when it has one', async () => {
    state.panels = {
      main: { id: 'main', tabs: [{ id: 'tab-1', type: 'sequence', loadStatus: 'loaded' }] },
    };
    state.lims.mockResolvedValue({
      status: 'opened_sequence',
      tabId: 'tab-1',
      target: { entityId: 'ent-plasmid' },
    });
    const ctx = context();

    await open(ctx, 'ent-plasmid', 'pET-28a');

    expect(state.lims).toHaveBeenCalledWith({
      entityId: 'ent-plasmid',
      strategy: { kind: 'focused' },
    });
    expect(ctx.documentResult).toHaveBeenCalledWith(
      intent,
      expect.objectContaining({ status: 'presented', tabId: 'tab-1', panelId: 'main' }),
      undefined
    );
    expect(ctx.registry).not.toHaveBeenCalled();
  });

  it('shows the record in the Registry when it has no document', async () => {
    state.lims.mockResolvedValue({ status: 'unsupported', message: 'no document' });
    const ctx = context();

    await open(ctx, 'ent-strain', 'BL21(DE3)');

    expect(ctx.registry).toHaveBeenCalledWith(intent, 'ent-strain', 'BL21(DE3)');
    expect(ctx.refuse).not.toHaveBeenCalled();
  });

  it('says so when the record no longer exists', async () => {
    state.lims.mockResolvedValue({ status: 'not_found', message: 'Record not found.' });
    const ctx = context();

    await open(ctx, 'ent-gone', 'Old strain');

    expect(ctx.refuse).toHaveBeenCalledWith(intent, 'target_missing', 'Record not found.');
  });
});
