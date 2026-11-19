import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ActivityBar, type ActivityView } from '../../components/ActivityBar';
import { useWorkspaceMainMode } from '../../hooks/useWorkspaceMainMode';

vi.mock('../../feature-registry', () => ({
  rendererFeatureActivityButtons: () => [],
  rendererFeatureViewIds: () => [],
  isRendererFeatureView: () => false,
}));
vi.mock('../canvas', () => ({
  useCanvasStore: (selector: (state: { panels: object }) => unknown) => selector({ panels: {} }),
}));

it('marks Terminal as the active left navigation destination', () => {
  render(
    <ActivityBar
      activeView={'terminal' as ActivityView}
      sidebarVisible
      referenceLibraryActive={false}
      onViewChange={vi.fn()}
      onToggleSidebar={vi.fn()}
      onOpenTerminal={vi.fn()}
    />
  );
  expect(screen.getByTestId('terminal-toggle')).toHaveClass('text-accent');
});

it('keeps document tabs visible alongside the terminal list and shell', () => {
  function Layout() {
    const mode = useWorkspaceMainMode('terminal' as ActivityView, true);
    return <output>{JSON.stringify(mode)}</output>;
  }
  render(<Layout />);
  const mode = JSON.parse(screen.getByRole('status').textContent!);
  expect(mode.workspaceTakeoverActive).toBe(false);
  expect(mode.terminalViewActive).toBe(true);
  expect(mode.sidebarChromeVisible).toBe(false);
});
