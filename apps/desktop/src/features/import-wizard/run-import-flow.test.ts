import { describe, it, expect, vi } from 'vitest';
import { runImportFlow, type ImportFlowDeps } from './run-import-flow';
import type { ImportWizardState } from '../workspace-loader/import-wizard-state';

const state: ImportWizardState = {
  items: [{ path: '/d/a.gb', name: 'a.gb', kind: 'file' }],
  destination: { kind: 'existing-root', rootPath: '/ws' },
  requiresExplicitChoice: false,
  destinationChosen: true,
  agentRequested: false,
};

function deps(over: Partial<ImportFlowDeps> = {}): ImportFlowDeps {
  return {
    buildState: vi.fn(async () => state),
    openWizard: vi.fn(async () => ({
      items: state.items,
      destination: state.destination,
      agentRequested: false,
    })),
    execDeps: {
      importFile: vi.fn(async () => ({ destPath: '/ws/a.gb', relPath: 'a.gb', committed: true })),
      importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
      importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
    },
    ...over,
  };
}

describe('runImportFlow ', () => {
  it('executes the writes when the user confirms', async () => {
    const d = deps();
    const res = await runImportFlow(['/d/a.gb'], d);
    expect(d.openWizard).toHaveBeenCalledWith(state);
    expect(d.execDeps.importFile).toHaveBeenCalled();
    expect(res).toMatchObject({ imported: 1 });
  });

  it('writes NOTHING when the user cancels (null outcome)', async () => {
    const d = deps({ openWizard: vi.fn(async () => null) });
    const res = await runImportFlow(['/d/a.gb'], d);
    expect(d.execDeps.importFile).not.toHaveBeenCalled();
    expect(d.execDeps.importFolder).not.toHaveBeenCalled();
    expect(d.execDeps.importManaged).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('returns null for an empty path list without opening the modal', async () => {
    const d = deps();
    const res = await runImportFlow([], d);
    expect(d.buildState).not.toHaveBeenCalled();
    expect(d.openWizard).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('does not open the modal when nothing resolved to import', async () => {
    const d = deps({ buildState: vi.fn(async () => ({ ...state, items: [] })) });
    const res = await runImportFlow(['/d/a.gb'], d);
    expect(d.openWizard).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('reports the result to onComplete', async () => {
    const onComplete = vi.fn();
    await runImportFlow(['/d/a.gb'], deps({ onComplete }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ imported: 1 }));
  });

  it('hands the imported managed-copy paths to the agent when the toggle is on (D2)', async () => {
    const onAgentFile = vi.fn();
    await runImportFlow(
      ['/d/a.gb'],
      deps({
        openWizard: vi.fn(async () => ({
          items: state.items,
          destination: state.destination,
          agentRequested: true,
        })),
        execDeps: {
          importFile: vi.fn(async () => ({
            destPath: '/ws/a.gb',
            relPath: 'a.gb',
            committed: true,
          })),
          importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
          importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
          importFileAsNewWorkspace: vi.fn(async () => ({ repoPath: '/managed/file-ws/repo' })),
        },
        onAgentFile,
      })
    );
    expect(onAgentFile).toHaveBeenCalledWith(['/ws/a.gb']);
  });

  it('does NOT call the agent when the toggle is off', async () => {
    const onAgentFile = vi.fn();
    await runImportFlow(['/d/a.gb'], deps({ onAgentFile }));
    expect(onAgentFile).not.toHaveBeenCalled();
  });

  it('does NOT call the agent when the toggle is on but nothing was written', async () => {
    const onAgentFile = vi.fn();
    await runImportFlow(
      ['/d/a.gb'],
      deps({
        openWizard: vi.fn(async () => ({
          items: state.items,
          destination: state.destination,
          agentRequested: true,
        })),
        execDeps: {
          importFile: vi.fn(async () => ({
            destPath: 'x',
            relPath: 'x',
            committed: false,
            skipped: true,
          })),
          importFolder: vi.fn(async () => ({ destPath: 'x', relPath: 'x', committed: true })),
          importManaged: vi.fn(async () => ({ repoPath: '/m' })),
          importFileAsNewWorkspace: vi.fn(async () => ({ repoPath: '/m' })),
        },
        onAgentFile,
      })
    );
    expect(onAgentFile).not.toHaveBeenCalled();
  });
});
