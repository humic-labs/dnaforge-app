import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExplorerWorkspaceSurface } from './ExplorerWorkspaceSurface';

describe('ExplorerWorkspaceSurface ', () => {
  it('marks the parked explorer inert while empty Files shows Home, and not once tabs exist', () => {
    const { rerender } = render(
      <ExplorerWorkspaceSurface takeoverActive={false} emptyFilesHomeActive explorerInset={0}>
        <div>canvas</div>
      </ExplorerWorkspaceSurface>
    );
    const surface = screen.getByTestId('explorer-workspace-surface');
    expect(surface).toHaveAttribute('aria-hidden', 'true');
    expect(surface).toHaveAttribute('inert');

    rerender(
      <ExplorerWorkspaceSurface
        takeoverActive={false}
        emptyFilesHomeActive={false}
        explorerInset={0}
      >
        <div>canvas</div>
      </ExplorerWorkspaceSurface>
    );
    expect(surface).toHaveAttribute('aria-hidden', 'false');
    expect(surface).not.toHaveAttribute('inert');
  });
});
