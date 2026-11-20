// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportWizardHost } from './ImportWizardHost';
import { useImportWizardStore } from './import-wizard-store';
import { useImportWizard } from './useImportWizard';
import type { ImportWizardState } from '../workspace-loader/public/import-wizard-state';
const ports = vi.hoisted(() => ({ build: vi.fn(), open: vi.fn() }));
vi.mock('./build-import-wizard-state', () => ({ buildImportWizardState: ports.build }));
vi.mock('./run-import-flow', () => ({ runImportFlow: vi.fn() }));
vi.mock('../../lib/open-external-preview', () => ({ openExternalFiles: vi.fn() }));
vi.mock('../../utils/environment', async (original) => ({
  ...(await original<typeof import('../../utils/environment')>()),
  isBrowserOnly: () => false,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    on: () => () => undefined,
    fs: { readDir: async () => [], exists: async () => false },
    dialog: { open: ports.open },
    workspace: {},
    lims: { countEntitiesByKind: async () => ({}) },
  }),
}));
function initial(name: string, root = '/project/a'): ImportWizardState {
  return {
    items: [
      {
        path: `/imports/${name}`,
        name,
        kind: 'file',
        format: 'genbank',
        target: { kind: 'existing-root', rootPath: root },
      },
    ],
    destination: { kind: 'existing-root', rootPath: root },
    availableRoots: [{ path: root, name: root }],
    requiresExplicitChoice: false,
    destinationChosen: true,
    agentRequested: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('import wizard request ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useImportWizardStore.setState({ request: null });
    ports.open.mockResolvedValue(['/imports/extra.gb']);
  });
  it.each(['different source', 'different destination'] as const)(
    'confirms the replacement request after %s',
    async (change) => {
      const first = useImportWizardStore.getState().openImportWizard(initial('a.gb'));
      render(<ImportWizardHost />);
      const next = initial(change === 'different source' ? 'b.gb' : 'a.gb', '/project/b');
      let second!: ReturnType<ReturnType<typeof useImportWizardStore.getState>['openImportWizard']>;
      act(() => {
        second = useImportWizardStore.getState().openImportWizard(next);
      });
      await expect(first).resolves.toBeNull();
      fireEvent.click(screen.getByTestId('import-confirm'));
      const outcome = await second;
      expect(outcome?.items.map((item) => item.path)).toEqual(next.items.map((item) => item.path));
      expect(outcome?.destination).toEqual(next.destination);
      expect(outcome?.items[0].target).toEqual(next.items[0].target);
    }
  );
  it('does not append an old asynchronous source preview to a replacement wizard', async () => {
    const preview = deferred<ImportWizardState>();
    ports.build.mockReturnValue(preview.promise);
    const events: Event[] = [];
    const listener = (event: Event) => {
      events.push(event);
    };
    window.addEventListener('waypoint:import-wizard-add-items', listener);
    try {
      void useImportWizardStore.getState().openImportWizard(initial('a.gb'));
      const { result } = renderHook(() => useImportWizard());
      let add!: Promise<void>;
      act(() => {
        add = result.current.openEntityImport({
          entityType: 'dna-sequences',
          destination: { kind: 'choose' },
        });
      });
      await waitFor(() => expect(ports.build).toHaveBeenCalledOnce());
      act(() => {
        useImportWizardStore.getState().resolveCurrent(null);
        void useImportWizardStore.getState().openImportWizard(initial('b.gb'));
      });
      await act(async () => {
        preview.resolve(initial('extra.gb'));
        await add;
      });
      expect(events).toHaveLength(0);
      expect(useImportWizardStore.getState().request?.initial.items[0].name).toBe('b.gb');
    } finally {
      window.removeEventListener('waypoint:import-wizard-add-items', listener);
    }
  });
});
