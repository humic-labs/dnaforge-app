import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AddTrackDialog } from './AddTrackDialog';

vi.mock('../../../platform', () => ({ platform: () => ({ remoteGenomics: undefined }) }));

function renderDialog(
  onAddRemoteBam = vi.fn(async () => undefined),
  remoteNotice: { kind: 'success' | 'warn' | 'error'; text: string } | null = null
) {
  return render(
    <AddTrackDialog
      open
      assemblyDisplayName="GRCh38"
      ucscTarget={null}
      busy={null}
      progress={null}
      notice={remoteNotice}
      dataFileNotice={null}
      indexedBusy={null}
      indexedNotice={null}
      recentRemoteEndpoints={[
        {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1_700_000_000_000,
          observedPlatform: 'linux',
          lastFailure: null,
        },
      ]}
      onChooseDataFiles={vi.fn()}
      onAddBigWigUrl={vi.fn(async () => 'added' as const)}
      onAddUcscTrack={vi.fn(async () => 'added' as const)}
      onAddRemoteBam={onAddRemoteBam}
      onRefreshRemoteEndpoints={vi.fn(async () => undefined)}
      onClose={vi.fn()}
    />
  );
}

describe('AddTrackDialog remote cluster workflow', () => {
  it('submits a saved SSH alias and absolute remote BAM/index paths', async () => {
    const onAddRemoteBam = vi.fn(async () => undefined);
    renderDialog(onAddRemoteBam);

    fireEvent.click(screen.getByRole('tab', { name: 'Remote cluster' }));
    expect(screen.getByText('Recent endpoints')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Lab HPC lab-hpc', exact: true }));
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/project/run 42/tumor.bam' },
    });
    fireEvent.change(screen.getByLabelText('Remote index path'), {
      target: { value: '/project/run 42/tumor.bam.bai' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));

    await waitFor(() =>
      expect(onAddRemoteBam).toHaveBeenCalledWith({
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
      })
    );
  });

  it('keeps a connection failure visible in the remote panel', () => {
    renderDialog(
      vi.fn(async () => undefined),
      {
        kind: 'error',
        text: 'OpenSSH needs authentication. Retry to answer its prompt in DNAForge, or check your SSH agent.',
      }
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Remote cluster' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Retry to answer its prompt in DNAForge');
  });
});
