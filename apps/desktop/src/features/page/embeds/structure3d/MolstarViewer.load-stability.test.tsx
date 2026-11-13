/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadMocks = vi.hoisted(() => ({
  createViewerContainer: vi.fn(),
  applyBeforeReveal: vi.fn(
    async (
      _plugin: unknown,
      _plan: unknown,
      _options: { isCurrent: () => boolean; forceRepresentationApply?: boolean }
    ) => [] as string[]
  ),
  onBeforeReveal: undefined as
    | ((
        plugin: unknown
      ) => void | { status: 'cancelled' } | Promise<void | { status: 'cancelled' }>)
    | undefined,
}));

vi.mock('./molstar/createViewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./molstar/createViewer')>();
  return {
    ...actual,
    createViewerContainer: loadMocks.createViewerContainer.mockImplementation(
      (options: Parameters<typeof actual.createViewerContainer>[0]) => {
        loadMocks.onBeforeReveal = options.onBeforeReveal as typeof loadMocks.onBeforeReveal;
        return new Promise<Awaited<ReturnType<typeof actual.createViewerContainer>>>(() => {});
      }
    ),
  };
});

vi.mock('./molstar/applyMolstarRenderPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./molstar/applyMolstarRenderPlan')>();
  return {
    ...actual,
    applyMolstarRenderPlanBeforeReveal: loadMocks.applyBeforeReveal,
  };
});

vi.mock('./molstar/renderPlanInvariant', () => ({
  assertStructureRenderPlanSatisfiedForViewer: vi.fn(),
}));

import { MolstarViewer } from './MolstarViewer';
import { clearViewerCache } from './viewerCache';
import {
  createStructureViewStateFromRecipe,
  createQueryInComplexSurfaceRecipe,
  createIllustrativeRecipe,
  createCartoonRecipe,
} from './utils/viewRecipe';

describe('MolstarViewer in-flight load stability', () => {
  beforeEach(() => {
    clearViewerCache();
    loadMocks.createViewerContainer.mockClear();
    loadMocks.applyBeforeReveal.mockClear();
    loadMocks.onBeforeReveal = undefined;
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  });

  afterEach(() => {
    cleanup();
    clearViewerCache();
  });

  it('does not invalidate an in-flight structure construction when only the host height changes', async () => {
    const view = render(
      <MolstarViewer
        structureData="data_6WOO"
        structureDataFormat="mmcif"
        structureKeyOverride="structure:file:6woo"
        viewerInstanceId="tab:fun12"
        height={400}
      />
    );

    await waitFor(() => expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1));
    expect(loadMocks.onBeforeReveal).toBeTypeOf('function');

    view.rerender(
      <MolstarViewer
        structureData="data_6WOO"
        structureDataFormat="mmcif"
        structureKeyOverride="structure:file:6woo"
        viewerInstanceId="tab:fun12"
        height={920}
      />
    );

    const result = await loadMocks.onBeforeReveal?.({});

    expect(result).toBeUndefined();
    expect(loadMocks.applyBeforeReveal).toHaveBeenCalledTimes(1);
    expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight cache-owned construction valid across a same-view host remount', async () => {
    const firstHost = render(
      <MolstarViewer
        structureData="data_6WOO"
        structureDataFormat="mmcif"
        structureKeyOverride="structure:file:6woo"
        viewerInstanceId="tab:fun12"
        height={400}
      />
    );

    await waitFor(() => expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1));
    expect(loadMocks.onBeforeReveal).toBeTypeOf('function');

    firstHost.unmount();
    render(
      <MolstarViewer
        structureData="data_6WOO"
        structureDataFormat="mmcif"
        structureKeyOverride="structure:file:6woo"
        viewerInstanceId="tab:fun12"
        height={920}
      />
    );

    const result = await loadMocks.onBeforeReveal?.({});

    expect(result).toBeUndefined();
    expect(loadMocks.applyBeforeReveal).toHaveBeenCalledTimes(1);
    expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Illustrative', createIllustrativeRecipe],
    ['Cartoon', createCartoonRecipe],
  ] as const)(
    'supersedes a recipe changed to %s during native construction before revealing the canvas',
    async (_name, createLatestRecipe) => {
      const props = {
        structureData: 'data_6WOO',
        structureDataFormat: 'mmcif' as const,
        structureKeyOverride: 'structure:file:6woo-recipe-handoff',
        viewerInstanceId: 'tab:recipe-handoff',
        height: 400,
      };
      const view = render(
        <MolstarViewer
          {...props}
          view={createStructureViewStateFromRecipe(createQueryInComplexSurfaceRecipe())}
        />
      );
      await waitFor(() => expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1));
      let finishFirstApply!: () => void;
      loadMocks.applyBeforeReveal.mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            finishFirstApply = () => resolve([]);
          })
      );
      const construction = loadMocks.onBeforeReveal?.({});
      await waitFor(() => expect(loadMocks.applyBeforeReveal).toHaveBeenCalledTimes(1));
      const firstOptions = loadMocks.applyBeforeReveal.mock.calls[0][2];

      view.rerender(
        <MolstarViewer {...props} view={createStructureViewStateFromRecipe(createLatestRecipe())} />
      );
      expect(firstOptions.isCurrent()).toBe(false);
      await act(async () => {
        finishFirstApply();
        await construction;
      });

      expect(loadMocks.applyBeforeReveal).toHaveBeenCalledTimes(2);
      const latestOptions = loadMocks.applyBeforeReveal.mock.calls[1][2];
      expect(latestOptions.isCurrent()).toBe(true);
      expect(latestOptions.forceRepresentationApply).toBe(true);
      expect(loadMocks.createViewerContainer).toHaveBeenCalledTimes(1);
    }
  );
});
