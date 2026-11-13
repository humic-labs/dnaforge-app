import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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

describe('Toolbox — disclosure button', () => {
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

  it('toggles expanded state and aria-expanded on each click', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
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

    const collapsedButton = await screen.findByRole('button', {
      name: /show annotation engine details/i,
    });
    expect(collapsedButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('BLAST+')).not.toBeInTheDocument();

    fireEvent.click(collapsedButton);
    const expandedButton = await screen.findByRole('button', {
      name: /hide annotation engine details/i,
    });
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('BLAST+')).toBeInTheDocument();

    fireEvent.click(expandedButton);
    const recollapsedButton = await screen.findByRole('button', {
      name: /show annotation engine details/i,
    });
    expect(recollapsedButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('BLAST+')).not.toBeInTheDocument();
  });

  it('disables the disclosure button for capabilities with no components', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'no-details',
          label: 'No Details Capability',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-no-details');
    const button = within(row).getByRole('button', { name: /show no details capability details/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ToolboxSummary — badge aggregation', () => {
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

  it('aggregates ready / updating / attention / offline counts across mixed states', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'ready-1',
          label: 'Ready One',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
        {
          id: 'ready-2',
          label: 'Ready Two',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
        {
          id: 'downloading-1',
          label: 'Updating One',
          status: 'downloading',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
        {
          id: 'error-1',
          label: 'Error One',
          status: 'error',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
        {
          id: 'unavailable-1',
          label: 'Unavailable One',
          status: 'unavailable',
          tier: 'optional',
          source: 'plugin',
          auto_install: false,
          components: [],
        },
        {
          id: 'unavailable-2',
          label: 'Unavailable Two',
          status: 'unavailable',
          tier: 'optional',
          source: 'plugin',
          auto_install: false,
          components: [],
        },
      ])
    );
    render(<Toolbox />);

    const summary = await screen.findByTestId('toolbox-summary');

    expect(within(summary).getByText('2/6')).toBeInTheDocument();
    expect(within(summary).getByText('ready')).toBeInTheDocument();

    expect(within(summary).getByText('updating')).toBeInTheDocument();
    expect(within(summary).getByText('attention')).toBeInTheDocument();
    expect(within(summary).getByText('offline')).toBeInTheDocument();

    const onesInSummary = within(summary).getAllByText('1');
    expect(onesInSummary.length).toBeGreaterThanOrEqual(2);
    expect(within(summary).getByText('2')).toBeInTheDocument();
  });

  it('omits zero-count badges and shows 0/total when no capabilities are ready', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'downloading-only',
          label: 'Downloading Only',
          status: 'downloading',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [],
        },
      ])
    );
    render(<Toolbox />);

    const summary = await screen.findByTestId('toolbox-summary');

    expect(within(summary).getByText('0/1')).toBeInTheDocument();
    expect(within(summary).getByText('ready')).toBeInTheDocument();
    expect(within(summary).getByText('updating')).toBeInTheDocument();

    expect(within(summary).queryByText('attention')).not.toBeInTheDocument();
    expect(within(summary).queryByText('offline')).not.toBeInTheDocument();
  });

  it('shows 0/0 ready badge when there are no capabilities at all', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockToolboxResponse([]));
    render(<Toolbox />);

    const summary = await screen.findByTestId('toolbox-summary');
    expect(within(summary).getByText('0/0')).toBeInTheDocument();
    expect(within(summary).getByText('ready')).toBeInTheDocument();
    expect(within(summary).queryByText('updating')).not.toBeInTheDocument();
    expect(within(summary).queryByText('attention')).not.toBeInTheDocument();
    expect(within(summary).queryByText('offline')).not.toBeInTheDocument();
  });
});

describe('CapabilityProgress — render states', () => {
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

  it('renders nothing for a capability with no components carrying progress (idle)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'idle',
          label: 'Idle Capability',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'idle-comp',
              label: 'Idle Component',
              status: 'ready',
              source: 'downloaded',
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-idle');
    expect(within(row).queryByText(/%$/)).not.toBeInTheDocument();
  });

  it('renders a progress bar with percent + detail for a partially-downloading component', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'partial',
          label: 'Partial Capability',
          status: 'downloading',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'partial-comp',
              label: 'Partial Component',
              status: 'downloading',
              source: 'downloaded',
              progress: { phase: 'downloading', percent: 42, detail: 'Downloading NT database' },
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-partial');
    expect(within(row).getByText('42%')).toBeInTheDocument();
    expect(within(row).getByText('Partial Component: Downloading')).toBeInTheDocument();
  });

  it('clamps out-of-range percent values into 0-100 for the progress display', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'overflow',
          label: 'Overflow Capability',
          status: 'downloading',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'too-high',
              label: 'Too High',
              status: 'downloading',
              source: 'downloaded',
              progress: { phase: 'downloading', percent: 175, detail: 'Way too high' },
            },
            {
              id: 'too-low',
              label: 'Too Low',
              status: 'downloading',
              source: 'downloaded',
              progress: { phase: 'downloading', percent: -10, detail: 'Way too low' },
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-overflow');
    expect(within(row).getByText('100%')).toBeInTheDocument();
    expect(within(row).getByText('0%')).toBeInTheDocument();
  });

  it('falls back to "<label> <phase>" when progress.detail is empty', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'no-detail',
          label: 'No Detail Capability',
          status: 'downloading',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'no-detail-comp',
              label: 'Database Bundle',
              status: 'downloading',
              source: 'downloaded',
              progress: { phase: 'extracting_archive', percent: 65, detail: '' },
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-no-detail');
    expect(within(row).getByText('Database Bundle: Extracting archive')).toBeInTheDocument();
    expect(within(row).getByText('65%')).toBeInTheDocument();
  });

  it('renders nothing for a fully-complete capability (all components ready, no progress payloads)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockToolboxResponse([
        {
          id: 'complete',
          label: 'Complete Capability',
          status: 'ready',
          tier: 'base',
          source: 'builtin',
          auto_install: true,
          components: [
            {
              id: 'comp-a',
              label: 'Comp A',
              status: 'ready',
              source: 'downloaded',
              version: '1.0.0',
            },
            {
              id: 'comp-b',
              label: 'Comp B',
              status: 'ready',
              source: 'downloaded',
              version: '2.0.0',
            },
          ],
        },
      ])
    );
    render(<Toolbox />);

    const row = await screen.findByTestId('capability-row-complete');
    expect(within(row).queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(within(row).getByText('2/2 tools ready')).toBeInTheDocument();
  });
});
