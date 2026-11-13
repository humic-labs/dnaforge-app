import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RemoteClusterPanel } from './RemoteClusterPanel';

vi.mock('../../../platform', () => ({
  platform: () => ({ remoteGenomics: {}, clipboard: { writeText: vi.fn() } }),
}));

describe('remote connection submission errors', () => {
  it.each([
    ['cancellation', 'Remote aligned-read connection was cancelled.'],
    ['unreadable source', 'Remote aligned-read source was not found or is not readable.'],
  ])(
    'shows one authoritative %s alert after an edited connection fails',
    async (_kind, message) => {
      let rejectConnection: (error: Error) => void = () => undefined;
      function ConnectionEditor() {
        const [notice, setNotice] = useState<{ kind: 'error'; text: string } | null>(null);
        const [connecting, setConnecting] = useState(false);
        return (
          <RemoteClusterPanel
            assemblyDisplayName="pUC19"
            recentEndpoints={[]}
            initial={{ target: 'lab-hpc', alignmentPath: '/reads/tumor.bam' }}
            busy={false}
            connecting={connecting}
            notice={notice}
            submitLabel="Save and reconnect"
            onSubmit={() => {
              setNotice(null);
              setConnecting(true);
              return new Promise<void>((_resolve, reject) => {
                rejectConnection = reject;
              });
            }}
            onCancelConnection={() => {
              setNotice({ kind: 'error', text: message });
              setConnecting(false);
              rejectConnection(new Error(message));
            }}
          />
        );
      }
      render(<ConnectionEditor />);
      fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel connection' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeEnabled()
      );
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(screen.getByLabelText('SSH target')).toHaveValue('lab-hpc');
      expect(screen.getByLabelText('Remote alignment path')).toHaveValue('/reads/tumor.bam');
    }
  );

  it.each([null, 'success', 'warn'] as const)(
    'retains a safe submission failure when the parent notice is %s',
    async (kind) => {
      render(
        <RemoteClusterPanel
          assemblyDisplayName="pUC19"
          recentEndpoints={[]}
          initial={{ target: 'lab-hpc', alignmentPath: '/reads/tumor.bam' }}
          busy={false}
          notice={kind ? { kind, text: 'Previous connection notice' } : null}
          submitLabel="Save and reconnect"
          onSubmit={async () => {
            throw new Error('private transport diagnostic');
          }}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        userMessage('remote.connectionFailed')
      );
      expect(screen.queryByText('private transport diagnostic')).not.toBeInTheDocument();
      if (kind) expect(screen.getByRole('status')).toHaveTextContent('Previous connection notice');
    }
  );
});
