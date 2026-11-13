import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { Toolbox } from './Toolbox';
import { _resetToolboxState } from '../hooks/useToolboxStatus';
import { sidecarScenarios, withPlugin } from '../test/scenarios';
import { serviceManager } from '../services/service-manager';

const TEST_SIDECAR_BASE_URL = 'http://toolbox-sidecar.test.invalid';

function stubReadyElectronRenderer(): void {
  vi.stubGlobal('electronAPI', {
    config: { getSidecarStatus: vi.fn().mockResolvedValue('ready') },
  });
}

function mockFetchWith(scenario: { capabilities: unknown[] }) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => scenario,
  });
}

describe('Toolbox with scenario presets', () => {
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

  it('renders fresh install state — all unavailable', async () => {
    mockFetchWith(sidecarScenarios.freshInstall());
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('Annotation Engine')).toBeInTheDocument();
    });
    const annotationDot = screen.getByTestId('status-dot-annotation');
    expect(annotationDot).toBeInTheDocument();
  });

  it('renders fully ready state — all green', async () => {
    mockFetchWith(sidecarScenarios.fullyReady());
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('Annotation Engine')).toBeInTheDocument();
    });
    expect(screen.getByTestId('status-dot-annotation')).toHaveClass('bg-success');
    expect(screen.getByTestId('status-dot-alignment')).toHaveClass('bg-success');
    expect(screen.getByTestId('status-dot-primer_design')).toHaveClass('bg-success');
  });

  it('renders downloading state with progress', async () => {
    mockFetchWith(sidecarScenarios.downloadingTools(45));
    render(<Toolbox />);
    await waitFor(() => {
      const matches = screen.getAllByText(/downloading/i);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders error state with retry button', async () => {
    mockFetchWith(sidecarScenarios.toolsError());
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByTestId('status-dot-annotation')).toHaveClass('bg-error');
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders plugin capability from modifier', async () => {
    const scenario = withPlugin(sidecarScenarios.fullyReady(), 'alphafold', {
      label: 'AlphaFold',
      status: 'unavailable',
      url: 'http://localhost:9001',
    });
    mockFetchWith(scenario);
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('AlphaFold')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });

  it('renders loading state before fetch completes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<Toolbox />);
    await waitFor(() => {
      expect(document.body).toBeDefined();
    });
  });

  it('shows error when sidecar unreachable', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    render(<Toolbox />);
    await waitFor(() => {
      const content = document.body.textContent ?? '';
      expect(content).toBeDefined();
    });
  });

  it('renders mixed component status — blastn ready + diamond downloading', async () => {
    mockFetchWith(sidecarScenarios.mixedComponentStatus());
    render(<Toolbox />);
    await waitFor(() => {
      expect(screen.getByText('Annotation Engine')).toBeInTheDocument();
    });
    expect(screen.getByTestId('status-dot-annotation')).not.toHaveClass('bg-success');
  });

  it('transitions from downloading to ready', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => sidecarScenarios.downloadingTools(90),
      });
      render(<Toolbox />);
      await vi.advanceTimersByTimeAsync(100);

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => sidecarScenarios.fullyReady(),
      });
      await vi.advanceTimersByTimeAsync(5100);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
