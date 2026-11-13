// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { realAssemblyPipelineAppScenario } from '../../../test/scenarios/assembly-real-pipeline';
import { ExportSection } from './ExportSection';
import { useDesignStore } from '../../design/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { readDir: async () => [] },
    workspace: { listChildren: async () => ({ entries: [], partialError: null }) },
  }),
}));

vi.mock('../../../lib/analytics-operation', () => ({
  beginToolOperation: () => ({ operationId: 'export-operation', fail: vi.fn(), complete: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../assembly/public/issues/assembly-issues', () => ({
  deriveAssemblyIssues: () => [],
  issueBlocksGate: () => false,
}));
vi.mock('../../assembly/public/accepted-finalization-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../assembly/public/accepted-finalization-preview')>()),
  resolveBoundAcceptedPackageForDesign: async () => null,
}));

describe(' export recovery action', () => {
  it('provides an actionable message and invokes the authoritative draft command with one click', async () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-pcr');
    const design = { ...Object.values(scenario.designs!.designs!)[0], version: 10, assemblyState: 'ready' as const };
    const draftAssembly = vi.fn();
    useDesignStore.setState({ designs: { [design.id]: { ...design, version: 11 } }, draftAssembly });
    useWorkspaceStore.setState({ folders: [{ name: 'workspace', path: '/workspace', addedAt: 1 }] });
    render(<ExportSection design={design} primers={[]} />);
    await waitFor(() => expect(screen.getByTestId('finalize-accepted-assembly')).toBeEnabled());
    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));
    await waitFor(() => expect(screen.getByTestId('accepted-assembly-error')).toHaveTextContent('The assembly changed since its last draft. Click Update draft, review the result, then Finalize again.'));
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(draftAssembly).toHaveBeenCalledExactlyOnceWith(design.id);
  });
});
