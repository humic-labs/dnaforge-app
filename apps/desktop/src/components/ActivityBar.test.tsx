import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityBar } from './ActivityBar';
import { COMMAND_IDS } from '../commands';

const analyticsMocks = vi.hoisted(() => ({
  trackToolOpened: vi.fn(),
  dispatchCommand: vi.fn(),
}));

vi.mock('../commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands')>()),
  useCommandRegistry: () => ({ dispatchCommand: analyticsMocks.dispatchCommand }),
}));

vi.mock('../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/analytics')>()),
  ...analyticsMocks,
}));

function renderActivityBar(
  props: Partial<Parameters<typeof ActivityBar>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <ActivityBar
      activeView="files"
      sidebarVisible
      referenceLibraryActive={false}
      onViewChange={vi.fn()}
      onToggleSidebar={vi.fn()}
      toolboxBadge={null}
      {...props}
    />
  );
}

describe('ActivityBar dev surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the AI activity through the existing chat entry command', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });
    fireEvent.click(screen.getByTestId('ai-tools-button'));
    expect(analyticsMocks.dispatchCommand).toHaveBeenCalledWith(COMMAND_IDS.appFocusCommandInput, {
      source: 'ui',
    });
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it('toggles the selected AI sidebar and reopens it through its entry command', () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = renderActivityBar({ activeView: 'ai', onToggleSidebar });
    fireEvent.click(screen.getByTestId('ai-tools-button'));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.dispatchCommand).not.toHaveBeenCalled();
    rerender(
      <ActivityBar
        activeView="ai"
        sidebarVisible={false}
        referenceLibraryActive={false}
        onViewChange={vi.fn()}
        onToggleSidebar={onToggleSidebar}
      />
    );
    fireEvent.click(screen.getByTestId('ai-tools-button'));
    expect(analyticsMocks.dispatchCommand).toHaveBeenCalledWith(COMMAND_IDS.appFocusCommandInput, {
      source: 'ui',
    });
  });

  it('keeps settings as the only management entry in the bottom rail', () => {
    renderActivityBar();

    expect(screen.queryByTestId('svg-gallery-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dev-scenarios-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agents-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-preview-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-button')).toBeInTheDocument();
    expect(screen.getByTestId('settings-button')).toHaveAttribute(
      'data-ph-capture-attribute-action',
      'navigate'
    );
    expect(screen.getByTestId('settings-button')).toHaveAttribute(
      'data-ph-capture-attribute-surface',
      'header'
    );
  });

  it('shows the Source Control icon in development builds', () => {
    renderActivityBar();
    expect(screen.getByTestId('source-control-button')).toBeInTheDocument();
  });

  it('shows the Source Control icon in the shipped desktop build', () => {
    vi.stubEnv('DEV', false);
    try {
      renderActivityBar();
      expect(screen.getByTestId('source-control-button')).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the LIMS icon visible in the shipped (production) build', () => {
    vi.stubEnv('DEV', false);
    try {
      renderActivityBar();
      expect(screen.getByTestId('lims-button')).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows the Toolbox (environment) icon in development builds', () => {
    renderActivityBar({ toolboxBadge: 'downloading' });
    expect(screen.getByTestId('toolbox-button')).toBeInTheDocument();
  });

  it('hides the Toolbox (environment) icon from the shipped (production) build', () => {
    vi.stubEnv('DEV', false);
    try {
      renderActivityBar({ toolboxBadge: 'downloading' });
      expect(screen.queryByTestId('toolbox-button')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('renders dev actions only when the caller provides the slot', () => {
    renderActivityBar({ devActions: <button data-testid="dev-action-slot">Dev Action</button> });

    expect(screen.getByTestId('dev-action-slot')).toBeInTheDocument();
  });

  it('keeps settings as the assistant management entry point', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });

    fireEvent.click(screen.getByTestId('settings-button'));

    expect(onViewChange).toHaveBeenCalledWith('settings');
    expect(analyticsMocks.trackToolOpened).toHaveBeenCalledWith('settings', 'sidebar');
  });

  it('keeps the settings activity highlighted even when no sidebar is visible', () => {
    const onViewChange = vi.fn();
    const onToggleSidebar = vi.fn();
    renderActivityBar({
      activeView: 'settings',
      sidebarVisible: false,
      onViewChange,
      onToggleSidebar,
    });

    expect(screen.getByTestId('settings-button')).toHaveClass('text-accent');
    fireEvent.click(screen.getByTestId('settings-button'));

    expect(onViewChange).toHaveBeenCalledWith('settings');
    expect(onToggleSidebar).not.toHaveBeenCalled();
    expect(analyticsMocks.trackToolOpened).not.toHaveBeenCalled();
  });

  it('tracks LIMS when the sidebar button opens the LIMS surface', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });

    fireEvent.click(screen.getByTestId('lims-button'));

    expect(onViewChange).toHaveBeenCalledWith('lims');
    expect(analyticsMocks.trackToolOpened).toHaveBeenCalledWith('lims', 'sidebar');
  });

  it('does not track LIMS when clicking the active visible LIMS button closes it', () => {
    const onToggleSidebar = vi.fn();
    renderActivityBar({ activeView: 'lims', sidebarVisible: true, onToggleSidebar });

    fireEvent.click(screen.getByTestId('lims-button'));

    expect(onToggleSidebar).toHaveBeenCalled();
    expect(analyticsMocks.trackToolOpened).not.toHaveBeenCalled();
  });

  it('offers New Terminal Tab as a creation action alongside the current tool', () => {
    const onNewTerminalTab = vi.fn();
    const onViewChange = vi.fn();
    renderActivityBar({ onNewTerminalTab, onViewChange });
    const newTab = screen.getByRole('button', { name: 'New Terminal Tab' });
    fireEvent.click(newTab);
    expect(onNewTerminalTab).toHaveBeenCalledOnce();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(newTab).not.toHaveClass('text-accent');
    expect(screen.getByTestId('files-button')).toHaveClass('text-accent');
  });

  it('renders a Home button ahead of Explorer', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });

    const homeButton = screen.getByTestId('home-button');
    expect(homeButton).toBeInTheDocument();
    expect(
      homeButton.compareDocumentPosition(screen.getByTestId('files-button')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(homeButton);
    expect(onViewChange).toHaveBeenCalledWith('home');
  });

  it('opens the reference genome library from the left activity rail', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });

    const referenceButton = screen.getByTestId('reference-picker-open');
    expect(referenceButton).toHaveAttribute('title', 'Reference genomes');
    fireEvent.click(referenceButton);

    expect(onViewChange).toHaveBeenCalledWith('references');
  });

  it('lets navigation buttons supply the color of their tool icons', () => {
    renderActivityBar();

    const genomeIcon = screen.getByTestId('reference-picker-open').querySelector('svg');
    expect(genomeIcon).toHaveAttribute('data-icon', 'genome-assembly');
    expect(genomeIcon).toHaveAttribute('fill', 'currentColor');
    expect(
      screen.getByTestId('activity-bar').querySelector('button svg[data-entity-color-family]')
    ).toBeNull();
  });

  it('focuses the permanent full-screen References tool when its dedicated opener is supplied', () => {
    const onViewChange = vi.fn();
    const onToggleSidebar = vi.fn();
    const onOpenReferenceGenome = vi.fn();
    renderActivityBar({
      activeView: 'references',
      sidebarVisible: false,
      referenceLibraryActive: true,
      onViewChange,
      onToggleSidebar,
      onOpenReferenceGenome,
    });

    expect(screen.getByTestId('reference-picker-open')).toHaveClass('text-accent');
    fireEvent.click(screen.getByTestId('reference-picker-open'));

    expect(onOpenReferenceGenome).toHaveBeenCalledOnce();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });

  it('does not highlight any sidebar tool after a reference opens from the library', () => {
    renderActivityBar({
      activeView: 'references',
      sidebarVisible: false,
      referenceLibraryActive: false,
    });

    expect(screen.getByTestId('reference-picker-open')).not.toHaveClass('text-accent');
    expect(screen.getByTestId('files-button')).not.toHaveClass('text-accent');
  });

  it('keeps Home highlighted even when no sidebar is visible, and does not toggle the sidebar on re-click', () => {
    const onViewChange = vi.fn();
    const onToggleSidebar = vi.fn();
    renderActivityBar({
      activeView: 'home',
      sidebarVisible: false,
      onViewChange,
      onToggleSidebar,
    });

    expect(screen.getByTestId('home-button')).toHaveClass('text-accent');
    fireEvent.click(screen.getByTestId('home-button'));

    expect(onViewChange).toHaveBeenCalledWith('home');
    expect(onToggleSidebar).not.toHaveBeenCalled();
    expect(analyticsMocks.trackToolOpened).not.toHaveBeenCalled();
  });

  it('positions Home strictly first among every activity bar button', () => {
    renderActivityBar();

    const buttons = screen.getByTestId('activity-bar').querySelectorAll('button');
    expect(buttons[0]).toBe(screen.getByTestId('home-button'));
  });

  it('never tracks analytics when navigating to Home', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });

    fireEvent.click(screen.getByTestId('home-button'));

    expect(onViewChange).toHaveBeenCalledWith('home');
    expect(analyticsMocks.trackToolOpened).not.toHaveBeenCalled();
  });

  it('routes Home to Settings through onViewChange, never onToggleSidebar', () => {
    const onViewChange = vi.fn();
    const onToggleSidebar = vi.fn();
    renderActivityBar({
      activeView: 'home',
      sidebarVisible: false,
      onViewChange,
      onToggleSidebar,
    });

    fireEvent.click(screen.getByTestId('settings-button'));

    expect(onViewChange).toHaveBeenCalledWith('settings');
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });

  it('opens Jobs in the existing sidebar', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });
    fireEvent.click(screen.getByTestId('jobs-button'));

    expect(onViewChange).toHaveBeenCalledWith('jobs');
  });

  it('shows current active jobs and a separate accessible attention indication', () => {
    renderActivityBar({ jobsActiveCount: 3, jobsAttentionCount: 2 });

    const button = screen.getByTestId('jobs-button');
    expect(button).toHaveAccessibleName('Jobs, 3 active, 2 need attention');
    expect(within(button).getByText('3')).toHaveAttribute('aria-hidden', 'true');
    expect(within(button).getByTestId('jobs-attention')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps job badge updates passive while another view is selected', () => {
    const onViewChange = vi.fn();
    const documentButton = document.createElement('button');
    document.body.appendChild(documentButton);
    documentButton.focus();
    const { rerender } = renderActivityBar({ onViewChange, activeView: 'files' });

    rerender(
      <ActivityBar
        activeView="files"
        sidebarVisible
        referenceLibraryActive={false}
        onViewChange={onViewChange}
        onToggleSidebar={vi.fn()}
        jobsActiveCount={1}
        jobsAttentionCount={1}
      />
    );

    expect(screen.getByTestId('files-button')).toHaveClass('text-accent');
    expect(screen.getByTestId('jobs-button')).not.toHaveClass('text-accent');
    expect(onViewChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(documentButton);
    documentButton.remove();
  });
});

describe('ActivityBar registered feature buttons', () => {
  it('renders the remote hosts button from the renderer feature list and opens its view', () => {
    const onViewChange = vi.fn();
    renderActivityBar({ onViewChange });
    const button = screen.getByTestId('remote-hosts-button');
    expect(button).toHaveAttribute('aria-label', 'Remote hosts');
    fireEvent.click(button);
    expect(onViewChange).toHaveBeenCalledWith('remote-hosts');
  });
});
