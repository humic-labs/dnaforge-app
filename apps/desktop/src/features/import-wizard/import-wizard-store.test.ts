import { describe, it, expect, beforeEach } from 'vitest';
import { useImportWizardStore, openImportWizard } from './import-wizard-store';
import type { ImportWizardState } from '../workspace-loader/import-wizard-state';

function initial(over: Partial<ImportWizardState> = {}): ImportWizardState {
  return {
    items: [{ path: '/d/a.gb', name: 'a.gb', kind: 'file' }],
    destination: { kind: 'existing-root', rootPath: '/ws' },
    requiresExplicitChoice: false,
    destinationChosen: true,
    agentRequested: false,
    ...over,
  };
}

describe('import-wizard-store ', () => {
  beforeEach(() => useImportWizardStore.setState({ request: null }));

  it('opens a request and resolves with the confirmed outcome', async () => {
    const p = openImportWizard(initial());
    expect(useImportWizardStore.getState().request).not.toBeNull();
    const outcome = {
      items: initial().items,
      destination: initial().destination,
      agentRequested: false,
    };
    useImportWizardStore.getState().resolveCurrent(outcome);
    await expect(p).resolves.toEqual(outcome);
    expect(useImportWizardStore.getState().request).toBeNull();
  });

  it('resolves null on cancel', async () => {
    const p = openImportWizard(initial());
    useImportWizardStore.getState().resolveCurrent(null);
    await expect(p).resolves.toBeNull();
  });

  it('superseding open cancels the previous request (resolves it null)', async () => {
    const p1 = openImportWizard(initial());
    openImportWizard(initial({ agentRequested: true }));
    await expect(p1).resolves.toBeNull();
    expect(useImportWizardStore.getState().request?.initial.agentRequested).toBe(true);
  });

  it('resolveCurrent with no open request is a no-op', () => {
    expect(() => useImportWizardStore.getState().resolveCurrent(null)).not.toThrow();
  });
});
