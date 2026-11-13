import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { Toolbox } from './Toolbox';
import { _resetToolboxState } from '../hooks/useToolboxStatus';
import { serviceManager } from '../services/service-manager';

const TEST_SIDECAR_BASE_URL = 'http://toolbox-sidecar.test.invalid';

function stubReadyElectronRenderer(): void {
  vi.stubGlobal('electronAPI', {
    config: { getSidecarStatus: vi.fn().mockResolvedValue('ready') },
  });
}

function mockToolboxResponse(capabilities: Record<string, unknown>[] = []) {
  return {
    ok: true,
    json: async () => ({ capabilities }),
  };
}

describe('Toolbox', () => {
  beforeEach(() => {
    _resetToolboxState();
    stubReadyElectronRenderer();
    serviceManager.setBaseUrl(TEST_SIDECAR_BASE_URL);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    _resetToolboxState();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<Toolbox />);
    expect(screen.getByTestId('toolbox-panel')).toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders capability list when loaded', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: 'ready',
          tier: 'base',
          components: [
            {
              id: 'blastn',
              label: 'BLAST+',
              status: 'ready',
              version: '2.16.0',
              source: 'downloaded',
            },
          ],
        },
        {
          id: 'alignment',
          label: 'Sequence Alignment',
          status: 'ready',
          tier: 'base',
          components: [],
        },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('Annotation Engine')).toBeInTheDocument();
      expect(screen.getByText('Sequence Alignment')).toBeInTheDocument();
    });
  });

  it('renders capability rows as passive status readouts with a small details control', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'blastn',
              label: 'BLAST+',
              status: 'ready',
              version: '2.16.0',
              source: 'downloaded',
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    await waitFor(() => {
      expect(screen.getByTestId('toolbox-summary')).toHaveTextContent('1/1');
    });

    expect(screen.getByTestId('capability-row-annotation').tagName).toBe('DIV');
    expect(screen.queryByRole('button', { name: 'Annotation Engine' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /show annotation engine details/i })
    ).toBeInTheDocument();
  });

  it('shows green dot for ready capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        { id: 'x', label: 'Test', status: 'ready', tier: 'base', components: [] },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByTestId('status-dot-x')).toHaveClass('bg-success');
    });
  });

  it('shows spinner for downloading capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'x',
          label: 'Test',
          status: 'downloading',
          tier: 'base',
          components: [
            {
              id: 'a',
              label: 'A',
              status: 'downloading',
              source: 'downloaded',
              progress: { phase: 'downloading', percent: 42, detail: 'Downloading...' },
            },
          ],
        },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      const matches = screen.getAllByText(/downloading/i);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows red dot for error capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        { id: 'x', label: 'Test', status: 'error', tier: 'base', components: [] },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByTestId('status-dot-x')).toHaveClass('bg-error');
    });
  });

  it('separates base and optional capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        { id: 'a', label: 'Base Tool', status: 'ready', tier: 'base', components: [] },
        {
          id: 'b',
          label: 'Optional Plugin',
          status: 'unavailable',
          tier: 'optional',
          components: [],
        },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('Base Tool')).toBeInTheDocument();
      expect(screen.getByText('Optional Plugin')).toBeInTheDocument();
    });
  });

  it('polls every 5s while downloading', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(
        mockToolboxResponse([
          { id: 'x', label: 'Test', status: 'downloading', tier: 'base', components: [] },
        ])
      );
      render(<Toolbox />);
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows initializing state when sidecar is starting and fetch fails', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText(/starting analysis engine/i)).toBeInTheDocument();
    });
  });

  it('recovers from a transient startup fetch failure without requiring manual retry', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('sidecar not listening yet')).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
      ])
    );

    render(<Toolbox />);

    await waitFor(() => {
      expect(screen.getByText(/starting analysis engine/i)).toBeInTheDocument();
    });

    await waitFor(
      () => {
        expect(screen.getByText('Annotation Engine')).toBeInTheDocument();
      },
      { timeout: 2_500 }
    );
    expect(screen.queryByText(/cannot connect to sidecar/i)).not.toBeInTheDocument();
  });

  it('shows retry button for error capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: 'error',
          tier: 'base',
          auto_install: true,
          source: 'builtin',
          components: [
            { id: 'databases', label: 'Databases', status: 'error', source: 'downloaded' },
          ],
        },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });

  it('shows test connection button for plugin capabilities', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockToolboxResponse([
        {
          id: 'alphafold',
          label: 'AlphaFold',
          status: 'unavailable',
          tier: 'optional',
          auto_install: false,
          source: 'plugin',
          components: [
            {
              id: 'alphafold_service',
              label: 'AlphaFold',
              status: 'unavailable',
              source: 'plugin',
              path: 'http://localhost:9001',
            },
          ],
        },
      ])
    );
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
    });
  });
});
